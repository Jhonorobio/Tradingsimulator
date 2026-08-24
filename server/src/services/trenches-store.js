/**
 * In-memory snapshot of the latest GMGN trenches data, keyed by token address.
 * Populated on every successful fetchTrenches; lets the token detail screen
 * look up trenches info WITHOUT calling GMGN again.
 * Also used by the push notification poller to detect new tokens per category.
 */

const byAddress = new Map();

/** Merges a fetchTrenches result (new_creation/near_completion/completed) into the store. */
export function upsertTrenches(data) {
  if (!data || typeof data !== 'object') return;
  for (const key of ['new_creation', 'near_completion', 'completed']) {
    const list = data[key];
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      if (t?.address) byAddress.set(t.address, { ...t, _category: key });
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

/** Number of unique tokens currently stored (debugging). */
export function storeSize() {
  return byAddress.size;
}
