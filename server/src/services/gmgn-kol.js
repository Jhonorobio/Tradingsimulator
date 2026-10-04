import initCycleTLS from 'cycletls';

// GMGN's token_holder_stat endpoint (same domain as gmgn-mentions) returns
// data.renowned_count. Cloudflare 403s plain fetch (Node/OpenSSL JA3), so we
// use the CycleTLS chrome131 fingerprint that gmgn-mentions proved in prod.
// This module is the FALLBACK path of pulse-kol.js (Pulse first, GMGN here).
const STAT_URL = 'https://gmgn.ai/vas/api/v1/token_holder_stat/sol';

// Serialise calls so bursts from the per-push evaluation can't stampede GMGN.
// Tune with GMGN_KOL_MIN_INTERVAL_MS (0 = no pacing).
const rawPacing = process.env.GMGN_KOL_MIN_INTERVAL_MS;
const MIN_INTERVAL_MS = rawPacing != null && rawPacing !== ''
  ? Math.max(0, Number(rawPacing) || 0)
  : 200;
// 403/429 → stop calling for 60s (same safety net as gmgn-mentions).
const BACKOFF_MS = 60_000;
// Fresh results stay usable for 10 min (only read between Pulse retries).
const CACHE_TTL_MS = 10 * 60_000;
// Failed attempts are remembered for 60s so a down API isn't hammered.
const ERROR_TTL_MS = 60_000;
// CycleTLS can wedge on a request; never let a caller wait forever.
const FETCH_TIMEOUT_MS = 15_000;

const cache = new Map(); // mint -> { count: number|null, savedAt }
const inflight = new Map(); // mint -> Promise<number|null>
let nextSlot = 0;
let backoffUntil = 0;
let paceChain = Promise.resolve();
let cycleTLS = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function getCycleTLS() {
  if (!cycleTLS) cycleTLS = await initCycleTLS();
  return cycleTLS;
}

function httpError(httpCode, bodyHead) {
  const err = new Error(`HTTP_${httpCode}`);
  err.httpCode = httpCode;
  err.bodyHead = String(bodyHead || '').slice(0, 160);
  return err;
}

/**
 * One call with a Chrome131 TLS fingerprint.
 * @returns {Promise<number>} data.renowned_count
 */
async function fetchRenownedCount(mint) {
  const client = await getCycleTLS();
  const resp = await client(`${STAT_URL}/${mint}`, {
    client: 'chrome131',
    headers: { Accept: 'application/json', 'Accept-Language': 'es-419,es;q=0.9' },
  }, 'GET');
  const httpCode = Number(resp.status) || 0;
  if (httpCode !== 200) {
    throw httpError(httpCode, typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data));
  }
  // CycleTLS returns `data` already parsed when the body is JSON.
  let json = resp.data;
  if (typeof json === 'string') {
    try {
      json = JSON.parse(json);
    } catch {
      throw httpError(httpCode, json);
    }
  }
  const count = Number(json?.data?.renowned_count);
  if (!Number.isFinite(count)) throw httpError(httpCode, JSON.stringify(json));
  return count;
}

/** Waits until this call's pacing slot so bursts stay serialised. */
function paced() {
  const run = paceChain.then(async () => {
    const wait = nextSlot - Date.now();
    if (wait > 0) await sleep(wait);
    nextSlot = Date.now() + MIN_INTERVAL_MS;
  });
  paceChain = run.catch(() => {});
  return run;
}

/**
 * Promise-based lookup: cached value → in-flight request → paced fetch.
 * Resolves with the count, or null when the call failed (failures are
 * memoized for ERROR_TTL_MS so a downed API isn't hammered).
 * @param {string} mint
 * @returns {Promise<number|null>}
 */
export function getRenownedCount(mint) {
  if (!mint) return Promise.resolve(null);
  const hit = cache.get(mint);
  if (hit) {
    const ttl = hit.count == null ? ERROR_TTL_MS : CACHE_TTL_MS;
    if (Date.now() - hit.savedAt <= ttl) return Promise.resolve(hit.count);
  }
  const running = inflight.get(mint);
  if (running) return running;
  if (Date.now() < backoffUntil) return Promise.resolve(null);
  const p = (async () => {
    try {
      await paced();
      if (Date.now() < backoffUntil) return null;
      const count = await withTimeout(fetchRenownedCount(mint), FETCH_TIMEOUT_MS);
      cache.set(mint, { count, savedAt: Date.now() });
      console.log(`[gmgn-kol] ${mint.slice(0, 8)}... renowned_count=${count}`);
      return count;
    } catch (err) {
      cache.set(mint, { count: null, savedAt: Date.now() });
      if (err.httpCode === 403 || err.httpCode === 429) backoffUntil = Date.now() + BACKOFF_MS;
      console.error(`[gmgn-kol] ${mint.slice(0, 8)}... ${err.message}${err.bodyHead ? `: ${err.bodyHead}` : ''}`);
      return null;
    } finally {
      inflight.delete(mint);
    }
  })();
  inflight.set(mint, p);
  return p;
}
