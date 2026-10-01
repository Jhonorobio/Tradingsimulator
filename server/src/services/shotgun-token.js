/**
 * shotgun.fun token info — replacement for the GMGN token-detail proxy.
 *
 * REST: GET https://api.shotgun.fun/solana/tokens/{mint}/info?network=SOLANA
 * Auth: cookie `session_token` (short-lived, ~15min JWT). On 401 we rotate it
 * via POST /auth/session/refresh with the cookie `refresh_token` (~30d),
 * exactly like the official frontend does.
 *
 * Credentials come from env (exported once from a logged-in browser session):
 *   SHOTGUN_SESSION_TOKEN, SHOTGUN_REFRESH_TOKEN
 * Without them every call is a no-null (callers fall back to Dexscreener).
 *
 * Rate posture: a single detail screen tops out around 0.7 req/s (detail poll
 * 5s + price poller 2s) and shotgun tolerated 5+ req/s and 20-way bursts in
 * load tests — we still keep a per-address 1.2s dedupe cache plus a 300ms
 * global floor as a politeness margin.
 */

const API_HOST = 'https://api.shotgun.fun';
const ORIGIN = 'https://app.shotgun.fun';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

const PER_TOKEN_TTL_MS = 1_200;
const GLOBAL_MIN_GAP_MS = 300;
const REFRESH_BACKOFF_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

let sessionToken = (process.env.SHOTGUN_SESSION_TOKEN || '').trim();
let refreshToken = (process.env.SHOTGUN_REFRESH_TOKEN || '').trim();
let sessionDead = false;
let lastRefreshAttempt = 0;
let lastGlobalCall = 0;
let lastRefreshError = null;
let upstreamCalls = 0;

const resultCache = new Map(); // address -> { info, at }
const inflight = new Map(); // address -> Promise

export function getShotgunStatus() {
  return {
    configured: Boolean(refreshToken || sessionToken),
    session: Boolean(sessionToken),
    sessionDead,
    lastRefreshError,
    upstreamCalls,
    cachedTokens: resultCache.size,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pct(v) {
  const n = num(v);
  return n == null ? null : n / 100;
}

function dataHeaders(extra = {}) {
  return {
    accept: '*/*',
    cookie: `session_token=${sessionToken}`,
    origin: ORIGIN,
    referer: `${ORIGIN}/`,
    'user-agent': USER_AGENT,
    ...extra,
  };
}

/**
 * Rotate the session using the refresh cookie. Stores whatever pair of
 * cookies the server hands back (session_token is always short-lived;
 * refresh_token is rotated too when a new one is issued).
 * @returns {Promise<boolean>} true if we still have a session afterwards
 */
async function refreshSession() {
  if (!refreshToken) return false;
  const now = Date.now();
  if (sessionDead && now - lastRefreshAttempt < REFRESH_BACKOFF_MS) return Boolean(sessionToken);
  lastRefreshAttempt = now;
  try {
    const res = await fetch(`${API_HOST}/auth/session/refresh`, {
      method: 'POST',
      headers: {
        accept: '*/*',
        cookie: `refresh_token=${refreshToken}`,
        origin: ORIGIN,
        referer: `${ORIGIN}/`,
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: '{}',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const setCookies =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    let gotSession = false;
    for (const raw of setCookies) {
      const m = /^\s*([^=;]+)=([^;]*)/.exec(raw);
      if (!m) continue;
      const name = m[1].trim();
      const value = m[2].trim();
      if (name === 'session_token' && value) {
        sessionToken = value;
        gotSession = true;
      } else if (name === 'refresh_token' && value) {
        refreshToken = value;
      }
    }
    if (res.status === 401 || res.status === 403) {
      sessionDead = true;
      lastRefreshError = `refresh ${res.status}`;
      return false;
    }
    if (!gotSession && !sessionToken) {
      lastRefreshError = `refresh ${res.status} without session_token`;
      return false;
    }
    sessionDead = false;
    lastRefreshError = null;
    return true;
  } catch (err) {
    // Network hiccup: keep the current session, retry on the next 401.
    lastRefreshError = err?.message || 'refresh failed';
    return Boolean(sessionToken);
  }
}

async function rawInfo(address) {
  return fetch(
    `${API_HOST}/solana/tokens/${encodeURIComponent(address)}/info?network=SOLANA`,
    { headers: dataHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
}

function mapInfo(address, j) {
  const pool = j?.pool;
  if (!pool) return null;
  const md = j.metadata || {};
  const holders = j.holders || {};
  const risk = j.risk || {};
  const socials = md.socials || {};
  const createdSec = num(md.created_time);
  return {
    address,
    chain: 'sol',
    source: 'shotgun',
    name: md.name ?? null,
    symbol: md.symbol ?? null,
    logo: md.image ?? null,
    price: num(pool.price),
    marketCap: num(pool.market_cap),
    supply: num(pool.supply),
    liquidity: num(pool.liquidity) ?? 0,
    volume24h: num(pool.volume_24h) ?? 0,
    holders: num(holders.count),
    dex: pool.market ?? null,
    priceChange: null, // shotgun has no % windows; the detail UI does not render it
    // Extras the GMGN detail path never filled (TokenDetail already has them).
    top10HolderRate: pct(holders.top_10_percent),
    bundlerRate: pct(holders.bundlers_percent),
    devTeamHoldRate: pct(holders.dev_percent),
    sniperCount: Array.isArray(risk.snipers) ? risk.snipers.length : null,
    rugRatio: num(risk.score) == null ? null : num(risk.score) / 100,
    renouncedMint: pool.no_mint === true ? 1 : pool.no_mint === false ? 0 : null,
    twitter: md.twitter ?? socials.xUrl ?? null,
    telegram: md.telegram ?? socials.telegramUrl ?? socials.telegramHandle ?? null,
    website: md.website ?? socials.website ?? null,
    createdTimestamp: createdSec == null ? null : Math.round(createdSec * 1000),
  };
}

async function requestInfo(address) {
  if (!sessionToken) return null;

  // Per-address dedupe: overlapping pollers (detail 5s + price 2s) reuse the
  // last upstream payload instead of burning quota.
  const cached = resultCache.get(address);
  if (cached && Date.now() - cached.at < PER_TOKEN_TTL_MS) return cached.info;

  // Global politeness floor.
  const wait = lastGlobalCall + GLOBAL_MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastGlobalCall = Date.now();
  upstreamCalls++;

  let res = await rawInfo(address);
  if (res.status === 401) {
    const ok = await refreshSession();
    if (!ok) return null;
    lastGlobalCall = Date.now();
    res = await rawInfo(address);
  }
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`shotgun info ${res.status}`);
  const json = await res.json().catch(() => null);
  const info = mapInfo(address, json);
  resultCache.set(address, { info, at: Date.now() });
  if (resultCache.size > 200) resultCache.delete(resultCache.keys().next().value);
  return info;
}

/**
 * Token info from shotgun.fun (detail-shaped, same intermediate contract as
 * the old GMGN proxy). Returns null when there is no session configured, the
 * token is unknown upstream, or the session is dead — callers fall back to
 * Dexscreener.
 * @param {string} address mint address (Solana only)
 * @returns {Promise<object|null>}
 */
export function fetchShotgunInfo(address) {
  if (!address) return Promise.resolve(null);
  let p = inflight.get(address);
  if (!p) {
    p = requestInfo(address)
      .catch(() => {
        // Memoize failures for the same 1.2s window so a flapping upstream is
        // not hammered by the 1s detail poll. Errors surface as "no data" —
        // every caller falls back to Dexscreener.
        resultCache.set(address, { info: null, at: Date.now() });
        return null;
      })
      .finally(() => inflight.delete(address));
    inflight.set(address, p);
  }
  return p;
}
