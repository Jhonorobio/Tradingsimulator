import initCycleTLS from 'cycletls';
import { broadcast, getSubscriptions } from './ws-server.js';

// Photon (photon-sol.tinyastro.io) "memescope" screener feed.
//
// Cadence: the server polls Photon EVERY 1s, always (app open or not), and
// pushes each refresh to WS subscribers on the topic `memescope` (~1 push/s).
// The HTTP route serves the cache.
//
// Cloudflare: the API responds to CycleTLS (chrome131) with browser headers;
// plain curl/Node fetch gets a "Just a moment..." managed challenge.
// App auth: a single cookie `_photon_ta` (Rails signed cookie). Without it the
// app answers {"error":"Unauthorized request"} — no wallet session, no
// cf_clearance needed. Override via env PHOTON_TA when the cookie rotates.
const SEARCH_URL = 'https://photon-sol.tinyastro.io/api/memescope/search';
const DEFAULT_TA =
  '%2BGwOfWeQXAdpObsrbWbYS4vdSrTe5DyYZYGZyWWrgjc3wnJs1sBXV54nyBjf8moVolF87pu3FuBkpi6THzirx5zJ5ycXBFGwanMgB%2BnWxySZ3kQkUpBIHGLWcskMvI8%2FyhcTneZcavfpOHocyeASyqWR%2Fxjrj5Wdtg1gYi%2BUGZrW6LrUFO6CausIAiuUmll74MNPL4ke9q8dqdHwOXKacAz2Go8PHNkysFui8nf0lVsuOarFTSN2pAON103FitzKXH2Od6BhuOeFQtvbuHq8%2FN9QW9T12cH3pZ4LsKbIeARo0BqEpwiM7weVCieEPimC7fj3MwDfOQ%2Fl7Kl864A7ZArqBV3N%2FZuaF%2FCeFBJchYndc7XmcgXfwXEmHBEJ0572%2BIu%2FxLFYxxyPe4G2jSsy6lKj2ePgYSvpTm%2BycWirh2GglInPezLLtXephFUXOU%2FmiOLJ%2FtXC2K4%2FezjU0hCYicG1bwyJEKPdnkgjhcEByIkvO8%2BikldoLN4IqHnj7yfriRlntQ%3D%3D--cYKmQ7Xoco6etjgy--LWP33asZkd3yg8juNGqXDA%3D%3D';

// Measured limits (2026-09-26): ~2 req/s sustained trips HTTP 429 with a
// ~30-60s cooldown; 750ms and 1s cadences run clean. fdv moves 1-2x per second.
const TICK_MS = 1000;
const RATE_LIMIT_BACKOFF_MS = 45_000;
const FETCH_TIMEOUT_MS = 10_000;
const STALE_MS = 3_000;
export const MEMESCOPE_TOPIC = 'memescope';

// Screener filters captured from the Photon web app (graduated column,
// holders >= 100, age <= 30min, main dexes/platforms, pump rewards on).
const QUERY =
  'age_to=30&col=col3&dexes=pump%2Craydium_launchpad%2Cmoonshot%2Cboop%2Cmeteora_virtual_curve%2Corca_wavebreak%2Craydium_clmm%2Craydium_cpmm' +
  '&extra_filters_count=10&platform=bonk%2Cbelieve%2Cmoonshotdbc%2Cjupiter%2Cbags%2Cwendev%2Cmayhem%2Cbonker%2Cprintr%2Cstonk' +
  '&pump_rewards_enabled=true&quote_token=wsol%2Cusdc%2Cusd1%2Ccustom&tp_holders_count_from=100';

const HEADERS = {
  accept: '*/*',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  referer: 'https://photon-sol.tinyastro.io/en/memescope',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  get cookie() {
    return `_photon_ta=${process.env.PHOTON_TA || DEFAULT_TA}`;
  },
};

let cache = null; // { data: {columns,titles,...}, savedAt }
let poller = null;
let inflight = null;
let lastPushAt = 0;
let backoffUntil = 0;
let fetchCount = 0;
let errorCount = 0;
let lastError = null;
let unauthorized = false;
let cycleTLS = null;

async function getCycleTLS() {
  if (!cycleTLS) cycleTLS = await initCycleTLS();
  return cycleTLS;
}

/** Stops the CycleTLS daemon (call on server shutdown). */
export async function closePhoton() {
  stopPoller();
  if (cycleTLS) {
    const c = cycleTLS;
    cycleTLS = null;
    try { await c.exit(); } catch { /* already gone */ }
  }
}

function toObj(data) {
  if (data == null) return null;
  if (typeof data === 'object' && !Buffer.isBuffer(data)) return data;
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  try { return JSON.parse(text); } catch { return null; }
}

async function fetchOnce() {
  fetchCount += 1;
  const client = await getCycleTLS();
  const request = client(`${SEARCH_URL}?${QUERY}`, { client: 'chrome131', headers: HEADERS }, 'GET');
  let timer;
  let resp;
  try {
    resp = await Promise.race([
      request,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMEOUT_${FETCH_TIMEOUT_MS}MS`)), FETCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    request.catch(() => {});
  }

  const status = Number(resp?.status) || 0;
  if (status === 429) {
    backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
    throw Object.assign(new Error('RATE_LIMITED'), { rateLimited: true });
  }
  if (status !== 200) throw new Error(`HTTP_${status}`);

  const json = toObj(resp.data);
  if (!json) throw new Error('BAD_BODY');
  if (json.error) {
    if (String(json.error).includes('Unauthorized')) unauthorized = true;
    throw Object.assign(new Error(json.error), { unauthorized: Boolean(unauthorized) });
  }

  unauthorized = false;
  cache = { data: json, savedAt: Date.now() };
  // One push per refresh (the 1s tick caps it at ~1 push/s). broadcast()
  // only reaches subscribed clients — no-op when nobody is listening.
  lastPushAt = Date.now();
  broadcast(MEMESCOPE_TOPIC, { event: 'memescope_updated', data: snapshotPayload() });
  return json;
}

function coalescedFetch() {
  if (!inflight) {
    inflight = fetchOnce()
      .catch((err) => {
        errorCount += 1;
        lastError = { message: String(err?.message || err), at: Date.now() };
        return null;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

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
    if (Date.now() < backoffUntil) return;
    if (inflight) return;
    coalescedFetch();
  } catch {
    /* the timer must never crash */
  }
}

/** Current feed payload (cache-based) — used for HTTP reads and WS pushes. */
function snapshotPayload() {
  if (!cache) {
    return { columns: {}, titles: {}, cached: false, ageMs: -1, savedAt: 0 };
  }
  return {
    columns: cache.data.columns ?? {},
    titles: cache.data.titles ?? {},
    cached: true,
    ageMs: Date.now() - cache.savedAt,
    savedAt: cache.savedAt,
    ...(lastError && Date.now() - lastError.at < 10_000 ? { error: lastError.message } : {}),
  };
}

/**
 * Photon memescape screener feed (graduated tokens, holders >= 100, ...).
 * The server polls upstream every 1s (always) and pushes each refresh to WS
 * subscribers on `memescope` (~1/s). The HTTP route serves the cache and
 * fetches on demand when it's missing/stale.
 *
 * @returns {Promise<{columns: object, titles: object, cached: boolean, ageMs: number, savedAt: number, error?: string}>}
 *   Never throws: on failure it returns the last cached data plus `error`.
 */
export async function getMemescope() {
  // First read after boot (or stale cache): wait for a fresh fetch
  // (coalesced — concurrent readers share one upstream request).
  const stale = !cache || Date.now() - cache.savedAt > STALE_MS;
  if (stale && Date.now() >= backoffUntil) await coalescedFetch();
  if (!cache) {
    return { ...snapshotPayload(), error: lastError?.message || 'NO_DATA' };
  }
  return snapshotPayload();
}

/** Poller diagnostics (for /api/market/memescope-status). */
export function getMemescopeStatus() {
  return {
    running: Boolean(poller),
    tickMs: TICK_MS,
    subscribers: getSubscriptions().has(MEMESCOPE_TOPIC),
    cacheAgeMs: cache ? Date.now() - cache.savedAt : null,
    columns: cache ? Object.keys(cache.data?.columns || {}) : [],
    fetchCount,
    errorCount,
    lastError,
    unauthorized,
    backoffRemainingMs: Math.max(0, backoffUntil - Date.now()),
    lastPushAgoMs: lastPushAt ? Date.now() - lastPushAt : null,
    cookieSource: process.env.PHOTON_TA ? 'env:PHOTON_TA' : 'default',
    method: 'cycletls(chrome131)',
  };
}

// The server polls Photon every 1s from boot, open app or not, and pushes
// every refresh to WS subscribers.
startPoller();
