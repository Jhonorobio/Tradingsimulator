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
// Temporarily suppress WS broadcasts for a tab (e.g. after filter change)
// so the refresher's stale data doesn't overwrite the HTTP response.
const suppressed = new Set();

export function suppressBroadcast(tab) { suppressed.add(tab); }
export function unsuppressBroadcast(tab) { suppressed.delete(tab); }

/** Merges a fetchTrenches result into per-category stores and broadcasts. */
export function upsertTrenches(data) {
  if (!data || typeof data !== 'object') return;
  const now = Date.now();
  for (const key of ['new_creation', 'near_completion', 'completed']) {
    const list = data[key];
    if (!Array.isArray(list)) continue;
    const map = byCategory[key];
    // Clear old tokens for this category, then insert new ones
    map.clear();
    for (const t of list) {
      if (t?.address) map.set(t.address, t);
    }
    if (list.length > 0 && !suppressed.has(key) && now - lastBroadcast[key] >= BROADCAST_THROTTLE_MS) {
      lastBroadcast[key] = now;
      broadcast(`trenches:${key}`, { event: 'trenches_updated', tab: key, data: list });
    }
  }
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
