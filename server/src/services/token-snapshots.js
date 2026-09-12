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
  'bundler_rate', 'entrapment_ratio',
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
