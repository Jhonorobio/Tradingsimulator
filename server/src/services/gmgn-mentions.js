import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

// Cloudflare blocks Node/OpenSSL TLS fingerprints (JA3) on gmgn.ai internal
// endpoints — the same request with a browser UA works from curl (Schannel on
// Windows, OpenSSL on Linux). So every fetch goes through a spawned curl with
// a Chrome User-Agent.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CURL_BIN = process.platform === 'win32' ? 'curl.exe' : 'curl';
const TIMEOUT_MS = 15_000;

// Client-side pacing: 1 request/s globally (extension uses 10s + 900ms stagger
// per mint; we round-robin through mints instead).
const MIN_INTERVAL_MS = 1_000;
// Backoff after a 403/429 (same as the extension's 60s).
const BACKOFF_MS = 60_000;
// Mentions change slowly — 60s cache is plenty for the UI.
const CACHE_TTL_MS = 60_000;

const cache = new Map(); // mint -> { data, savedAt }
let queue = [];
let pumping = false;
let nextSlot = 0;
let backoffUntil = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * One raw call to GMGN's internal Twitter-mentions endpoint, via curl.
 * @returns {Promise<{status: number, items: Array}>}
 */
async function curlMentions(mint, limit) {
  const url =
    'https://gmgn.ai/vas/api/v1/twitter/token/search?keyword=' +
    encodeURIComponent(mint) +
    '&limit=' +
    encodeURIComponent(limit);
  const { stdout } = await pExecFile(
    CURL_BIN,
    ['-s', '-m', '15', '-H', `User-Agent: ${CHROME_UA}`, '-H', 'Accept: application/json', url],
    { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 }
  );
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error('NON_JSON');
  }
  return { status: 200, code: json?.code, items: Array.isArray(json?.data) ? json.data : [] };
}

// Serialized pump: runs queued fetches respecting MIN_INTERVAL_MS and backoff.
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      if (Date.now() < backoffUntil) {
        const wait = backoffUntil - Date.now();
        queue.splice(0, queue.length).forEach((t) => t.reject(new Error('BACKOFF')));
        await sleep(wait);
        continue;
      }
      const wait = nextSlot - Date.now();
      if (wait > 0) await sleep(wait);
      const task = queue.shift();
      nextSlot = Date.now() + MIN_INTERVAL_MS;
      try {
        const result = await curlMentions(task.mint, task.limit);
        task.resolve(result);
      } catch (err) {
        task.reject(err);
      }
    }
  } finally {
    pumping = false;
  }
}

function enqueue(mint, limit) {
  return new Promise((resolve, reject) => {
    queue.push({ mint, limit, resolve, reject });
    pump();
  });
}

/**
 * Fetches X/Twitter mentions for a token from GMGN (internal endpoint, via
 * curl). Cached for CACHE_TTL_MS; calls are serialized at 1 req/s; 403/429
 * triggers a 60s backoff for all callers.
 *
 * @param {string} mint - token contract address
 * @param {{limit?: number, force?: boolean}} [opts]
 * @returns {Promise<{items: Array, cached: boolean, error?: string}>}
 */
export async function getMentions(mint, opts = {}) {
  if (!mint) return { items: [], cached: false, error: 'NO_MINT' };
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 50);

  if (!opts.force) {
    const hit = cache.get(mint);
    if (hit && Date.now() - hit.savedAt < CACHE_TTL_MS) {
      return { items: hit.data, cached: true };
    }
  }

  if (Date.now() < backoffUntil) {
    const hit = cache.get(mint);
    return { items: hit?.data || [], cached: Boolean(hit), error: 'BACKOFF' };
  }

  try {
    const { items } = await enqueue(mint, limit);
    cache.set(mint, { data: items, savedAt: Date.now() });
    return { items, cached: false };
  } catch (err) {
    if (err.message === 'NON_JSON' || /403|429|timed? ?out/i.test(err.message || '')) {
      backoffUntil = Date.now() + BACKOFF_MS;
    }
    const hit = cache.get(mint);
    return { items: hit?.data || [], cached: Boolean(hit), error: err.message };
  }
}

/** Current pacing/backoff state (for the debug endpoint). */
export function getMentionsStatus() {
  return {
    queueLength: queue.length,
    backoffRemainingMs: Math.max(0, backoffUntil - Date.now()),
    cached: cache.size,
    curl: CURL_BIN,
  };
}
