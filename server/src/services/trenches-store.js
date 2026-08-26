/**
 * In-memory snapshot of the latest GMGN trenches data, keyed by token address.
 * Populated on every successful fetchTrenches; lets the token detail screen
 * look up trenches info WITHOUT calling GMGN again.
 * Also used by the push notification poller to detect new tokens per category.
 */

import { broadcast } from './ws-server.js';

// Separate maps per category to prevent cross-contamination
const byCategory = {
  new_creation: new Map(),
  near_completion: new Map(),
  completed: new Map(),
};
const lastBroadcast = { new_creation: 0, near_completion: 0, completed: 0 };
const BROADCAST_THROTTLE_MS = 1000;

// Optional callback fired after new tokens are inserted (for push notifications)
let onNewTokens = null;

/** Register a callback to be called when new tokens are upserted.
 *  Callback receives (updatedTabs: string[]) — the categories that changed. */
export function onTokensInserted(cb) {
  onNewTokens = cb;
}

/** Merges a fetchTrenches result into per-category stores and broadcasts.
 *  When `tab` is provided, only that category's store is updated — this
 *  prevents one refresher worker's response (which defaults non-fetched
 *  categories to []) from wiping out other workers' data. */
export function upsertTrenches(data, source = 'refresher', tab = null) {
  if (!data || typeof data !== 'object') return;
  const now = Date.now();
  const keys = tab ? [tab] : ['new_creation', 'near_completion', 'completed'];
  const updatedTabs = [];
  for (const key of keys) {
    if (!['new_creation', 'near_completion', 'completed'].includes(key)) continue;
    const list = data[key];
    if (!Array.isArray(list)) continue;
    const map = byCategory[key];
    map.clear();
    for (const t of list) {
      if (t?.address) map.set(t.address, t);
    }
    updatedTabs.push(key);
    const canBroadcast = now - lastBroadcast[key] >= BROADCAST_THROTTLE_MS;
    if (canBroadcast && list.length > 0) {
      lastBroadcast[key] = now;
      broadcast(`trenches:${key}`, { event: 'trenches_updated', tab: key, data: list });
    }
  }
  // Notify listener (push notification check) about updated categories
  if (updatedTabs.length > 0 && onNewTokens) {
    try { onNewTokens(updatedTabs); } catch {}
  }
}

/** Returns current trenches data for a tab (or all tabs). */
export function getCurrentData(tab = null) {
  if (tab) {
    const map = byCategory[tab];
    if (!map) return [];
    return [...map.values()];
  }
  const out = {};
  for (const key of ['new_creation', 'near_completion', 'completed']) {
    out[key] = [...byCategory[key].values()];
  }
  return out;
}

/** Returns the cached trenches token for an address, or null. */
export function findToken(address) {
  for (const key of ['new_creation', 'near_completion', 'completed']) {
    const t = byCategory[key].get(address);
    if (t) return { ...t, _category: key };
  }
  return null;
}

/** Returns all tokens in the store as an array. */
export function getAllTokens() {
  const out = [];
  for (const key of ['new_creation', 'near_completion', 'completed']) {
    for (const t of byCategory[key].values()) {
      out.push({ ...t, _category: key });
    }
  }
  return out;
}

/** Returns tokens for a specific category. */
export function getCategoryTokens(category) {
  const map = byCategory[category];
  if (!map) return [];
  return [...map.values()];
}

/** Number of unique tokens currently stored (debugging). */
export function storeSize() {
  let n = 0;
  for (const key of ['new_creation', 'near_completion', 'completed']) {
    n += byCategory[key].size;
  }
  return n;
}
