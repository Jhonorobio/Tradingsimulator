/**
 * FOMO (fomo.family) authentication — Privy customer access tokens.
 *
 * The FOMO WebSocket (`wss://prod-api.fomo.family/ws`) challenges every new
 * connection and expects a Privy customer access token in `challengeResponse`
 * (aud `cm6h485o300n3zj9yl6vpedq7` — FOMO's Privy app). Those tokens live
 * 1h; a long-lived refresh token mints new ones without any user session:
 *
 *   POST https://auth.privy.io/api/v1/sessions
 *   headers: privy-app-id, origin: https://fomo.family
 *   body: { refresh_token }
 *   → { token, refresh_token?, session_update_action }
 *
 * Verified in production: `session_update_action` is `"ignore"` and no new
 * refresh_token comes back — the same refresh token can be reused forever
 * (until the user logs out of fomo.family), so there is no rotation state to
 * persist. Credentials live in `server/data/fomo-auth.json` (gitignored,
 * holds the original `refresh_token`), overridable with the FOMO_REFRESH_TOKEN
 * env var for deployments without the data file.
 */
import { JsonStore } from '../json-store.js';

const PRIVY_APP_ID = 'cm6h485o300n3zj9yl6vpedq7'; // FOMO's Privy app (jwt `aud`)
const SESSIONS_URL = 'https://auth.privy.io/api/v1/sessions';
const REFRESH_TIMEOUT_MS = 15_000;
/** Refresh the access token when less than this much of its 1h life remains. */
const MIN_REMAINING_MS = 120_000;

const store = new JsonStore('fomo-auth');

let accessToken = null;
let accessExpMs = 0;
let inflight = null;

function decodeExp(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    return Number(payload.exp) * 1000 || 0;
  } catch {
    return 0;
  }
}

/** Refresh token from env (deployments) or the local data file. */
export function getRefreshToken() {
  return process.env.FOMO_REFRESH_TOKEN || store.get('refresh_token') || null;
}

export function hasCredentials() {
  return Boolean(getRefreshToken());
}

/**
 * A Privy customer access token valid for the next ~2 minutes at least.
 * Single-flight: concurrent callers share one in-flight refresh.
 */
export function getAccessToken({ force = false } = {}) {
  if (!force && accessToken && Date.now() < accessExpMs - MIN_REMAINING_MS) {
    return Promise.resolve(accessToken);
  }
  if (inflight) return inflight;

  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    return Promise.reject(new Error('FOMO: no refresh token (data/fomo-auth.json or FOMO_REFRESH_TOKEN)'));
  }

  inflight = (async () => {
    try {
      const res = await fetch(SESSIONS_URL, {
        method: 'POST',
        headers: {
          'privy-app-id': PRIVY_APP_ID,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          origin: 'https://fomo.family',
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.token) {
        throw new Error(`FOMO refresh failed: HTTP ${res.status} ${body?.error || body?.code || ''}`.trim());
      }
      accessToken = body.token;
      accessExpMs = decodeExp(body.token) || Date.now() + 3_600_000;
      // Defensive: Privy may rotate someday (`session_update_action: "set"`).
      if (typeof body.refresh_token === 'string' && body.refresh_token && body.refresh_token !== refreshToken) {
        store.set('refresh_token', body.refresh_token);
        store.set('updated_at', new Date().toISOString());
      }
      return accessToken;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** Drop the cached token — next call force-mints (used after auth failures). */
export function invalidateAccessToken() {
  accessToken = null;
  accessExpMs = 0;
}

/** Save a refresh token (e.g. seeded manually into a deployment). */
export function setRefreshToken(token) {
  store.set('refresh_token', token);
  store.set('updated_at', new Date().toISOString());
  invalidateAccessToken();
}

/** Diagnostics for GET /api/market/fomo/status. Never exposes the token. */
export function fomoAuthStatus() {
  return {
    hasRefreshToken: hasCredentials(),
    hasCachedToken: Boolean(accessToken),
    tokenExpiresAt: accessExpMs || null,
    tokenExpiresInSeconds: accessExpMs ? Math.max(0, Math.round((accessExpMs - Date.now()) / 1000)) : null,
  };
}
