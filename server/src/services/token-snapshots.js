/**
 * Token snapshot tracker.
 * Captures token data every 30 seconds while tokens are active in trenches.
 * Persists to data/token-snapshots.json.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getCurrentData } from './trenches-store.js';
import { findPhotonToken } from './photon-memescope.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, '..', '..', 'data'));
const FILE = path.join(DATA_DIR, 'token-snapshots.json');

// In-memory store: { [address]: { chain, tracks: [{ category, started, ended, snapshots }] } }
let store = {};

// Active tracks: { "address:category": trackIndex }
const activeTracks = new Map();

// ~36 hours of 30-second samples — long-lived tokens never grow the file unbounded.
const TRACK_SNAPSHOTS_MAX = 4320;

// Close a track once its token has been absent from the live feeds for 1 hour.
const TRACK_CLOSE_MS = 60 * 60_000;

const SNAPSHOT_FIELDS = [
  'usd_market_cap', 'market_cap', 'liquidity', 'volume_24h',
  'smart_degen_count', 'renowned_count', 'fresh_wallet_rate',
  'bot_degen_count', 'bot_degen_rate',
  'bundler_rate', 'bundler_trader_amount_rate', 'entrapment_ratio',
  'bundle_holders_count', 'buys_count', 'tp_holders_count',
  'top_holders_rate', 'holders_count',
];

function load() {
  try {
    if (existsSync(FILE)) {
      store = JSON.parse(readFileSync(FILE, 'utf8'));
    }
  } catch {
    store = {};
  }
}

function save() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  renameSync(tmp, FILE);
}

function takeSnapshot(token) {
  const snap = { t: new Date().toISOString() };
  for (const f of SNAPSHOT_FIELDS) {
    snap[f] = token[f] ?? null;
  }
  return snap;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pctToRateOrNull(v) {
  const n = numOrNull(v);
  return n == null ? null : n / 100;
}

/**
 * Snapshot source for a Photon (memescope) token: attributes are read live
 * from the screener cache; fields only trenches provides come back null.
 */
function photonSnapshotSource(address) {
  const a = findPhotonToken(address);
  if (!a) return null;
  return {
    usd_market_cap: numOrNull(a.fdv),
    liquidity: numOrNull(a.cur_liq?.usd),
    volume_24h: numOrNull(a.volume),
    fresh_wallet_rate: pctToRateOrNull(a.fresh_holding_perc),
    bundler_rate: pctToRateOrNull(a.bundle_holding_perc),
    bundle_holders_count: numOrNull(a.bundle_holders_count),
    buys_count: numOrNull(a.buys_count),
    tp_holders_count: numOrNull(a.tp_holders_count),
    top_holders_rate: pctToRateOrNull(a.audit?.top_holders_perc),
    holders_count: numOrNull(a.holders_count),
  };
}

/**
 * Called after upsertTrenches. Detects new tokens and disappeared tokens.
 * - New token → opens a new track
 * - Existing token → no-op (snapshot captured separately)
 * - Disappeared token → closes its track
 */
export function syncTracks() {
  const now = new Date().toISOString();

  // Get all current tokens grouped by category
  const currentByCategory = {};
  const TABS = ['new_creation', 'completed'];
  for (const tab of TABS) {
    const tokens = getCurrentData(tab);
    currentByCategory[tab] = new Set(tokens.map((t) => t.address));
  }

  // Deregister tokens that disappeared — but keep their track OPEN so the
  // timeline continues seamlessly if the token reappears later. Only the
  // trenches tabs are governed by these lists: Photon tracks stay registered
  // (captureSnapshots skips them while absent from the live screener cache),
  // otherwise every trenches refresh would silently kill photon timelines.
  for (const key of activeTracks.keys()) {
    const [address, category] = key.split(':');
    if (!TABS.includes(category)) continue;
    if (!currentByCategory[category]?.has(address)) activeTracks.delete(key);
  }

  // Open tracks for new tokens
  for (const tab of TABS) {
    const tokens = getCurrentData(tab);
    for (const t of tokens) {
      if (!t.address) continue;
      const trackKey = `${t.address}:${tab}`;
      if (activeTracks.has(trackKey)) continue;

      // Check if this token already has an open track for this category
      const entry = store[t.address];
      if (!entry) {
        store[t.address] = { chain: t.chain || 'sol', tracks: [] };
      }
      const tracks = store[t.address].tracks;
      const existingOpen = tracks.findIndex((tr) => tr.category === tab && !tr.ended);
      if (existingOpen >= 0) {
        activeTracks.set(trackKey, existingOpen);
        continue;
      }

      // Create new track
      const track = {
        category: tab,
        started: now,
        ended: null,
        snapshots: [takeSnapshot(t)],
      };
      tracks.push(track);
      activeTracks.set(trackKey, tracks.length - 1);
    }
  }

  save();
}

/**
 * Ensures an open track exists for address+category, seeded with a first
 * snapshot (Photon ingest/bootstrap; trenches tracks open via syncTracks).
 * Returns true when a new track was created.
 */
export function ensureTrack(address, category, seed = {}, startedAt = null) {
  if (!address || !category) return false;
  if (!store[address]) store[address] = { chain: 'sol', tracks: [] };
  const tracks = store[address].tracks;
  const openIdx = tracks.findIndex((t) => t.category === category && !t.ended);
  const key = `${address}:${category}`;
  if (openIdx >= 0) {
    if (!activeTracks.has(key)) activeTracks.set(key, openIdx);
    return false;
  }
  const started = startedAt || new Date().toISOString();
  const snap = { t: started };
  for (const f of SNAPSHOT_FIELDS) snap[f] = seed[f] ?? null;
  tracks.push({ category, started, ended: null, snapshots: [snap] });
  activeTracks.set(key, tracks.length - 1);
  save();
  return true;
}

/**
 * Called every 30 seconds. Captures a snapshot for all active tracks.
 */
export function captureSnapshots() {
  let captured = 0;
  let closed = 0;

  // A track closes once its source has been absent for an hour (the last
  // snapshot's timestamp gates it) and reopens fresh on reappearance.
  const closeIfStale = (track, key) => {
    const lastT = track.snapshots[track.snapshots.length - 1]?.t;
    if (lastT && Date.now() - new Date(lastT).getTime() > TRACK_CLOSE_MS) {
      track.ended = lastT;
      activeTracks.delete(key);
      closed++;
      return true;
    }
    return false;
  };

  for (const [key, trackIdx] of activeTracks.entries()) {
    const [address, category] = key.split(':');
    const entry = store[address];
    const track = entry?.tracks?.[trackIdx];
    if (!track || track.ended) {
      activeTracks.delete(key);
      continue;
    }

    // Trenches tokens come from the store; Photon tracks sample the live
    // screener cache. Absent tokens are skipped — the track closes once the
    // token has been gone for an hour (and resumes as a new track if it
    // ever reappears).
    const token = category === 'photon'
      ? photonSnapshotSource(address)
      : getCurrentData(category).find((t) => t.address === address);
    if (!token) {
      closeIfStale(track, key);
      continue;
    }

    const snap = takeSnapshot(token);
    track.snapshots.push(snap);
    if (track.snapshots.length > TRACK_SNAPSHOTS_MAX) track.snapshots.shift();
    captured++;
  }

  if (captured > 0 || closed > 0) save();
  if (closed > 0) console.log(`[snapshots] closed ${closed} stale track(s)`);
  return captured;
}

/**
 * Returns the snapshots for a token+category combination.
 * Used when building the notification history entry.
 * Prefers the open track; falls back to the most recent closed one.
 */
export function getSnapshots(address, category) {
  const entry = store[address];
  if (!entry) return [];
  const tracks = entry.tracks.filter((t) => t.category === category);
  const open = tracks.find((t) => !t.ended);
  if (open) return open.snapshots ?? [];
  const closedTracks = tracks.filter((t) => t.ended);
  return closedTracks[closedTracks.length - 1]?.snapshots ?? [];
}

/** Whether a track is currently registered for snapshot sampling. */
export function isTrackActive(address, category) {
  return activeTracks.has(`${address}:${category}`);
}

/** Diagnostics: active track counts per category (and open/closed totals). */
export function getTracksStatus() {
  const byCategory = {};
  for (const key of activeTracks.keys()) {
    const cat = key.slice(key.indexOf(':') + 1);
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }
  let open = 0;
  let closed = 0;
  for (const entry of Object.values(store)) {
    for (const t of entry.tracks) {
      if (t.ended) closed++;
      else open++;
    }
  }
  return { active: activeTracks.size, byCategory, open, closed };
}

/**
 * Returns the first snapshot for a token+category (the notification moment).
 */
export function getFirstSnapshot(address, category) {
  const entry = store[address];
  if (!entry) return null;
  const track = entry.tracks.find((t) => t.category === category);
  return track?.snapshots?.[0] ?? null;
}

/**
 * Returns the latest snapshot data for a token across all tracks.
 * Used as fast fallback when token is not in trenches.
 */
export function getLatestSnapshotData(address) {
  const entry = store[address];
  if (!entry) return null;
  let latest = null;
  let latestTime = 0;
  for (const track of entry.tracks) {
    const lastSnap = track.snapshots?.[track.snapshots.length - 1];
    if (!lastSnap) continue;
    const t = new Date(lastSnap.t).getTime();
    if (t > latestTime) {
      latestTime = t;
      latest = lastSnap;
    }
  }
  return latest;
}

/**
 * Returns all tracks for a token (for history display).
 */
export function getAllTracks(address) {
  return store[address]?.tracks ?? [];
}

/**
 * Returns the track started time for a token+category combination.
 * Used to record when a token first entered the system.
 * Falls back to the latest closed track when none is open.
 */
export function getTrackStarted(address, category) {
  const entry = store[address];
  if (!entry) return null;
  const tracks = entry.tracks.filter((t) => t.category === category);
  const open = tracks.find((t) => !t.ended);
  if (open) return open.started;
  const closedTracks = tracks.filter((t) => t.ended);
  return closedTracks[closedTracks.length - 1]?.started ?? null;
}

/**
 * Returns all tracks across all addresses, filtered by chain/category/time.
 * Used for snapshot export endpoint.
 */
export function getAllTracksFiltered(opts = {}) {
  const {
    chain = 'all',
    category = 'all',
    minGainPct = -100,
    maxTracks = 200,
    includeTimeline = true,
    sinceHours = 168,
    balanceRatio = 0.5,
  } = opts;

  const chainMap = {
    sol: ['new_creation', 'completed'],
  };

  const allowedCategories = chain === 'all'
    ? ['new_creation', 'completed']
    : chainMap[chain] || [];

  const sinceMs = Date.now() - sinceHours * 60 * 60 * 1000;
  const tracks = [];

  for (const [address, entry] of Object.entries(store)) {
    if (!entry?.tracks) continue;
    for (const track of entry.tracks) {
      if (!allowedCategories.includes(track.category)) continue;
      if (track.started && new Date(track.started).getTime() < sinceMs) continue;
      if (!track.snapshots?.length) continue;

      const first = track.snapshots[0];
      const peak = track.snapshots.reduce((max, s) =>
        snapshotMcap(s) > snapshotMcap(max) ? s : max
      , first);
      const last = track.snapshots[track.snapshots.length - 1];

      const firstMcap = snapshotMcap(first);
      const peakMcap = snapshotMcap(peak);
      const gainPct = firstMcap > 0 ? ((peakMcap - firstMcap) / firstMcap) * 100 : 0;

      if (gainPct < minGainPct) continue;

      const timeToPeakMinutes = peak.t && first.t
        ? (new Date(peak.t).getTime() - new Date(first.t).getTime()) / 60000
        : 0;

      const outcome = !track.ended ? 'active'
        : peakMcap > firstMcap * 1.5 ? 'peak_reached'
        : peakMcap < firstMcap * 0.5 ? 'rugged'
        : 'partial_retrace';

      const trackData = {
        address,
        chain: entry.chain || 'sol',
        category: track.category,
        symbol: first.symbol || '',
        name: first.name || '',
        firstSnapshot: pickSnapshotFields(first),
        peakSnapshot: pickSnapshotFields(peak),
        finalSnapshot: pickSnapshotFields(last),
        gainPct: Math.round(gainPct * 100) / 100,
        timeToPeakMinutes: Math.round(timeToPeakMinutes * 100) / 100,
        outcome,
        trackDurationMinutes: track.ended && track.started
          ? Math.round((new Date(track.ended).getTime() - new Date(track.started).getTime()) / 60000)
          : null,
      };

      if (includeTimeline) {
        trackData.timeline = track.snapshots.map(pickSnapshotFields);
      }

      tracks.push(trackData);
    }
  }

  // Sort by gain desc, limit
  // Separate winners and losers
  const winnersAll = tracks.filter(t => t.gainPct > 0);
  const losersAll = tracks.filter(t => t.gainPct <= 0);

  // Balance according to ratio (e.g., 0.5 = 50% winners, 50% losers)
  const targetWinners = Math.round(maxTracks * balanceRatio);
  const targetLosers = maxTracks - targetWinners;

  const winners = winnersAll
    .sort((a, b) => b.gainPct - a.gainPct)
    .slice(0, targetWinners);
  const losers = losersAll
    .sort((a, b) => a.gainPct - b.gainPct)  // worst losers first
    .slice(0, targetLosers);

  const included = [...winners, ...losers].sort((a, b) => b.gainPct - a.gainPct);

  const stats = {
    winners: aggregateMetrics(winners),
    losers: aggregateMetrics(losers),
    total: included.length,
    totalAvailable: { winners: winnersAll.length, losers: losersAll.length },
    byCategory: Object.fromEntries(
      allowedCategories.map(cat => [cat, included.filter(t => t.category === cat).length])
    ),
  };

  return { tracks: included, stats };
}

function pickSnapshotFields(snap) {
  if (!snap) return {};
  const out = { t: snap.t };
  for (const f of SNAPSHOT_FIELDS) {
    out[f] = snap[f] ?? null;
  }
  return out;
}

function snapshotMcap(snap) {
  if (!snap) return 0;
  return snap.usd_market_cap ?? snap.market_cap ?? 0;
}

function aggregateMetrics(tracks) {
  if (!tracks.length) return { count: 0 };
  const metrics = {};
  for (const f of SNAPSHOT_FIELDS) {
    const values = tracks.map(t => t.firstSnapshot?.[f]).filter(v => v != null && !isNaN(v));
    if (!values.length) continue;
    values.sort((a, b) => a - b);
    metrics[f] = {
      count: values.length,
      min: values[0],
      max: values[values.length - 1],
      median: percentile(values, 50),
      p25: percentile(values, 25),
      p75: percentile(values, 75),
      p10: percentile(values, 10),
      p90: percentile(values, 90),
      mean: values.reduce((a, b) => a + b, 0) / values.length,
    };
  }
  return {
    count: tracks.length,
    medianGainPct: percentile(tracks.map(t => t.gainPct).sort((a, b) => a - b), 50),
    meanGainPct: tracks.reduce((a, b) => a + b.gainPct, 0) / tracks.length,
    metricsAtEntry: metrics,
  };
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

// Load on import
load();

// Start snapshot capture loop (every 30 seconds)
let snapshotInterval = null;
export function startSnapshotWorker() {
  if (snapshotInterval) return;
  snapshotInterval = setInterval(() => {
    try {
      const n = captureSnapshots();
      if (n > 0) console.log(`[snapshots] captured ${n} snapshots`);
    } catch (err) {
      console.error('[snapshots] error:', err.message);
    }
  }, 30_000);
  console.log('[snapshots] worker started (every 30s)');
}

export function stopSnapshotWorker() {
  if (snapshotInterval) {
    clearInterval(snapshotInterval);
    snapshotInterval = null;
  }
}
