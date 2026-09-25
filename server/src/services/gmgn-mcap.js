import initCycleTLS from 'cycletls';

// Live market cap from GMGN's internal candles endpoint (same one the web
// chart uses). Plain Node fetch gets 403 (Cloudflare JA3) — CycleTLS with a
// Chrome131 ClientHello returns 200 (same as gmgn-mentions).
const BASE_URL = 'https://gmgn.ai/api/v1/token_mcap_candles/sol';
// Telemetry params copied from the browser capture; values are just echoed
// back by GMGN (device ids / app build), they do not need to be real.
const TELEMETRY_PARAMS =
  'device_id=45d79a65-5b4e-4d82-a0cf-dfb040754aa2' +
  '&tab_id=muheutnpuh54' +
  '&fp_did=be0259deabc5c063263d586f837a88ff' +
  '&client_id=gmgn_web_20260924-4915-3a6fdc1' +
  '&from_app=gmgn' +
  '&app_ver=20260924-4915-3a6fdc1' +
  '&tz_name=America_Bogota' +
  '&tz_offset=-18000' +
  '&app_lang=en-US' +
  '&os=web' +
  '&worker=0';

const HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://gmgn.ai/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

// Readers (badge, portfolio, position card) ONLY read the cache — a single
// background poller refreshes every mint people are looking at. This keeps
// upstream traffic at ~2.5 req/s no matter how many screens poll at 0.5s,
// which is what avoids GMGN's 403/429 backoff.
const TICK_MS = 400;              // poller cadence (global)
const MIN_INTERVAL_MS = 300;      // min gap between any two upstream calls
const READER_STALE_MS = 5_000;    // direct fetch only if cache older than this
const READER_IDLE_MS = 15_000;    // stop refreshing mints nobody looked at
const BACKOFF_MS = 60_000;
// Never let a hung upstream call block a direct fetch (polled every 500ms).
const FETCH_TIMEOUT_MS = 8_000;

const cache = new Map(); // mint -> { data: {marketCap,time}, savedAt }
const active = new Map(); // mint -> lastReadAt (readers we should refresh)
const lastFetched = new Map(); // mint -> ts of last upstream attempt
const inflight = new Map(); // mint -> Promise (coalesced direct fetches)
let poller = null;
let lastFetchAt = 0;
let backoffUntil = 0;
let cycleTLS = null;
let fetchCount = 0;
let errorCount = 0;
let lastError = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getCycleTLS() {
  if (!cycleTLS) cycleTLS = await initCycleTLS();
  return cycleTLS;
}

/** Stops the CycleTLS daemon (call on server shutdown). */
export async function closeMcap() {
  stopPoller();
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

function candlesUrl(mint, resolution) {
  const to = Date.now();
  return (
    `${BASE_URL}/${encodeURIComponent(mint)}?${TELEMETRY_PARAMS}` +
    `&resolution=${encodeURIComponent(resolution)}&from=0&to=${to}&limit=1000&pool_type=tpool`
  );
}

/**
 * One upstream call. The current (in-progress) candle's `close` is the live
 * market cap in USD — it moves as trades print inside the same 15s window.
 */
async function fetchLiveCandle(mint, resolution) {
  const wait = lastFetchAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastFetchAt = Date.now();
  fetchCount += 1;

  const request = requestLiveCandle(mint, resolution);
  let timer;
  try {
    return await Promise.race([
      request,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMEOUT_${FETCH_TIMEOUT_MS}MS`)), FETCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    request.catch(() => {});
  }
}

async function requestLiveCandle(mint, resolution) {
  const client = await getCycleTLS();
  const url = candlesUrl(mint, resolution);
  const resp = await client(url, {
    client: 'chrome131',
    headers: HEADERS,
  }, 'GET');
  const httpCode = Number(resp.status) || 0;
  if (httpCode !== 200) {
    throw httpError(httpCode, typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data));
  }
  let json = resp.data;
  if (typeof json === 'string') {
    try { json = JSON.parse(json); } catch { throw httpError(httpCode, json); }
  }
  if (!json || typeof json !== 'object') throw httpError(httpCode, JSON.stringify(json));
  if (json.code !== 0) {
    const err = new Error(`GMGN_${json.code}_${json.message || json.reason || 'error'}`);
    err.gmgn = true;
    throw err;
  }
  const list = json?.data?.list;
  const last = Array.isArray(list) && list.length ? list[list.length - 1] : null;
  if (!last) return { marketCap: null, time: null };
  const marketCap = Number(last.close);
  return {
    marketCap: Number.isFinite(marketCap) ? marketCap : null,
    time: Number(last.time) || null,
  };
}

function onFetchError(err) {
  errorCount += 1;
  lastError = {
    message: String(err?.message || err),
    httpCode: err?.httpCode ?? null,
    gmgn: Boolean(err?.gmgn),
    at: Date.now(),
  };
  if (err.httpCode === 403 || err.httpCode === 429) {
    backoffUntil = Date.now() + BACKOFF_MS;
  }
}

/** Coalesced direct fetch: one in-flight upstream call per mint. */
function directFetch(mint, resolution) {
  let pending = inflight.get(mint);
  if (pending) return pending;
  pending = fetchLiveCandle(mint, resolution)
    .then((data) => {
      cache.set(mint, { data, savedAt: Date.now() });
      lastFetched.set(mint, Date.now());
      return { ...data, cached: false };
    })
    .catch((err) => {
      onFetchError(err);
      const hit = cache.get(mint);
      return {
        marketCap: hit?.data.marketCap ?? null,
        time: hit?.data.time ?? null,
        cached: Boolean(hit),
        error: err.message,
      };
    })
    .finally(() => inflight.delete(mint));
  inflight.set(mint, pending);
  return pending;
}

// ─── Background poller ───────────────────────────────────────────────────
// Round-robin: every TICK_MS refresh the least-recently-fetched mint that
// somebody is still looking at. Global cadence stays at ~2.5 req/s.
function startPoller() {
  if (poller) return;
  poller = setInterval(pollTick, TICK_MS);
}

function stopPoller() {
  if (poller) {
    clearInterval(poller);
    poller = null;
  }
}

function pollTick() {
  try {
    const now = Date.now();
    for (const [mint, readAt] of active) {
      if (now - readAt > READER_IDLE_MS) {
        active.delete(mint);
        lastFetched.delete(mint);
      }
    }
    if (!active.size) {
      stopPoller();
      return;
    }
    if (now < backoffUntil) return;
    if (now - lastFetchAt < MIN_INTERVAL_MS) return;

    let pick = null;
    let oldest = Infinity;
    for (const mint of active.keys()) {
      const at = lastFetched.get(mint) ?? 0;
      if (at < oldest) {
        oldest = at;
        pick = mint;
      }
    }
    if (!pick) return;
    // Coalesce with any in-flight fetch: GMGN rejects overlapping requests
    // for the same mint with `invalid token_address`.
    if (inflight.has(pick)) return;
    lastFetched.set(pick, now);
    directFetch(pick, '15s').catch(() => {}); // never throws; handles errors/cache
  } catch {
    /* the timer must never crash */
  }
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Live market cap (USD) for a SOL token, from GMGN's internal candles
 * endpoint via CycleTLS. Reads are served from the cache (updated by the
 * background poller every ~400ms); a direct fetch happens only when nothing
 * fresh exists yet or the cache went very stale (poller stopped/backoff).
 *
 * @param {string} mint - token contract address
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<{marketCap: number|null, time: number|null, cached: boolean, error?: string}>}
 *   Never throws: on upstream failure it returns the last cached value (if
 *   any) plus `error`.
 */
export async function getLiveMcap(mint, opts = {}) {
  if (!mint) return { marketCap: null, time: null, cached: false, error: 'NO_MINT' };
  const now = Date.now();
  active.set(mint, now); // keep this mint on the poller's round-robin
  startPoller();

  const hit = cache.get(mint);
  const age = hit ? now - hit.savedAt : Infinity;
  if (!opts.force && hit && age < READER_STALE_MS) {
    return { ...hit.data, cached: true };
  }
  if (!opts.force && now < backoffUntil) {
    return {
      marketCap: hit?.data.marketCap ?? null,
      time: hit?.data.time ?? null,
      cached: Boolean(hit),
      error: 'BACKOFF',
    };
  }
  return directFetch(mint, '15s');
}

/**
 * Live market caps for several SOL tokens at once (portfolio valuation).
 * Reads only — the poller keeps each requested mint warm.
 *
 * @param {string[]} mints
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<Record<string, {marketCap: number|null, time: number|null, cached: boolean, error?: string}>>}
 */
export async function getLiveMcapMany(mints, opts = {}) {
  const unique = [...new Set((mints || []).filter(Boolean))];
  if (!unique.length) return {};
  const entries = await Promise.all(
    unique.map(async (mint) => [mint, await getLiveMcap(mint, opts)])
  );
  return Object.fromEntries(entries);
}

/** Current pacing/backoff state (for debug endpoints). */
export function getLiveMcapStatus() {
  return {
    activeMints: active.size,
    cached: cache.size,
    inflight: inflight.size,
    fetchCount,
    errorCount,
    lastError,
    backoffRemainingMs: Math.max(0, backoffUntil - Date.now()),
    pollerRunning: Boolean(poller),
    tickMs: TICK_MS,
    method: 'cycletls(chrome131)',
  };
}
