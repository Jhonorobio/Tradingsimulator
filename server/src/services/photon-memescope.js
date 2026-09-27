import initCycleTLS from 'cycletls';
import { broadcast, getSubscriptions } from './ws-server.js';

// Photon (photon-sol.tinyastro.io) "memescope" screener feed.
//
// One request per column: the Photon web app requests `/api/memescope/search`
// with `col=colX` + its filter state and reads ONLY `columns[colX]` — filters
// apply to the requested column (verified: grad filters on col1 → 0 items).
// We therefore keep an independent query per category:
//   col1 New         — commons only (no holders/age cap)
//   col2 Graduating  — commons + age <= 30min
//   col3 Graduated   — commons + age <= 30min + holders >= 100 (original)
// and ROTATE one column per tick (1.3s), so upstream traffic stays at
// 1 req / 1.3s (rate-limit safe) while every column refreshes ~3.9s.
// Each refresh pushes the merged payload to WS topic `memescope`.
//
// Cloudflare: the API responds to CycleTLS (chrome131) with browser headers;
// plain curl/Node fetch gets a "Just a moment..." managed challenge.
// App auth: a single cookie `_photon_ta` (Rails signed cookie). Without it the
// app answers {"error":"Unauthorized request"} — no wallet session, no
// cf_clearance needed. Override via env PHOTON_TA when the cookie rotates.
const SEARCH_URL = 'https://photon-sol.tinyastro.io/api/memescope/search';
const DEFAULT_TA =
  '%2BGwOfWeQXAdpObsrbWbYS4vdSrTe5DyYZYGZyWWrgjc3wnJs1sBXV54nyBjf8moVolF87pu3FuBkpi6THzirx5zJ5ycXBFGwanMgB%2BnWxySZ3kQkUpBIHGLWcskMvI8%2FyhcTneZcavfpOHocyeASyqWR%2Fxjrj5Wdtg1gYi%2BUGZrW6LrUFO6CausIAiuUmll74MNPL4ke9q8dqdHwOXKacAz2Go8PHNkysFui8nf0lVsuOarFTSN2pAON103FitzKXH2Od6BhuOeFQtvbuHq8%2FN9QW9T12cH3pZ4LsKbIeARo0BqEpwiM7weVCieEPimC7fj3MwDfOQ%2Fl7Kl864A7ZArqBV3N%2FZuaF%2FCeFBJchYndc7XmcgXfwXEmHBEJ0572%2BIu%2FxLFYxxyPe4G2jSsy6lKj2ePgYSvpTm%2BycWirh2GglInPezLLtXephFUXOU%2FmiOLJ%2FtXC2K4%2FezjU0hCYicG1bwyJEKPdnkgjhcEByIkvO8%2BikldoLN4IqHnj7yfriRlntQ%3D%3D--cYKmQ7Xoco6etjgy--LWP33asZkd3yg8juNGqXDA%3D%3D';

// Rate-limit sweep (2026-09-26, 5-10 min soaks per cadence, ~1400 requests):
//   1.0s  → 429 starts at minute 1-2      1.2s → 429 at ~189s
//   1.3s  → LIMPIO (459/459 in 10 min)    1.4s/1.5s → LIMPIO
//   1.75s..3.0s → LIMPIO
// Zero hangs anywhere (avg 200ms, max 1.2s) — a "stuck" feed was the 429
// backoff (45s), not a hang. 1.3s is the fastest cadence that sustains.
const TICK_MS = 1300;
const RATE_LIMIT_BACKOFF_MS = 45_000;
const FETCH_TIMEOUT_MS = 10_000;
const COL_STALE_MS = 8_000; // > 2 full rotation cycles (3 x 1.3s)
export const MEMESCOPE_TOPIC = 'memescope';

// Screener prefs captured from the Photon web app (main dexes/platforms,
// quote tokens, pump rewards on) — shared by every column query.
const COMMON_FILTERS =
  'dexes=pump%2Craydium_launchpad%2Cmoonshot%2Cboop%2Cmeteora_virtual_curve%2Corca_wavebreak%2Craydium_clmm%2Craydium_cpmm' +
  '&platform=bonk%2Cbelieve%2Cmoonshotdbc%2Cjupiter%2Cbags%2Cwendev%2Cmayhem%2Cbonker%2Cprintr%2Cstonk' +
  '&pump_rewards_enabled=true&quote_token=wsol%2Cusdc%2Cusd1%2Ccustom';

// Independent filters per category (verified against the API: each request
// returns ONLY the requested column populated).
const COL_QUERIES = {
  col1: `${COMMON_FILTERS}&col=col1`, // New — no holders/age filter
  col2: `${COMMON_FILTERS}&age_to=30&col=col2`, // Graduating — fresh launches
  col3: `${COMMON_FILTERS}&age_to=30&extra_filters_count=10&tp_holders_count_from=100&col=col3`, // Graduated
};
const COLS = ['col1', 'col2', 'col3'];
const FALLBACK_TITLES = { col1: 'New', col2: 'Graduating', col3: 'Graduated' };

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

const colCache = { col1: null, col2: null, col3: null }; // { slice, savedAt }
let titles = null;
let nextColIdx = 0;
let poller = null;
let inflight = null; // { colKey, promise }
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

async function fetchOnce(colKey) {
  fetchCount += 1;
  const client = await getCycleTLS();
  const request = client(`${SEARCH_URL}?${COL_QUERIES[colKey]}`, { client: 'chrome131', headers: HEADERS }, 'GET');
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
  const slice = json.columns?.[colKey] ?? { data: [] };
  colCache[colKey] = { slice, savedAt: Date.now() };
  if (json.titles) titles = json.titles;
  // One push per refresh (the 1.3s tick caps it at ~1 push/s). broadcast()
  // only reaches subscribed clients — no-op when nobody is listening.
  lastPushAt = Date.now();
  broadcast(MEMESCOPE_TOPIC, { event: 'memescope_updated', data: snapshotPayload() });
  return json;
}

function coalescedFetch(colKey) {
  if (inflight) return inflight.promise;
  const promise = fetchOnce(colKey)
    .catch((err) => {
      errorCount += 1;
      lastError = { message: String(err?.message || err), at: Date.now() };
      return null;
    })
    .finally(() => { inflight = null; });
  inflight = { colKey, promise };
  return promise;
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
    const colKey = COLS[nextColIdx];
    nextColIdx = (nextColIdx + 1) % COLS.length;
    coalescedFetch(colKey);
  } catch {
    /* the timer must never crash */
  }
}

/** Merged feed payload (all three column caches) — HTTP reads and WS pushes. */
function snapshotPayload() {
  const columns = {};
  let newest = 0;
  let oldest = null;
  let any = false;
  for (const c of COLS) {
    columns[c] = colCache[c]?.slice ?? { data: [] };
    if (colCache[c]) {
      any = true;
      newest = Math.max(newest, colCache[c].savedAt);
      oldest = oldest == null ? colCache[c].savedAt : Math.min(oldest, colCache[c].savedAt);
    }
  }
  if (!any) {
    return { columns: {}, titles: {}, cached: false, ageMs: -1, savedAt: 0 };
  }
  return {
    columns,
    titles: titles ?? FALLBACK_TITLES,
    cached: true,
    // age of the freshest column (updated on every tick/rotation step)
    ageMs: Date.now() - newest,
    savedAt: newest,
    oldestColAgeMs: oldest != null ? Date.now() - oldest : null,
    ...(lastError && Date.now() - lastError.at < 10_000 ? { error: lastError.message } : {}),
  };
}

/**
 * Photon memescape screener feed (New / Graduating / Graduated).
 * The server polls upstream one column per 1.3s tick (rotation) and pushes
 * each refresh to WS subscribers on `memescope`. The HTTP route serves the
 * merged cache and fills missing/stale columns on demand.
 *
 * @returns {Promise<{columns: object, titles: object, cached: boolean, ageMs: number, savedAt: number, error?: string}>}
 *   Never throws: on failure it returns the last cached data plus `error`.
 */
export async function getMemescope() {
  // Cold start (or a column left behind > COL_STALE_MS): fetch it now,
  // sharing any in-flight request.
  for (const c of COLS) {
    const missing = !colCache[c] || Date.now() - colCache[c].savedAt > COL_STALE_MS;
    if (missing && Date.now() >= backoffUntil) {
      await coalescedFetch(c);
      if (inflight) await inflight.promise;
    }
  }
  if (!colCache.col1 && !colCache.col2 && !colCache.col3) {
    return { ...snapshotPayload(), error: lastError?.message || 'NO_DATA' };
  }
  return snapshotPayload();
}

/** Poller diagnostics (for /api/market/memescope-status). */
export function getMemescopeStatus() {
  const colAges = {};
  for (const c of COLS) colAges[c] = colCache[c] ? Date.now() - colCache[c].savedAt : null;
  return {
    running: Boolean(poller),
    tickMs: TICK_MS,
    subscribers: getSubscriptions().has(MEMESCOPE_TOPIC),
    rotation: COLS[nextColIdx],
    colAgesMs: colAges,
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

// The server rotates through the 3 column queries every 1.3s from boot,
// open app or not, and pushes every refresh to WS subscribers.
startPoller();
