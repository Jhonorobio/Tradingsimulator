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

// Live mcap is polled ~2x/s by the app; serve from cache for most hits so
// GMGN sees ~2 req/s regardless of how many viewers are open.
const CACHE_TTL_MS = 400;
// Global pacing between upstream calls (all mints share the slot).
const MIN_INTERVAL_MS = 300;
const BACKOFF_MS = 60_000;
// Never let a hung upstream call block the route (polled every 500ms).
const FETCH_TIMEOUT_MS = 8_000;

const cache = new Map(); // mint -> { data, savedAt }
const inflight = new Map(); // mint -> Promise
let nextSlot = 0;
let backoffUntil = 0;
let cycleTLS = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getCycleTLS() {
  if (!cycleTLS) cycleTLS = await initCycleTLS();
  return cycleTLS;
}

/** Stops the CycleTLS daemon (call on server shutdown). */
export async function closeMcap() {
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
  const wait = nextSlot - Date.now();
  if (wait > 0) await sleep(wait);
  nextSlot = Date.now() + MIN_INTERVAL_MS;

  const request = requestLiveCandle(mint, resolution);
  // A hung upstream call must never block the route (polled every 500ms):
  // win the race or fail; the abandoned promise's late rejection is swallowed.
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
  const resp = await client(candlesUrl(mint, resolution), {
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

/**
 * Live market cap (USD) for a SOL token, from GMGN's internal candles
 * endpoint via CycleTLS.
 *
 * @param {string} mint - token contract address
 * @param {{resolution?: string, force?: boolean, freshMs?: number}} [opts]
 *   `freshMs` overrides how long a cached value stays fresh (default 400ms;
 *   portfolio-style callers pass ~2000ms so a batch read stays cheap).
 * @returns {Promise<{marketCap: number|null, time: number|null, cached: boolean, error?: string}>}
 *   Never throws: on upstream failure it returns the last cached value (if
 *   any) plus `error`.
 */
export async function getLiveMcap(mint, opts = {}) {
  if (!mint) return { marketCap: null, time: null, cached: false, error: 'NO_MINT' };
  const resolution = String(opts.resolution || '15s');
  const freshMs = Number(opts.freshMs) > 0 ? Number(opts.freshMs) : CACHE_TTL_MS;
  const now = Date.now();

  if (!opts.force) {
    const hit = cache.get(mint);
    if (hit && now - hit.savedAt < freshMs) {
      return { ...hit.data, cached: true };
    }
  }

  if (now < backoffUntil) {
    const hit = cache.get(mint);
    return {
      marketCap: hit?.data.marketCap ?? null,
      time: hit?.data.time ?? null,
      cached: Boolean(hit),
      error: 'BACKOFF',
    };
  }

  // Coalesce concurrent viewers of the same token into one upstream call.
  let pending = inflight.get(mint);
  if (!pending) {
    pending = fetchLiveCandle(mint, resolution)
      .then((data) => {
        cache.set(mint, { data, savedAt: Date.now() });
        return { ...data, cached: false };
      })
      .catch((err) => {
        if (err.httpCode === 403 || err.httpCode === 429) backoffUntil = Date.now() + BACKOFF_MS;
        const hit = cache.get(mint);
        return {
          marketCap: hit?.data.marketCap ?? null,
          time: hit?.data.time ?? null,
          cached: Boolean(hit),
          error: err.message,
        };
      })
      .finally(() => {
        inflight.delete(mint);
      });
    inflight.set(mint, pending);
  }
  return pending;
}

/**
 * Live market caps for several SOL tokens at once (portfolio valuation).
 * Concurrent per mint, upstream starts stay paced by MIN_INTERVAL_MS; mints
 * already fresh in cache are returned without a fetch.
 *
 * @param {string[]} mints
 * @param {{freshMs?: number, force?: boolean}} [opts]
 * @returns {Promise<Record<string, {marketCap: number|null, time: number|null, cached: boolean, error?: string}>>}
 */
export async function getLiveMcapMany(mints, opts = {}) {
  const unique = [...new Set((mints || []).filter(Boolean))];
  if (!unique.length) return {};
  const freshMs = Number(opts.freshMs) > 0 ? Number(opts.freshMs) : CACHE_TTL_MS;
  const entries = await Promise.all(
    unique.map(async (mint) => {
      const hit = cache.get(mint);
      const stale = hit && Date.now() - hit.savedAt >= freshMs;
      if (stale && !opts.force) {
        // Stale-while-revalidate: serve the last value now and refresh in the
        // background, so a portfolio poll never waits on the upstream call.
        getLiveMcap(mint, { force: true, freshMs }).catch(() => {});
        return [mint, { ...hit.data, cached: true }];
      }
      return [mint, await getLiveMcap(mint, opts)];
    })
  );
  return Object.fromEntries(entries);
}

/** Current pacing/backoff state (for debug endpoints). */
export function getLiveMcapStatus() {
  return {
    inflight: inflight.size,
    cached: cache.size,
    backoffRemainingMs: Math.max(0, backoffUntil - Date.now()),
    minIntervalMs: MIN_INTERVAL_MS,
    method: 'cycletls(chrome131)',
  };
}
