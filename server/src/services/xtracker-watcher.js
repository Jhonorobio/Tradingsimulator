/**
 * Background Tracker watcher (formerly X-Tracker).
 *
 * Ingests every token that shows up in trenches or photon into a persistent
 * watchlist (it survives disappearing from the lists) and then, on a 10s tick:
 *
 *   Dexscreener phase (free, batch of 30 addresses per request)
 *     - mcap < 8_000            -> stop tracking (mcap_below_8k)
 *     - 3 checks w/o any pair   -> stop tracking (no_pairs)
 *     - older than 1h           -> stop tracking (max_age)
 *
 * The Tracker sends NO notifications and writes no history entries: followed
 * tokens are only visible in the app's "Rastreando" tab.
 *
 * State is mutated in memory and flushed to disk at most once per tick.
 */

import { tokenWatchlist } from '../stores.js';
import { fetchTokensBatch } from './dexscreener.js';

const TICK_MS = Number(process.env.XTRACKER_TICK_MS) || 10_000;
const MAX_AGE_MS = 60 * 60 * 1000;   // 1h rastreando como máximo
const MAX_MCAP = 8_000;              // por debajo se deja de rastrear
const NO_PAIRS_MAX = 3;              // chequeos consecutivos sin par
const PRUNE_STOPPED_MS = 24 * 60 * 60 * 1000; // tokens detenidos se borran a las 24h

const watchlist = tokenWatchlist.getAll(); // live reference, flushed by flush()
let dirty = false;
let timer = null;
let lastTickAt = null;
let lastDexAt = null;
let lastFlushAt = null;

// ─── watchlist ──────────────────────────────────────────────────────────────

function newEntry(address, token) {
  return {
    address,
    chain: token.chain || 'sol',
    symbol: token.symbol ?? null,
    name: token.name ?? null,
    logo: token.logo ?? null,
    categories: [],
    status: 'active',
    stop_reason: null,
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    stopped_at: null,
    mcap: null,
    liquidity: null,
    checks: 0,
    no_pairs: 0,
    last_dex_check: null,
  };
}

/**
 * Registers every token from a trenches/photon response into the watchlist.
 * Tokens already stopped are never resurrected.
 * @returns {number} how many brand-new entries were created
 */
export function ingestTrenches(tokens, category) {
  if (!Array.isArray(tokens)) return 0;
  const now = new Date().toISOString();
  let added = 0;
  for (const t of tokens) {
    if (!t?.address) continue;
    let e = watchlist[t.address];
    if (!e) {
      e = watchlist[t.address] = newEntry(t.address, t);
      added += 1;
    }
    if (e.status !== 'active') continue;
    if (t.symbol != null) e.symbol = t.symbol;
    if (t.name != null) e.name = t.name;
    if (t.logo != null) e.logo = t.logo;
    if (category && !e.categories.includes(category)) e.categories.push(category);
    e.last_seen = now;
    const mcap = t.usd_market_cap ?? t.market_cap ?? null;
    if (mcap != null) e.mcap = mcap;
    const liq = t.liquidity ?? null;
    if (liq != null) e.liquidity = liq;
    dirty = true;
  }
  return added;
}

function stopEntry(e, reason) {
  if (e.status === 'stopped') return;
  e.status = 'stopped';
  e.stop_reason = reason;
  e.stopped_at = new Date().toISOString();
  dirty = true;
  console.log(`[tracker] stop ${e.symbol || e.address} (${reason})`);
}

function activeEntries() {
  const out = [];
  for (const e of Object.values(watchlist)) {
    if (e?.status === 'active') out.push(e);
  }
  return out;
}

/** Drops stopped entries older than PRUNE_STOPPED_MS so the file stays small. */
function pruneStopped() {
  const cutoff = Date.now() - PRUNE_STOPPED_MS;
  for (const [address, e] of Object.entries(watchlist)) {
    if (e?.status !== 'stopped') continue;
    const at = new Date(e.stopped_at || e.first_seen).getTime();
    if (Number.isFinite(at) && at < cutoff) {
      delete watchlist[address];
      dirty = true;
    }
  }
}

function flush() {
  if (!dirty) return;
  tokenWatchlist.setAll(watchlist);
  dirty = false;
  lastFlushAt = new Date().toISOString();
}

// ─── dexscreener phase ──────────────────────────────────────────────────────

async function dexPhase() {
  const active = activeEntries();
  if (!active.length) return;

  const now = Date.now();

  // mcap max age applies even if the batch request fails
  for (const e of active) {
    if (now - new Date(e.first_seen).getTime() >= MAX_AGE_MS) stopEntry(e, 'max_age');
  }
  const live = active.filter((e) => e.status === 'active');
  if (!live.length) return;

  const { results, failed } = await fetchTokensBatch(live.map((e) => e.address));
  lastDexAt = new Date().toISOString();

  for (let i = 0; i < live.length; i++) {
    const e = live[i];
    if (e.status !== 'active') continue;
    if (now - new Date(e.first_seen).getTime() >= MAX_AGE_MS) { stopEntry(e, 'max_age'); continue; }

    const info = results[i];
    if (failed.has(e.address)) continue; // HTTP error: unknown, don't count

    e.checks += 1;
    e.last_dex_check = new Date(now).toISOString();

    if (!info) {
      e.no_pairs += 1;
      if (e.no_pairs >= NO_PAIRS_MAX) stopEntry(e, 'no_pairs');
      dirty = true;
      continue;
    }

    e.no_pairs = 0;
    // marketCap is missing on some pairs; fdv is always >= mcap so it is a
    // safe fallback that keeps the "stop below 8k" rule from never firing.
    e.mcap = info.marketCap ?? info.fdv ?? null;
    e.liquidity = info.liquidity ?? e.liquidity;
    dirty = true;

    if (e.mcap != null && e.mcap < MAX_MCAP) stopEntry(e, 'mcap_below_8k');
  }
}

// ─── loop ───────────────────────────────────────────────────────────────────

async function tick() {
  lastTickAt = new Date().toISOString();
  try {
    pruneStopped();
    await dexPhase();
  } catch (err) {
    console.error('[tracker] dex phase error:', err.message);
  }

  try {
    flush();
  } catch (err) {
    console.error('[tracker] flush error:', err.message);
  }
}

export function startXTrackerWatcher({ onError = () => {} } = {}) {
  if (timer) return getXTrackerStatus();
  timer = setInterval(() => {
    tick().catch((err) => {
      console.error('[tracker] tick error:', err.message);
      onError(err);
    });
  }, TICK_MS);
  tick().catch(() => {});
  console.log(`[tracker] watcher started (tick ${TICK_MS}ms, max age ${MAX_AGE_MS / 60000}m, mcap floor ${MAX_MCAP})`);
  return getXTrackerStatus();
}

export function stopXTrackerWatcher() {
  if (timer) clearInterval(timer);
  timer = null;
}

function mapWatchToken(e) {
  const firstSeen = new Date(e.first_seen).getTime();
  return {
    address: e.address,
    chain: e.chain || 'sol',
    symbol: e.symbol ?? null,
    name: e.name ?? null,
    logo: e.logo ?? null,
    status: e.status,
    stop_reason: e.stop_reason ?? null,
    categories: e.categories || [],
    first_seen: e.first_seen,
    last_seen: e.last_seen,
    stopped_at: e.stopped_at ?? null,
    mcap: e.mcap ?? null,
    liquidity: e.liquidity ?? null,
    checks: e.checks || 0,
    no_pairs: e.no_pairs || 0,
    last_dex_check: e.last_dex_check ?? null,
    age_seconds: Number.isFinite(firstSeen) ? Math.max(0, Math.round((Date.now() - firstSeen) / 1000)) : null,
  };
}

/**
 * Watchlist snapshot for the app's "Rastreando" tab.
 * @param {{status?: 'active'|'stopped'|'all', limit?: number, q?: string}} [opts]
 * @returns {Array<object>}
 */
export function getXTrackerTokens(opts = {}) {
  const status = ['active', 'stopped', 'all'].includes(opts.status) ? opts.status : 'active';
  const limit = Math.min(Math.max(Number(opts.limit) || 300, 1), 1000);
  const q = String(opts.q || '').trim().toLowerCase();

  let list = Object.values(watchlist).filter(Boolean);
  if (status !== 'all') list = list.filter((e) => e.status === status);

  if (q) {
    list = list.filter((e) =>
      (e.symbol || '').toLowerCase().includes(q) ||
      (e.name || '').toLowerCase().includes(q) ||
      String(e.address).toLowerCase().includes(q)
    );
  }

  list.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    const ta = a.last_seen ? new Date(a.last_seen).getTime() : 0;
    const tb = b.last_seen ? new Date(b.last_seen).getTime() : 0;
    return tb - ta;
  });

  const all = list.map(mapWatchToken);
  const active = all.filter((t) => t.status === 'active');
  const stopped = all.filter((t) => t.status === 'stopped');
  const summary = {
    active: active.length,
    stopped: stopped.length,
    photon: active.filter((t) => t.categories.includes('photon')).length,
    trenches: active.filter((t) =>
      t.categories.includes('new_creation') || t.categories.includes('completed'),
    ).length,
  };
  return { tokens: all.slice(0, limit), summary, total: all.length };
}

/** Diagnostic snapshot for GET /api/market/xtracker/status */
export function getXTrackerStatus() {
  const entries = Object.values(watchlist);
  const active = entries.filter((e) => e.status === 'active');
  const stopReasons = {};
  for (const e of entries) if (e.stop_reason) stopReasons[e.stop_reason] = (stopReasons[e.stop_reason] || 0) + 1;

  return {
    running: timer != null,
    tickMs: TICK_MS,
    rules: { maxAgeMs: MAX_AGE_MS, maxMcap: MAX_MCAP, noPairsMax: NO_PAIRS_MAX },
    total: entries.length,
    active: active.length,
    stopped: entries.length - active.length,
    stopReasons,
    lastTickAt,
    lastDexAt,
    lastFlushAt,
    sample: active.slice(0, 15).map((e) => ({
      address: e.address,
      symbol: e.symbol,
      mcap: e.mcap,
      checks: e.checks,
      ageMin: Math.round((Date.now() - new Date(e.first_seen).getTime()) / 60000),
    })),
  };
}
