// KOL count for the vol≈mcap alert via Trenchers' Pulse API (plain fetch, no
// key, proven to take parallel calls) with GMGN as fallback when Pulse has no
// data (kol_count=null) or the request fails. A 10s memo keeps the per-push
// evaluation from hammering either API: a token in range without KOL is
// re-asked at most once per 10s, not once per Azura push.
import { getRenownedCount } from './gmgn-kol.js';

const PULSE_URL = 'https://pulse-production.trenchers.ai/pulse/token';
const KOL_TTL_MS = 10_000;
const FETCH_TIMEOUT_MS = 15_000;

const cache = new Map(); // address -> { count: number|null, at }
const inflight = new Map(); // address -> Promise<number|null>

async function fetchPulseKol(address) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    console.log(`[pulse-kol] fetch ${address.slice(0, 8)}...`);
    const res = await fetch(`${PULSE_URL}/${address}`, {
      headers: { accept: '*/*' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const raw = json?.kol_count;
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * KOL count for the alert: Pulse first, GMGN when Pulse has no data or the
 * request fails. The result (including "0 KOLs" and errors) is memoized for
 * KOL_TTL_MS and concurrent callers share one request.
 * @param {string} address
 * @returns {Promise<number|null>} count, or null when neither API answered
 */
export function getKolCount(address) {
  if (!address) return Promise.resolve(null);
  const hit = cache.get(address);
  if (hit && Date.now() - hit.at < KOL_TTL_MS) return Promise.resolve(hit.count);
  const running = inflight.get(address);
  if (running) return running;
  const p = (async () => {
    let count = null;
    try {
      count = await fetchPulseKol(address);
    } catch (err) {
      console.error(`[pulse-kol] ${address.slice(0, 8)}... ${err.message}`);
    }
    if (count == null) {
      try {
        count = await getRenownedCount(address);
        if (count != null) {
          console.log(`[pulse-kol] ${address.slice(0, 8)}... gmgn fallback renowned_count=${count}`);
        }
      } catch (err) {
        console.error(`[pulse-kol] ${address.slice(0, 8)}... gmgn fallback ${err.message}`);
      }
    }
    cache.set(address, { count, at: Date.now() });
    return count;
  })();
  inflight.set(address, p);
  p.finally(() => inflight.delete(address)).catch(() => {});
  return p;
}
