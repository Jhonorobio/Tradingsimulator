import initCycleTLS from 'cycletls';

// Cloudflare blocks Node/OpenSSL TLS fingerprints (JA3) on gmgn.ai internal
// endpoints (plain fetch -> 403). CycleTLS with a Chrome131 ClientHello
// replicates the browser fingerprint and returns 200 (verified locally;
// curl/Schannel also worked on Windows but curl/OpenSSL is blocked on Linux).
const MENTIONS_URL = 'https://gmgn.ai/vas/api/v1/twitter/token/search';

// Client-side pacing: 1 request/s globally (extension uses 10s + 900ms stagger
// per mint; we round-robin through mints instead).
const MIN_INTERVAL_MS = 1_000;
// Backoff after a 403/429 (same as the extension's 60s).
const BACKOFF_MS = 60_000;
// Mentions change slowly — 60s cache is plenty for the UI.
const CACHE_TTL_MS = 60_000;

const cache = new Map(); // mint -> { data, savedAt }
let queue = [];
let pumping = false;
let nextSlot = 0;
let backoffUntil = 0;
let cycleTLS = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function mentionsUrl(mint, limit) {
  return `${MENTIONS_URL}?keyword=${encodeURIComponent(mint)}&limit=${encodeURIComponent(limit)}`;
}

async function getCycleTLS() {
  if (!cycleTLS) cycleTLS = await initCycleTLS();
  return cycleTLS;
}

/** Stops the CycleTLS daemon (call on server shutdown). */
export async function closeMentions() {
  if (cycleTLS) {
    const c = cycleTLS;
    cycleTLS = null;
    try { await c.exit(); } catch { /* already gone */ }
  }
}

function httpError(httpCode, bodyHead) {
  const err = new Error(`HTTP_${httpCode}`);
  err.httpCode = httpCode;
  err.bodyHead = String(bodyHead || '').slice(0, 160);
  return err;
}

/**
 * One call to GMGN's internal Twitter-mentions endpoint with a Chrome131
 * TLS fingerprint.
 * @returns {Promise<{httpCode: number, items: Array}>}
 */
async function fetchMentions(mint, limit) {
  const client = await getCycleTLS();
  const resp = await client(mentionsUrl(mint, limit), {
    client: 'chrome131',
    headers: { Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9' },
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
  if (!json || typeof json !== 'object') throw httpError(httpCode, JSON.stringify(json));
  return { httpCode, items: Array.isArray(json?.data) ? json.data : [] };
}

/**
 * Diagnostic-only fetch: bypasses queue, cache and backoff, and reports the
 * raw HTTP status + body head + timing.
 * @param {string} mint
 * @param {{limit?: number}} opts
 */
export async function rawMentions(mint, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 10, 1), 50);
  const start = Date.now();
  try {
    const { httpCode, items } = await fetchMentions(mint, limit);
    return { ok: true, httpCode, items: items.length, elapsedMs: Date.now() - start, bodyHead: null };
  } catch (err) {
    return {
      ok: false,
      httpCode: err.httpCode ?? null,
      items: 0,
      elapsedMs: Date.now() - start,
      bodyHead: err.bodyHead || err.message,
    };
  }
}

// Serialized pump: runs queued fetches respecting MIN_INTERVAL_MS and backoff.
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      if (Date.now() < backoffUntil) {
        const wait = backoffUntil - Date.now();
        queue.splice(0, queue.length).forEach((t) => t.reject(new Error('BACKOFF')));
        await sleep(wait);
        continue;
      }
      const wait = nextSlot - Date.now();
      if (wait > 0) await sleep(wait);
      const task = queue.shift();
      nextSlot = Date.now() + MIN_INTERVAL_MS;
      try {
        const result = await fetchMentions(task.mint, task.limit);
        task.resolve(result);
      } catch (err) {
        task.reject(err);
      }
    }
  } finally {
    pumping = false;
  }
}

function enqueue(mint, limit) {
  return new Promise((resolve, reject) => {
    queue.push({ mint, limit, resolve, reject });
    pump();
  });
}

/**
 * Fetches X/Twitter mentions for a token from GMGN (internal endpoint,
 * CycleTLS Chrome fingerprint). Cached for CACHE_TTL_MS; calls are serialized
 * at 1 req/s; 403/429 triggers a 60s backoff for all callers.
 *
 * @param {string} mint - token contract address
 * @param {{limit?: number, force?: boolean}} [opts]
 * @returns {Promise<{items: Array, cached: boolean, error?: string}>}
 */
export async function getMentions(mint, opts = {}) {
  if (!mint) return { items: [], cached: false, error: 'NO_MINT' };
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 50);

  if (!opts.force) {
    const hit = cache.get(mint);
    if (hit && Date.now() - hit.savedAt < CACHE_TTL_MS) {
      return { items: hit.data, cached: true };
    }
  }

  if (Date.now() < backoffUntil) {
    const hit = cache.get(mint);
    return { items: hit?.data || [], cached: Boolean(hit), error: 'BACKOFF' };
  }

  try {
    const { items } = await enqueue(mint, limit);
    cache.set(mint, { data: items, savedAt: Date.now() });
    return { items, cached: false };
  } catch (err) {
    if (err.httpCode === 403 || err.httpCode === 429 ||
        /timed? ?out/i.test(err.message || '')) {
      backoffUntil = Date.now() + BACKOFF_MS;
    }
    const hit = cache.get(mint);
    return { items: hit?.data || [], cached: Boolean(hit), error: err.message };
  }
}

/** Current pacing/backoff state (for the debug endpoint). */
export function getMentionsStatus() {
  return {
    queueLength: queue.length,
    backoffRemainingMs: Math.max(0, backoffUntil - Date.now()),
    cached: cache.size,
    method: 'cycletls(chrome131)',
  };
}
