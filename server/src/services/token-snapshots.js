/**
 * Token snapshot tracker.
 * Captures token data every 1 minute while tokens are active in trenches.
 * Persists to data/token-snapshots.json.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getCurrentData } from './trenches-store.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, '..', '..', 'data'));
const FILE = path.join(DATA_DIR, 'token-snapshots.json');

// In-memory store: { [address]: { chain, tracks: [{ category, started, ended, snapshots }] } }
let store = {};

// Active tracks: { "address:category": trackIndex }
const activeTracks = new Map();

const SNAPSHOT_FIELDS = [
  'usd_market_cap', 'market_cap', 'liquidity', 'volume_24h',
  'smart_degen_count', 'renowned_count', 'fresh_wallet_rate',
  'bot_degen_count', 'bot_degen_rate', 'rug_ratio',
  'bundler_rate', 'bundler_trader_amount_rate', 'entrapment_ratio',
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
  const TABS = ['new_creation', 'completed', 'new_creation_robinhood', 'completed_robinhood', 'new_creation_bsc', 'completed_bsc'];
  for (const tab of TABS) {
    const tokens = getCurrentData(tab);
    currentByCategory[tab] = new Set(tokens.map((t) => t.address));
  }

  // Close tracks for tokens that disappeared
  for (const [key, trackIdx] of activeTracks.entries()) {
    const [address, category] = key.split(':');
    const currentSet = currentByCategory[category];
    if (!currentSet || !currentSet.has(address)) {
      // Token disappeared from this category
      const entry = store[address];
      if (entry?.tracks?.[trackIdx]) {
        entry.tracks[trackIdx].ended = now;
      }
      activeTracks.delete(key);
    }
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
 * Called every 1 minute. Captures a snapshot for all active tracks.
 */
export function captureSnapshots() {
  const now = new Date().toISOString();
  let captured = 0;

  for (const [key, trackIdx] of activeTracks.entries()) {
    const [address, category] = key.split(':');
    const entry = store[address];
    const track = entry?.tracks?.[trackIdx];
    if (!track || track.ended) {
      activeTracks.delete(key);
      continue;
    }

    // Find the token in current trenches data
    const tokens = getCurrentData(category);
    const token = tokens.find((t) => t.address === address);
    if (!token) {
      // Token disappeared — close track
      track.ended = now;
      activeTracks.delete(key);
      continue;
    }

    track.snapshots.push(takeSnapshot(token));
    captured++;
  }

  if (captured > 0) save();
  return captured;
}

/**
 * Returns the snapshots for a token+category combination.
 * Used when building the notification history entry.
 */
export function getSnapshots(address, category) {
  const entry = store[address];
  if (!entry) return [];
  const track = entry.tracks.find((t) => t.category === category && !t.ended);
  return track?.snapshots ?? [];
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
 * Returns all tracks for a token (for history display).
 */
export function getAllTracks(address) {
  return store[address]?.tracks ?? [];
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
    robinhood: ['new_creation_robinhood', 'completed_robinhood'],
    bsc: ['new_creation_bsc', 'completed_bsc'],
  };

  const allowedCategories = chain === 'all'
    ? ['new_creation', 'completed', 'new_creation_robinhood', 'completed_robinhood', 'new_creation_bsc', 'completed_bsc']
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

// Start snapshot capture loop (every 60 seconds)
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
  }, 60_000);
  console.log('[snapshots] worker started (every 60s)');
}

export function stopSnapshotWorker() {
  if (snapshotInterval) {
    clearInterval(snapshotInterval);
    snapshotInterval = null;
  }
}
