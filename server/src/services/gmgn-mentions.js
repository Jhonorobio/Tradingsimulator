import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import initCycleTLS from 'cycletls';

const pExecFile = promisify(execFile);

// Cloudflare blocks Node/OpenSSL TLS fingerprints (JA3) on gmgn.ai internal
// endpoints. Verified: plain fetch -> 403, curl.exe (Schannel) -> 200,
// CycleTLS with a Chrome131 ClientHello -> 200. On Linux (Railway) curl uses
// OpenSSL too, so the primary method is CycleTLS; curl stays as fallback.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CURL_BIN = process.platform === 'win32' ? 'curl.exe' : 'curl';
export const CURL_LABEL = `${CURL_BIN}+cycletls(chrome131)`;

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
let cycleTLS = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function mentionsUrl(mint, limit) {
  return (
    'https://gmgn.ai/vas/api/v1/twitter/token/search?keyword=' +
    encodeURIComponent(mint) +
    '&limit=' +
    encodeURIComponent(limit)
  );
}

function httpError(httpCode, bodyHead) {
  const err = new Error(`HTTP_${httpCode}`);
  err.httpCode = httpCode;
  err.bodyHead = String(bodyHead || '').slice(0, 160);
  return err;
}

async function getCycleTLS() {
  if (!cycleTLS) cycleTLS = await initCycleTLS();
  return cycleTLS;
}

/** Stops the CycleTLS daemon (call on server shutdown). */
export async function closeMentions() {
  if (cycleTLS) {
    const c = cycleTLS;
    cycleTLS = null;
    try { await c.exit(); } catch { /* already gone */ }
  }
}

/**
 * Primary fetch: Chrome131 TLS fingerprint via CycleTLS.
 * @returns {Promise<{httpCode: number, items: Array, method: string}>}
 */
async function browserMentions(mint, limit) {
  const client = await getCycleTLS();
  const resp = await client(mentionsUrl(mint, limit), {
    client: 'chrome131',
    headers: { Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9' },
  }, 'GET');
  const httpCode = Number(resp.status) || 0;
  if (httpCode !== 200) throw httpError(httpCode, typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data));
  // CycleTLS returns `data` already parsed when the body is JSON.
  let json = resp.data;
  if (typeof json === 'string') {
    try {
      json = JSON.parse(json);
    } catch {
      throw httpError(httpCode, json);
    }
  }
  if (!json || typeof json !== 'object') throw httpError(httpCode, JSON.stringify(json));
  return { httpCode, items: Array.isArray(json?.data) ? json.data : [], method: 'cycletls' };
}

/**
 * Fallback fetch: spawned curl with browser UA (works from Windows/Schannel;
 * blocked from Linux/OpenSSL, kept as a safety net + for local debugging).
 * @returns {Promise<{httpCode: number, items: Array, method: string}>}
 */
async function curlMentions(mint, limit, { proxy = '', timeoutSec = 15 } = {}) {
  const args = ['-s', '-m', String(timeoutSec), '-w', '\n%{http_code}',
    '-H', `User-Agent: ${CHROME_UA}`, '-H', 'Accept: application/json'];
  if (proxy) args.push('-x', proxy);
  args.push(mentionsUrl(mint, limit));

  const { stdout } = await pExecFile(CURL_BIN, args, {
    windowsHide: true,
    timeout: (timeoutSec + 5) * 1000,
    maxBuffer: 5 * 1024 * 1024,
  });
  const sep = stdout.lastIndexOf('\n');
  const body = sep >= 0 ? stdout.slice(0, sep) : stdout;
  const httpCode = Number(stdout.slice(sep + 1)) || 0;
  if (httpCode !== 200) throw httpError(httpCode, body);
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw httpError(httpCode, body);
  }
  return { httpCode, items: Array.isArray(json?.data) ? json.data : [], method: 'curl' };
}

/** Runs one fetch with the given method ('browser' | 'curl' | 'auto'). */
async function fetchOnce(mint, limit, method, proxy) {
  if (method === 'curl') return curlMentions(mint, limit, { proxy });
  if (method === 'browser') return browserMentions(mint, limit);
  try {
    return await browserMentions(mint, limit);
  } catch (err) {
    // Only fall back when CycleTLS itself failed, not on HTTP 403/429 —
    // retrying the same 403 through curl would just double the block.
    if (err.httpCode) throw err;
    return curlMentions(mint, limit, { proxy });
  }
}

/**
 * Diagnostic-only fetch: bypasses queue, cache and backoff, and reports the
 * raw HTTP status + body head + timing.
 * @param {string} mint
 * @param {{limit?: number, proxy?: string, method?: 'auto'|'browser'|'curl'}} opts
 */
export async function rawMentions(mint, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 10, 1), 50);
  const method = ['auto', 'browser', 'curl'].includes(opts.method) ? opts.method : 'auto';
  const start = Date.now();
  try {
    const { httpCode, items, method: used } = await fetchOnce(mint, limit, method, opts.proxy || '');
    return { ok: true, httpCode, method: used, items: items.length, elapsedMs: Date.now() - start, bodyHead: null };
  } catch (err) {
    return {
      ok: false,
      httpCode: err.httpCode ?? null,
      method,
      items: 0,
      elapsedMs: Date.now() - start,
      bodyHead: err.bodyHead || err.message,
    };
  }
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
        const result = await fetchOnce(task.mint, task.limit, task.method, task.proxy);
        task.resolve(result);
      } catch (err) {
        task.reject(err);
      }
    }
  } finally {
    pumping = false;
  }
}

function enqueue(mint, limit, method) {
  return new Promise((resolve, reject) => {
    queue.push({ mint, limit, method, resolve, reject });
    pump();
  });
}

/**
 * Fetches X/Twitter mentions for a token from GMGN (internal endpoint,
 * CycleTLS Chrome fingerprint). Cached for CACHE_TTL_MS; calls are serialized
 * at 1 req/s; 403/429 triggers a 60s backoff for all callers.
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
    const { items } = await enqueue(mint, limit, 'auto');
    cache.set(mint, { data: items, savedAt: Date.now() });
    return { items, cached: false };
  } catch (err) {
    if (err.httpCode === 403 || err.httpCode === 429 || err.message === 'BACKOFF' ||
        /timed? ?out/i.test(err.message || '')) {
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
    method: 'cycletls(chrome131) -> curl fallback',
  };
}
