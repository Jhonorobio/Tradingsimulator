/**
 * In-memory snapshot of the latest GMGN trenches data, keyed by token address.
 * Populated on every successful fetchTrenches; lets the token detail screen
 * look up trenches info WITHOUT calling GMGN again.
 * Also used by the push notification poller to detect new tokens per category.
 */

import { broadcast } from './ws-server.js';

const byAddress = new Map();
const lastBroadcast = { new_creation: 0, near_completion: 0, completed: 0 };
const BROADCAST_THROTTLE_MS = 3000; // notify at most once per 3s per category

/** Merges a fetchTrenches result (new_creation/near_completion/completed) into the store. */
export function upsertTrenches(data) {
  if (!data || typeof data !== 'object') return;
  const now = Date.now();
  for (const key of ['new_creation', 'near_completion', 'completed']) {
    const list = data[key];
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      if (t?.address) byAddress.set(t.address, { ...t, _category: key });
    }
    // Broadcast data directly — no HTTP refetch needed (single user, GMGN does filtering)
    if (list.length > 0 && now - lastBroadcast[key] >= BROADCAST_THROTTLE_MS) {
      lastBroadcast[key] = now;
      broadcast(`trenches:${key}`, { event: 'trenches_updated', tab: key, data: list });
    }
  }
}

/** Returns the cached trenches token for an address, or null. */
export function findToken(address) {
  return byAddress.get(address) ?? null;
}

/** Returns all tokens in the store as an array. */
export function getAllTokens() {
  return [...byAddress.values()];
}

/** Returns tokens for a specific category. */
export function getCategoryTokens(category) {
  const tokens = [];
  for (const t of byAddress.values()) {
    if (t._category === category) tokens.push(t);
  }
  return tokens;
}

/** Number of unique tokens currently stored (debugging). */
export function storeSize() {
  return byAddress.size;
}
