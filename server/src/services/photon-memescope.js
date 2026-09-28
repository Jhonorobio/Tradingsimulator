import initCycleTLS from 'cycletls';
import { broadcast, getSubscriptions } from './ws-server.js';
import { notificationConfig, notificationHistory, photonFilters, photonSeen, pushSubscriptions } from '../stores.js';
import { sendPush, isValidPushToken } from './push.js';

// Photon (photon-sol.tinyastro.io) "memescope" screener feed.
//
// One request per column: the Photon web app requests `/api/memescope/search`
// with `col=colX` + its filter state and reads ONLY `columns[colX]` — filters
// apply to the requested column (verified: grad filters on col1 → 0 items).
// We therefore keep an independent query per category:
//   col1 New         — commons only (no holders/age cap)
//   col3 Graduated   — commons + age <= 30min + holders >= 100 (original)
// (col2 Graduating was removed on request 2026-09-27.)
// and ROTATE one column per tick (1.3s), so upstream traffic stays at
// 1 req / 1.3s (rate-limit safe) while every column refreshes ~2.6s.
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
const COL_STALE_MS = 8_000; // > 3 full rotation cycles (2 x 1.3s)
export const MEMESCOPE_TOPIC = 'memescope';

// Screener prefs captured from the Photon web app (main dexes/platforms,
// quote tokens, pump rewards on) — shared by every column query.
const COMMON_FILTERS =
  'dexes=pump%2Craydium_launchpad%2Cmoonshot%2Cboop%2Cmeteora_virtual_curve%2Corca_wavebreak%2Craydium_clmm%2Craydium_cpmm' +
  '&platform=bonk%2Cbelieve%2Cmoonshotdbc%2Cjupiter%2Cbags%2Cwendev%2Cmayhem%2Cbonker%2Cprintr%2Cstonk' +
  '&pump_rewards_enabled=true&quote_token=wsol%2Cusdc%2Cusd1%2Ccustom';

// Per-column user filters (UI: GET/PUT /api/market/memescope-filters).
// Each field is a { min?, max? } pair appended as `<param>_from`/`<param>_to`.
// Reduced on request (2026-09-27) to the preset the user actually uses:
// age (minutes), holders_count, tp_holders_count, mkt_cap (USD), buys,
// fresh_holding_perc (percent). All validated against the live API.
const FILTER_FIELDS = {
  age: 'age',
  holders: 'holders_count',
  tpHolders: 'tp_holders_count',
  mktCap: 'mkt_cap',
  buys: 'buys',
  freshPct: 'fresh_holding_perc',
};
// Mirrors the app's first-run defaults (one entry per column).
const DEFAULT_FILTERS = {
  col1: {},
  col3: { age: { max: '30' }, tpHolders: { min: '100' } },
};
const COLS = ['col1', 'col3'];
const FALLBACK_TITLES = { col1: 'New', col3: 'Graduated' };

// History policy for Photon tokens: one entry per address+column (category
// `photon`, `column: new|graduated`), capped like x_tracker; the seen-map
// (keyed `<col>:<mint>`) prevents re-inserts and lets a token notify again
// when it moves from New to Graduated.
const PHOTON_HISTORY_MAX = 300;
const PHOTON_SEEN_MAX = 5000;

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// Photon sends *_perc values as percent (0-100); trenches entries store rates
// as fractions (0-1) — normalize so the history card renders both the same way.
function pctToRate(v) {
  return v == null ? null : v / 100;
}

function fmtUsd(n) {
  if (n == null || isNaN(n)) return 'n/a';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

/**
 * Expo push for freshly ingested Photon entries, to every device that enabled
 * the column's notification category (`photon_new` / `photon_graduated`).
 * Fire-and-forget: failures never block the poller.
 */
async function deliverPhotonPushes(entries, type) {
  try {
    const devices = Object.values(notificationConfig.getAll())
      .filter((d) => d?.categories?.[type] && isValidPushToken(d.push_token));
    if (!devices.length) return;
    const label = type === 'photon_graduated' ? 'Photon Graduated' : 'Photon New';
    for (const saved of entries) {
      const parts = [];
      if (saved.mcap != null) parts.push(`MCap ${fmtUsd(saved.mcap)}`);
      if (saved.vol24h != null) parts.push(`Vol ${fmtUsd(saved.vol24h)}`);
      if (saved.liq != null) parts.push(`Liq ${fmtUsd(saved.liq)}`);
      const body = parts.join(' · ') || 'Token nuevo en Photon';
      for (const dev of devices) {
        try {
          const { result } = await sendPush(dev.push_token, {
            title: `${saved.symbol || saved.name || 'Token'} — ${label}`,
            body,
            data: { address: saved.address, chain: 'sol', symbol: saved.symbol, type },
          });
          if (result?.data?.status === 'error') {
            console.error(`[photon] push failed: ${result.data.message}`);
          }
        } catch (err) {
          console.error(`[photon] push deliver error: ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.error(`[photon] push error: ${err.message}`);
  }
}

/**
 * Record every token never seen before in this column into the notification
 * history (category `photon`, `column: new|graduated`), broadcast the entries
 * so the History tab updates live, and send an Expo push to devices with the
 * matching category enabled (`photon_new` / `photon_graduated`).
 */
function ingestPhotonTokens(slice, colKey) {
  const items = Array.isArray(slice?.data) ? slice.data : [];
  if (!items.length) return;
  const column = colKey === 'col3' ? 'graduated' : 'new';
  const notifCat = colKey === 'col3' ? 'photon_graduated' : 'photon_new';
  const seen = photonSeen.get('addresses') || {};
  let seenDirty = false;
  const added = [];
  const now = new Date().toISOString();
  for (const it of items) {
    const a = it?.attributes;
    // `tokenAddress` is the mint (CA); `address` is the pair/pool id — GMGN,
    // Dexscreener, mentions and trading all resolve the mint.
    const address = a?.tokenAddress || a?.address;
    if (!address) continue;
    // Per-column dedupe: a token first ingested in New still notifies when it
    // later appears in Graduated. Legacy (unprefixed) keys only block New —
    // they predate column tracking and the token may still graduate.
    const key = `${colKey}:${address}`;
    if (seen[key] || (column === 'new' && seen[address])) continue;
    seen[key] = now;
    seenDirty = true;
    const saved = notificationHistory.add({
      device_id: 'photon',
      address,
      chain: 'sol',
      column,
      symbol: a.symbol || null,
      name: a.name || null,
      category: 'photon',
      mcap: numOrNull(a.fdv),
      liq: numOrNull(a.cur_liq?.usd),
      vol24h: numOrNull(a.volume),
      logo: a.imgUrl || null,
      smart_degen_count: null,
      renowned_count: null,
      // At-appearance snapshot (GMGN-style): fresh%/bundled% come as percent
      // and are stored as rates; counts/buys are raw.
      fresh_wallet_rate: pctToRate(numOrNull(a.fresh_holding_perc)),
      bot_degen_count: null,
      bot_degen_rate: null,
      rug_ratio: null,
      bundler_rate: pctToRate(numOrNull(a.bundle_holding_perc)),
      bundler_trader_amount_rate: null,
      entrapment_ratio: null,
      bundle_holders_count: numOrNull(a.bundle_holders_count),
      buys_count: numOrNull(a.buys_count),
      tp_holders_count: numOrNull(a.tp_holders_count),
      top_holders_rate: pctToRate(numOrNull(a.audit?.top_holders_perc)),
      holders_count: numOrNull(a.holders_count),
      entered_at: now,
      notified_at: now,
      filter_matched_at: null,
    });
    if (saved) added.push(saved);
  }
  if (seenDirty) {
    const keys = Object.keys(seen);
    if (keys.length > PHOTON_SEEN_MAX) {
      for (const k of keys.slice(0, keys.length - PHOTON_SEEN_MAX)) delete seen[k];
    }
    photonSeen.set('addresses', seen);
  }
  if (!added.length) return;

  // Cap this category at PHOTON_HISTORY_MAX (drop the oldest).
  const photonEntries = notificationHistory.getAll().filter((e) => e.category === 'photon');
  if (photonEntries.length > PHOTON_HISTORY_MAX) {
    const ordered = [...photonEntries].sort((a, b) => (a.notified_at || '').localeCompare(b.notified_at || ''));
    for (const old of ordered.slice(0, photonEntries.length - PHOTON_HISTORY_MAX)) {
      notificationHistory.delete((e) => e.id === old.id);
    }
  }

  // Live push: History merges `notification_new` on `notifications:{device}`.
  for (const saved of added) {
    for (const dev of pushSubscriptions.getAll()) {
      if (dev?.device_id) {
        broadcast(`notifications:${dev.device_id}`, { event: 'notification_new', data: saved });
      }
    }
  }

  // Expo push (fire-and-forget) for devices with the column's category on.
  deliverPhotonPushes(added, notifCat).catch(() => {});
}

function sanitizeFilters(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const col of COLS) {
    const c = raw[col];
    if (!c || typeof c !== 'object') continue;
    const clean = {};
    for (const field of Object.keys(FILTER_FIELDS)) {
      const v = c[field];
      if (!v || typeof v !== 'object') continue;
      const pair = {};
      for (const side of ['min', 'max']) {
        const val = v[side];
        if (typeof val === 'string' && /^\d+(\.\d+)?$/.test(val)) pair[side] = val;
      }
      if (pair.min || pair.max) clean[field] = pair;
    }
    if (Object.keys(clean).length) out[col] = clean;
  }
  return out;
}

/** Effective filters per column (stored config merged over defaults). */
export function getPhotonFilters() {
  const entry = photonFilters.get('global');
  const stored = sanitizeFilters(entry?.filters ?? entry ?? {});
  const out = {};
  for (const col of COLS) out[col] = stored[col] ?? DEFAULT_FILTERS[col] ?? {};
  return out;
}

/** Save per-column filters (sanitized) and persist to data/photon_filters.json. */
export function setPhotonFilters(raw) {
  const clean = sanitizeFilters(raw);
  photonFilters.set('global', { filters: clean, updated_at: new Date().toISOString() });
  return getPhotonFilters();
}

/** Build the query string for a column from COMMON + its active filters. */
function buildQuery(colKey) {
  const f = getPhotonFilters()[colKey] ?? {};
  const parts = [COMMON_FILTERS];
  for (const [field, param] of Object.entries(FILTER_FIELDS)) {
    const v = f[field];
    if (v?.min) parts.push(`${param}_from=${v.min}`);
    if (v?.max) parts.push(`${param}_to=${v.max}`);
  }
  parts.push(`col=${colKey}`);
  return parts.join('&');
}

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

const colCache = { col1: null, col3: null }; // { slice, savedAt }
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
  const request = client(`${SEARCH_URL}?${buildQuery(colKey)}`, { client: 'chrome131', headers: HEADERS }, 'GET');
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
  ingestPhotonTokens(slice, colKey);
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
 * Photon memescape screener feed (New / Graduated).
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
  if (!colCache.col1 && !colCache.col3) {
    return { ...snapshotPayload(), error: lastError?.message || 'NO_DATA' };
  }
  return snapshotPayload();
}

/**
 * Look up a token address in the current memescope caches — used as a
 * fallback by GET /token/:chain/:address (Photon-only tokens are unknown to
 * trenches/GMGN/Dexscreener while they are on the bonding curve).
 * @returns {object|null} Photon token attributes
 */
export function findPhotonToken(address) {
  if (!address) return null;
  for (const c of COLS) {
    const data = colCache[c]?.slice?.data;
    if (!Array.isArray(data)) continue;
    const hit = data.find((it) => {
      const a = it?.attributes;
      return (a?.tokenAddress || a?.address) === address;
    });
    if (hit?.attributes) return hit.attributes;
  }
  return null;
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
