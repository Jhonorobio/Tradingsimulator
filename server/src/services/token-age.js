/**
 * Token creation time (unix seconds) for records upstream doesn't carry —
 * FOMO's trending feed never sends `createdAt`, which made the age filter
 * impossible there. Source: Trenchers' Pulse `created_at` (same keyless
 * endpoint as pulse-kol.js), verified at 100% coverage over trending tokens.
 *
 * Values never change, so hits are memoized for 15 min; misses/errors retry
 * after 60s; concurrent callers share one request. One record resolves once
 * and then keeps the value through snapshot merges (see fomo-ws.js).
 */
const PULSE_URL = 'https://pulse-production.trenchers.ai/pulse/token';
const OK_TTL_MS = 15 * 60_000;
const NULL_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;

const cache = new Map(); // address -> { createdAt: number|null, at } (unix seconds)
const inflight = new Map(); // address -> Promise<number|null>

async function fetchCreatedAt(address) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${PULSE_URL}/${address}`, {
      headers: { accept: '*/*' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const raw = json?.created_at;
    if (typeof raw !== 'string') return null;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) return null;
    // `creation_anchored: false` still carries a (first-seen) time — usable.
    return Math.floor(ms / 1000);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} address - token mint
 * @returns {Promise<number|null>} creation time in unix seconds, or null when
 * Pulse has no usable `created_at` (the age filter then excludes the token,
 * like it excludes tokens without a KOL count).
 */
export function getCreatedAt(address) {
  if (!address) return Promise.resolve(null);
  const hit = cache.get(address);
  if (hit && Date.now() - hit.at < (hit.createdAt != null ? OK_TTL_MS : NULL_TTL_MS)) {
    return Promise.resolve(hit.createdAt);
  }
  const running = inflight.get(address);
  if (running) return running;
  const p = (async () => {
    let createdAt = null;
    try {
      createdAt = await fetchCreatedAt(address);
    } catch (err) {
      console.error(`[token-age] ${address.slice(0, 8)}... ${err.message}`);
    }
    cache.set(address, { createdAt, at: Date.now() });
    if (cache.size > 10_000) {
      for (const [k, v] of cache) {
        if (Date.now() - v.at > OK_TTL_MS) cache.delete(k);
        if (cache.size <= 10_000) break;
      }
    }
    return createdAt;
  })();
  inflight.set(address, p);
  p.finally(() => inflight.delete(address)).catch(() => {});
  return p;
}
