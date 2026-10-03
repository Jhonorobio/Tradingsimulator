/**
 * Axiom token-info-v2 client.
 *
 * Auth: the API reads a short-lived `auth-access-token` cookie (JWT, ~16 min).
 * We keep the long-lived `auth-refresh-token` (400 days, does not rotate) in
 * AXIOM_REFRESH_TOKEN and POST /refresh-access-token to mint a fresh access
 * token before it expires.
 *
 * The API only accepts `pairAddress` (pool, never mint) — callers may pass a
 * known pool, otherwise we resolve mint → top pool by liquidity through
 * Dexscreener. Axiom rate-limits aggressively (HTTP 425) and rotates hosts
 * (the browser itself has been seen hitting api2/api3), so we keep a host
 * pool and rotate on 425 before falling back to a backoff.
 *
 * Transport: Axiom rate-limits (425) anything speaking HTTP/1.1 — Node's
 * undici fetch AND curl both get blocked while the browser stays at 200.
 * The browser talks HTTP/2, so we do too: node:http2 is the primary
 * transport (one session per host), curl then fetch as fallbacks.
 */

import { execFile as execFileCb } from 'node:child_process';
import http2 from 'node:http2';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFile = promisify(execFileCb);

const HOSTS = [
  'https://api2.axiom.trade',
  'https://api3.axiom.trade',
  'https://api6.axiom.trade',
  'https://api7.axiom.trade',
  'https://api8.axiom.trade',
  'https://api9.axiom.trade',
  'https://api10.axiom.trade',
  'https://api.axiom.trade',
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

const ACCESS_SKEW_MS = 60_000; // refresh 1 min before JWT exp
const INFO_TTL_MS = 10 * 60_000; // token-info freshness (bucket is tiny)
const PAIR_TTL_MS = 6 * 60 * 60_000; // mint→pair rarely changes
const PAIR_NEGATIVE_TTL_MS = 10 * 60_000; // unknown pairs retry later
const MIN_GAP_MS = 5_000; // h2 is unlimited in practice; 425 backoff still guards it
const MAX_GAP_MS = 120_000;
const MAX_HOST_TRIES = 2; // a 425 is IP-wide — never burn the whole host pool
const BACKOFF_BASE_MS = 180_000; // first 425 backoff, doubles up to 15 min
const BACKOFF_MAX_MS = 900_000;

const infoCache = new Map(); // mint -> { data, at }
const pairCache = new Map(); // mint -> { pair: string|null, at }
const pendingPrefetch = new Map(); // mint -> pairHint|null

let accessToken = '';
let accessExpiresAt = 0;
let refreshPromise = null;
let prefetchTimer = null;
let backoffUntil = 0;
let backoffMs = BACKOFF_BASE_MS;
let gapMs = MIN_GAP_MS;
let hostIdx = 0;
let lastRefreshAt = 0;
let lastError = null;
let lastStatus = null;
let lastTransport = null;

function host() {
  return HOSTS[hostIdx];
}

function rotateHost() {
  hostIdx = (hostIdx + 1) % HOSTS.length;
  return HOSTS[hostIdx];
}

/** 425 = the shared IP bucket is empty: back off (exponentially) and slow down. */
function noteRateLimited() {
  backoffUntil = Date.now() + backoffMs;
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  gapMs = Math.min(gapMs * 2, MAX_GAP_MS);
}

/** Success: recover a bit faster than we slowed down. */
function noteSuccess() {
  backoffMs = BACKOFF_BASE_MS;
  gapMs = Math.max(MIN_GAP_MS, gapMs - 5_000);
}

function apiHeaders(cookie) {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'es-419,es;q=0.9',
    origin: 'https://axiom.trade',
    referer: 'https://axiom.trade/',
    'user-agent': UA,
    'sec-ch-ua': '"Chromium";v="154", "Google Chrome";v="154", "Not?A_Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    cookie,
  };
}

function decodeJwtExp(jwt) {
  try {
    const json = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    return json.exp ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

let curlOk = null;

async function hasCurl() {
  if (curlOk !== null) return curlOk;
  try {
    await execFile('curl', ['--version'], { windowsHide: true });
    curlOk = true;
  } catch {
    curlOk = false;
  }
  return curlOk;
}

/** One reusable HTTP/2 session per host (like the browser's connection). */
const h2Sessions = new Map(); // origin -> ClientHttp2Session

function h2Session(origin) {
  let session = h2Sessions.get(origin);
  if (session && !session.closed && !session.destroyed) return session;
  session = http2.connect(origin);
  h2Sessions.set(origin, session);
  session.on('error', () => {
    h2Sessions.delete(origin);
    try {
      session.destroy();
    } catch {
      /* already gone */
    }
  });
  return session;
}

/** HTTP/2 request; returns { status, setCookies, body }. */
function h2Http(origin, url, method, headers) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const session = h2Session(origin);
    const req = session.request({
      ':method': method,
      ':path': u.pathname + u.search,
      ':authority': u.host,
      ':scheme': 'https',
      ...headers,
    });
    const timer = setTimeout(() => {
      req.close(http2.constants.NGHTTP2_CANCEL);
      reject(new Error('h2 timeout'));
    }, 25_000);
    let status = 0;
    let setCookies = [];
    let body = '';
    req.on('response', (h) => {
      status = h[':status'] || 0;
      const raw = h['set-cookie'] || [];
      setCookies = (Array.isArray(raw) ? raw : [raw]).map((c) => `set-cookie: ${c}`);
    });
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      clearTimeout(timer);
      resolve({ status, setCookies, body });
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      h2Sessions.delete(origin);
      try {
        session.destroy();
      } catch {
        /* already gone */
      }
      reject(e);
    });
    req.end();
  });
}

/** GET/POST via child-process curl; returns { status, setCookies, body }. */
async function curlHttp(method, url, headers) {
  const dir = await mkdtemp(path.join(tmpdir(), 'axiom-'));
  const bodyFile = path.join(dir, 'body');
  const hdrFile = path.join(dir, 'hdr');
  try {
    const args = [
      '-sS', '--max-time', '25', '-X', method,
      '-o', bodyFile, '-D', hdrFile, '-w', '%{http_code}',
      '-A', UA,
    ];
    for (const [k, v] of Object.entries(headers)) {
      if (v != null) args.push('-H', `${k}: ${v}`);
    }
    args.push(url);
    const { stdout } = await execFile('curl', args, { windowsHide: true });
    const status = Number.parseInt(String(stdout).trim(), 10) || 0;
    const headerText = await readFile(hdrFile, 'utf8').catch(() => '');
    const body = await readFile(bodyFile, 'utf8').catch(() => '');
    const setCookies = headerText.split(/\r?\n/).filter((l) => /^set-cookie:/i.test(l));
    return { status, setCookies, body };
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Request via HTTP/2 first (the only transport Axiom doesn't rate-limit). */
async function http(method, url, headers) {
  try {
    lastTransport = 'h2';
    return await h2Http(new URL(url).origin, url, method, headers);
  } catch (e) {
    lastTransport = `h2-error:${String(e?.message || e).slice(0, 60)}`;
  }
  if (await hasCurl()) {
    try {
      lastTransport = 'curl';
      return await curlHttp(method, url, headers);
    } catch (e) {
      lastTransport = `curl-error:${String(e?.message || e).slice(0, 60)}`;
    }
  }
  lastTransport = 'fetch';
  const res = await fetch(url, { method, headers });
  const body = await res.text();
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, setCookies, body };
}

/** Extract "name=value" from a Set-Cookie header line. */
function cookiePair(setCookieLine, name) {
  const m = setCookieLine.match(new RegExp(`^set-cookie:\\s*(${name}=[^;\\r\\n]+)`, 'i'));
  return m ? m[1] : null;
}

/** POST /refresh-access-token — mints a new access token cookie (no rotation). */
async function refreshAccessToken() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const rt = process.env.AXIOM_REFRESH_TOKEN;
    if (!rt) throw new Error('AXIOM_REFRESH_TOKEN not set');
    let res = null;
    // 425 is IP-wide: try at most two hosts, then back off.
    for (let i = 0; i < MAX_HOST_TRIES; i++) {
      res = await http('POST', `${host()}/refresh-access-token`, {
        ...apiHeaders(`auth-refresh-token=${rt}`),
        'content-type': 'application/json',
      });
      if (res.status !== 425) break;
      rotateHost();
    }
    if (res.status === 425) {
      noteRateLimited();
      throw new Error('axiom refresh rate limited (425)');
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`axiom refresh HTTP ${res.status}`);
    }
    const at = res.setCookies.map((l) => cookiePair(l, 'auth-access-token')).find(Boolean);
    if (!at) throw new Error('axiom refresh: no auth-access-token cookie');
    accessToken = at; // "auth-access-token=<jwt>"
    accessExpiresAt = decodeJwtExp(accessToken.split('=')[1]) || Date.now() + 14 * 60_000;
    lastRefreshAt = Date.now();
    lastError = null;
    noteSuccess();
    return accessToken;
  })()
    .catch((e) => {
      lastError = String(e?.message || e);
      throw e;
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

async function getAuthCookie() {
  if (!accessToken || Date.now() > accessExpiresAt - ACCESS_SKEW_MS) await refreshAccessToken();
  return accessToken;
}

/**
 * GET /token-info-v2?pairAddress=<pool>&v=2
 * Returns { numHolders, numBotUsers, top10HoldersPercent, ... } or null when
 * Axiom has no data for the pair. Throws on auth/network failures.
 */
async function fetchTokenInfo(pair) {
  let cookie = await getAuthCookie();
  let res = null;
  for (let i = 0; i < MAX_HOST_TRIES; i++) {
    const url = `${host()}/token-info-v2?pairAddress=${encodeURIComponent(pair)}&v=2`;
    res = await http('GET', url, apiHeaders(cookie));
    if (res.status === 401 && i === 0) {
      // Access token rotated/expired — refresh once and retry.
      cookie = await refreshAccessToken();
      res = await http('GET', url, apiHeaders(cookie));
    }
    if (res.status !== 425) break;
    rotateHost();
  }
  if (res.status === 425) {
    noteRateLimited();
    throw new Error('axiom rate limited (425)');
  }
  lastStatus = res.status;
  if (res.status === 404) return null; // pair unknown to Axiom
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`axiom token-info HTTP ${res.status}`);
  }
  let data = null;
  try {
    data = JSON.parse(res.body);
  } catch {
    return null;
  }
  if (data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length > 0) {
    noteSuccess();
    return data;
  }
  return null;
}

/** Mint → top Solana pool (by liquidity) via Dexscreener; cached. */
async function resolvePair(mint) {
  const hit = pairCache.get(mint);
  if (hit && Date.now() - hit.at < (hit.pair ? PAIR_TTL_MS : PAIR_NEGATIVE_TTL_MS)) {
    return hit.pair;
  }
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  if (!res.ok) throw new Error(`dexscreener HTTP ${res.status}`);
  const json = await res.json();
  const pairs = (json.pairs || [])
    .filter((p) => p.chainId === 'solana')
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const pair = pairs[0]?.pairAddress || null;
  pairCache.set(mint, { pair, at: Date.now() });
  return pair;
}

/** Synchronous cache lookup — never touches the network. */
export function getAxiomInfo(mint) {
  const hit = infoCache.get(mint);
  if (hit && Date.now() - hit.at < INFO_TTL_MS) return hit.data;
  return null;
}

/**
 * Fire-and-forget: queues a background fetch for this mint (deduped, spaced
 * by an adaptive gap, paused while rate-limited). Safe to call every minute.
 */
export function prefetchAxiomInfo(mint, pairHint = null) {
  if (!mint || !process.env.AXIOM_REFRESH_TOKEN) return;
  const hit = infoCache.get(mint);
  if (hit && Date.now() - hit.at < INFO_TTL_MS) return;
  if (pendingPrefetch.has(mint)) return;
  pendingPrefetch.set(mint, pairHint || null);
  if (!prefetchTimer) prefetchTimer = setTimeout(runPrefetch, 0);
}

async function runPrefetch() {
  prefetchTimer = null;
  const next = pendingPrefetch.entries().next();
  if (next.done) return;
  const [mint, pairHint] = next.value;
  pendingPrefetch.delete(mint);
  try {
    if (Date.now() < backoffUntil) {
      // Rate limited — keep the entry queued and retry after the backoff.
      pendingPrefetch.set(mint, pairHint);
      prefetchTimer = setTimeout(runPrefetch, backoffUntil - Date.now() + 1_000);
      return;
    }
    const pair = pairHint || await resolvePair(mint);
    if (pair) {
      const data = await fetchTokenInfo(pair);
      if (data) infoCache.set(mint, { data, at: Date.now() });
    }
  } catch (e) {
    lastError = String(e?.message || e);
  }
  if (pendingPrefetch.size) prefetchTimer = setTimeout(runPrefetch, gapMs);
}

/** Diagnostics for the status endpoint. */
export function getAxiomStatus() {
  return {
    configured: Boolean(process.env.AXIOM_REFRESH_TOKEN),
    host: host(),
    accessExpiresAt: accessExpiresAt ? new Date(accessExpiresAt).toISOString() : null,
    lastRefreshAt: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : null,
    cached: infoCache.size,
    pending: pendingPrefetch.size,
    rateLimitedUntil: backoffUntil > Date.now() ? new Date(backoffUntil).toISOString() : null,
    gapMs,
    backoffMs,
    lastTransport,
    lastStatus,
    lastError,
  };
}
