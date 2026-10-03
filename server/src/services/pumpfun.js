/**
 * Pump.fun advanced-indexer client — exposes `numKolsTraded` per mint.
 *
 * GET https://advanced-indexer.pump.fun/in-memory-coin/<mint>
 * Public endpoint (no auth), browser-impersonated headers, brotli body.
 * Same discipline as the Axiom client: one request in flight, adaptive gap,
 * exponential backoff — the value feeds snapshot enrichment only for tokens
 * that already have an open track.
 */

import http2 from 'node:http2';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

const HOST = 'advanced-indexer.pump.fun';
const ORIGIN = `https://${HOST}`;

const INFO_TTL_MS = 15 * 60_000; // KOL count changes slowly
const MIN_GAP_MS = 5_000;
const MAX_GAP_MS = 120_000;
const BACKOFF_BASE_MS = 180_000;
const BACKOFF_MAX_MS = 900_000;

const cache = new Map(); // mint -> { kols, at }
const pending = new Map(); // mint -> true (queued)
let timer = null;
let backoffUntil = 0;
let backoffMs = BACKOFF_BASE_MS;
let gapMs = MIN_GAP_MS;
let lastStatus = null;
let lastError = null;

function apiHeaders() {
  return {
    accept: '*/*',
    'accept-encoding': 'identity', // skip brotli — Node http2 doesn't decode it
    'accept-language': 'es-US,es;q=0.9,en-US;q=0.8,en;q=0.7,es-419;q=0.6',
    origin: 'https://pump.fun',
    priority: 'u=1, i',
    'sec-ch-ua': '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  };
}

let session = null;
function h2Session() {
  if (session && !session.closed && !session.destroyed) return session;
  session = http2.connect(ORIGIN);
  session.on('error', () => {
    try {
      session.destroy();
    } catch {
      /* already gone */
    }
    session = null;
  });
  return session;
}

function request(path) {
  const s = h2Session();
  return new Promise((resolve, reject) => {
    const req = s.request({
      ':method': 'GET',
      ':path': path,
      ':authority': HOST,
      ':scheme': 'https',
      ...apiHeaders(),
    });
    const t = setTimeout(() => {
      req.close(http2.constants.NGHTTP2_CANCEL);
      reject(new Error('pump timeout'));
    }, 25_000);
    let status = 0;
    let enc = '';
    const chunks = [];
    req.on('response', (h) => {
      status = h[':status'] || 0;
      enc = h['content-encoding'] || '';
    });
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      clearTimeout(t);
      let body = Buffer.concat(chunks);
      try {
        if (enc.includes('br')) body = brotliDecompressSync(body);
        else if (enc.includes('gzip')) body = gunzipSync(body);
        else if (enc.includes('deflate')) body = inflateSync(body);
      } catch {
        /* identity or undecodable — try as-is */
      }
      resolve({ status, body: body.toString('utf8') });
    });
    req.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    req.end();
  });
}

function noteRateLimited() {
  backoffUntil = Date.now() + backoffMs;
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  gapMs = Math.min(gapMs * 2, MAX_GAP_MS);
}

function noteSuccess() {
  backoffMs = BACKOFF_BASE_MS;
  gapMs = Math.max(MIN_GAP_MS, gapMs - 5_000);
}

/** GET /in-memory-coin/<mint> → numKolsTraded (null when unknown). */
async function fetchKols(mint) {
  const res = await request(`/in-memory-coin/${mint}`);
  lastStatus = res.status;
  if (res.status === 429 || res.status === 425) {
    noteRateLimited();
    throw new Error(`pump throttled (${res.status})`);
  }
  if (res.status === 404) return null; // mint unknown to the indexer
  if (res.status < 200 || res.status >= 300) {
    noteRateLimited();
    throw new Error(`pump HTTP ${res.status}`);
  }
  try {
    const j = JSON.parse(res.body);
    const kols = typeof j?.numKolsTraded === 'number' ? j.numKolsTraded : null;
    noteSuccess();
    return kols;
  } catch {
    return null;
  }
}

/** Synchronous cache lookup — never touches the network. */
export function getKolsTraded(mint) {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < INFO_TTL_MS) return hit.kols;
  return null;
}

/** Fire-and-forget: queues a background fetch (deduped, spaced, backed off). */
export function prefetchKolsTraded(mint) {
  if (!mint) return;
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < INFO_TTL_MS) return;
  if (pending.has(mint)) return;
  pending.set(mint, true);
  if (!timer) timer = setTimeout(run, 0);
}

async function run() {
  timer = null;
  const next = pending.keys().next();
  if (next.done) return;
  const mint = next.value;
  pending.delete(mint);
  try {
    if (Date.now() < backoffUntil) {
      pending.set(mint, true);
      timer = setTimeout(run, backoffUntil - Date.now() + 1_000);
      return;
    }
    const kols = await fetchKols(mint);
    if (kols != null) cache.set(mint, { kols, at: Date.now() });
    else cache.set(mint, { kols: null, at: Date.now() }); // negative cache
  } catch (e) {
    lastError = String(e?.message || e);
    noteRateLimited(); // transient network failure → pause too
    pending.set(mint, true); // retry after the backoff window
  }
  if (pending.size) timer = setTimeout(run, gapMs);
}

/** Diagnostics for the status log. */
export function getPumpStatus() {
  return {
    cached: cache.size,
    pending: pending.size,
    rateLimitedUntil: backoffUntil > Date.now() ? new Date(backoffUntil).toISOString() : null,
    gapMs,
    lastStatus,
    lastError,
  };
}
