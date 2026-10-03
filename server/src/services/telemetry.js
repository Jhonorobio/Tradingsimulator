/**
 * Telemetry (app.telemetry.io) market_data client — exposes `trading_bot_holders`
 * per token for the Bonus timeline.
 *
 * Auth: short-lived data_access_token (30 min) minted from the `refresh_token`
 * cookie via POST /v1/auth/refresh. Seed it with TELEMETRY_REFRESH_TOKEN;
 * rotations persist to DATA_DIR/telemetry-auth.json so restarts keep working.
 * Telemetry does not do reuse detection — old refresh tokens keep working, so
 * sharing the session with the browser is safe.
 */

import fs from 'node:fs';
import path from 'node:path';

const HOST = 'app.telemetry.io';
const BASE = `https://${HOST}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

const INFO_TTL_MS = 300_000; // trading_bot_holders changes slowly
const MIN_GAP_MS = 1_000;
const MAX_GAP_MS = 120_000;
const CONCURRENCY = 3;
const BACKOFF_BASE_MS = 180_000;
const BACKOFF_MAX_MS = 900_000;
const TOKEN_MARGIN_MS = 5 * 60_000; // refresh the data token 5 min before expiry
const TOKEN_MIN_GAP_MS = 30_000; // at most one refresh attempt per 30 s

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, '..', '..', 'data'));
const AUTH_FILE = path.join(DATA_DIR, 'telemetry-auth.json');

const cache = new Map(); // mint -> { botHolders, at } (all-null = negative)
const pending = new Map(); // mint -> true (queued)
let timer = null;
let running = false;
let backoffUntil = 0;
let backoffMs = BACKOFF_BASE_MS;
let gapMs = MIN_GAP_MS;
let lastStatus = null;
let lastError = null;
let lastTokenRefreshAt = 0;
let refreshInFlight = null;

// ---- token store -----------------------------------------------------------

let auth = {};
try {
  auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
} catch {
  auth = {};
}
if (!auth.refresh_token && process.env.TELEMETRY_REFRESH_TOKEN) {
  auth = { refresh_token: process.env.TELEMETRY_REFRESH_TOKEN, data_token: null, data_exp: 0 };
}

function saveAuth() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(AUTH_FILE, JSON.stringify(auth));
  } catch (e) {
    lastError = `auth persist: ${e.message}`;
  }
}

/** Returns a valid data_access_token, refreshing it when within the margin. */
async function ensureDataToken(force = false) {
  const now = Date.now();
  if (!force && auth.data_token && Number(auth.data_exp || 0) - TOKEN_MARGIN_MS > now) {
    return auth.data_token;
  }
  if (now - lastTokenRefreshAt < TOKEN_MIN_GAP_MS && auth.data_token && !force) return auth.data_token;
  if (!auth.refresh_token) return null;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    lastTokenRefreshAt = Date.now();
    try {
      const r = await fetch(`${BASE}/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-length': '0',
          origin: BASE,
          referer: `${BASE}/`,
          'user-agent': UA,
          cookie: `refresh_token=${auth.refresh_token}`,
        },
      });
      lastStatus = r.status;
      if (!r.ok) {
        lastError = `refresh HTTP ${r.status}`;
        return auth.data_token || null;
      }
      for (const sc of r.headers.getSetCookie?.() || []) {
        const [pair] = sc.split(';');
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        if (name === 'refresh_token' && value) auth.refresh_token = value;
        else if (name === 'data_access_token' && value) auth.data_token = value;
        else if (name === 'data_access_token_expiry') auth.data_exp = Number(value) * 1000;
      }
      saveAuth();
      lastError = null;
      return auth.data_token || null;
    } catch (e) {
      lastError = `refresh: ${e.message}`;
      return auth.data_token || null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

// ---- data fetch ------------------------------------------------------------

async function fetchEntry(mint, retried = false) {
  const token = await ensureDataToken();
  if (!token) throw new Error('telemetry: no data token');
  const r = await fetch(`${BASE}/data/market_data/${mint}`, {
    headers: {
      accept: 'application/json, text/plain, */*',
      authorization: `Bearer ${token}`,
      'user-agent': UA,
      referer: `${BASE}/trading/${mint}`,
    },
  });
  lastStatus = r.status;
  if (r.status === 401 && !retried) {
    // Stale data token → mint a fresh one and retry once.
    const fresh = await ensureDataToken(true);
    if (fresh) return fetchEntry(mint, true);
    throw new Error('telemetry: token refresh failed');
  }
  if (r.status === 404 || r.status === 400) return null; // unknown/invalid mint
  if (r.status === 401) throw new Error('telemetry: unauthorized');
  if (r.status === 429 || r.status < 200 || r.status >= 300) {
    noteRateLimited();
    throw new Error(`telemetry HTTP ${r.status}`);
  }
  try {
    const j = await r.json();
    noteSuccess();
    const v = typeof j.trading_bot_holders === 'number' ? j.trading_bot_holders : null;
    return { botHolders: v };
  } catch {
    return null;
  }
}

function noteRateLimited() {
  backoffUntil = Date.now() + backoffMs;
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  gapMs = Math.min(gapMs * 2, MAX_GAP_MS);
}

function noteSuccess() {
  backoffMs = BACKOFF_BASE_MS;
  gapMs = Math.max(MIN_GAP_MS, gapMs - 1_000);
}

// ---- public API ------------------------------------------------------------

/** Last-known telemetry snapshot for a mint (ignores TTL — reads are free). */
export function getTelemetrySnapshot(mint) {
  const hit = cache.get(mint);
  if (!hit || hit.botHolders == null) return null;
  return { botHolders: hit.botHolders };
}

/** Fire-and-forget: queues a background fetch (deduped, spaced, backed off). */
export function prefetchTelemetry(mint) {
  if (!mint) return;
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < INFO_TTL_MS) return;
  if (pending.has(mint)) return;
  pending.set(mint, true);
  if (!timer) timer = setTimeout(run, 0);
}

async function run() {
  timer = null;
  if (running) return;
  if (Date.now() < backoffUntil) {
    timer = setTimeout(run, backoffUntil - Date.now() + 1_000);
    return;
  }
  const batch = [];
  while (batch.length < CONCURRENCY && pending.size) {
    const next = pending.keys().next().value;
    pending.delete(next);
    batch.push(next);
  }
  if (!batch.length) return;
  running = true;
  try {
    await Promise.allSettled(batch.map(async (mint) => {
      try {
        const entry = await fetchEntry(mint);
        if (entry) cache.set(mint, { ...entry, at: Date.now() });
        else cache.set(mint, { botHolders: null, at: Date.now() }); // negative cache
      } catch (e) {
        lastError = String(e?.message || e);
        pending.set(mint, true); // retry later
      }
    }));
  } finally {
    running = false;
  }
  if (pending.size) timer = setTimeout(run, gapMs);
}

/** Diagnostics for the status endpoint. */
export function getTelemetryStatus() {
  return {
    configured: Boolean(auth.refresh_token),
    tokenExpiresAt: auth.data_exp ? new Date(auth.data_exp).toISOString() : null,
    cached: cache.size,
    pending: pending.size,
    rateLimitedUntil: backoffUntil > Date.now() ? new Date(backoffUntil).toISOString() : null,
    gapMs,
    lastStatus,
    lastError,
  };
}
