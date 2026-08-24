import crypto from 'node:crypto';

/**
 * Auto-calibrated GMGN clock offset.
 *
 * Reads the `Date` header from any GMGN response to calculate the exact
 * time difference between our local clock and GMGN's server. One request,
 * no guessing, no probing offsets.
 *
 * Usage:
 *   import { gmgnTimestamp } from './gmgn-clock.js';
 *   const ts = gmgnTimestamp();
 */

const API_HOST = 'https://openapi.gmgn.ai';
const CALIBRATION_INTERVAL_MS = 5 * 60 * 1000; // re-calibrate every 5 min
const REQUEST_TIMEOUT_MS = 10_000;

let cachedOffset = Number(process.env.GMGN_TIME_OFFSET) || 0;
let calibrated = false;
let calibrating = false;

export function gmgnTimestamp() {
  return Math.floor(Date.now() / 1000) - cachedOffset;
}

export function getOffset() {
  return cachedOffset;
}

export async function ensureCalibrated() {
  if (!calibrated && !calibrating) {
    await calibrate();
  }
  return cachedOffset;
}

/**
 * Makes a request to GMGN and reads the Date header to compute the offset.
 * We don't need auth or a valid timestamp — even a 401 carries the Date header.
 */
async function calibrate() {
  if (calibrating) return;
  calibrating = true;

  try {
    const { proxyConfigs } = await import('../stores.js');
    const all = proxyConfigs.getAll();
    const entries = Object.entries(all).filter(([, v]) => v?.url && v?.apiKey);

    if (entries.length === 0) {
      console.log('[gmgn-clock] No proxy configured — using env offset:', cachedOffset);
      calibrated = true;
      return;
    }

    // Try each proxy until we get a response with a Date header
    for (const [, cfg] of entries) {
      try {
        const offset = await measureOffset(cfg.url, cfg.apiKey);
        if (offset !== null) {
          const oldOffset = cachedOffset;
          cachedOffset = offset;
          calibrated = true;
          if (oldOffset !== offset) {
            console.log(`[gmgn-clock] Calibrated: offset ${oldOffset}s → ${offset}s`);
          } else {
            console.log(`[gmgn-clock] Offset confirmed: ${offset}s`);
          }
          return;
        }
      } catch {
        // try next proxy
      }
    }

    console.log('[gmgn-clock] Calibration failed — keeping offset:', cachedOffset);
    calibrated = true;
  } catch (err) {
    console.error('[gmgn-clock] Calibration error:', err.message);
    calibrated = true;
  } finally {
    calibrating = false;
  }
}

/**
 * Sends a lightweight request to GMGN through the proxy and reads the Date
 * header to calculate the offset. The request will likely return 401
 * (AUTH_TIMESTAMP_EXPIRED or AUTH_INVALID) but we don't care — the Date
 * header is always present in the response.
 */
async function measureOffset(proxyUrl, apiKey) {
  const { ProxyAgent, request } = await import('undici');
  const dispatcher = new ProxyAgent(proxyUrl, {
    connect: { timeout: 10_000, tls: { rejectUnauthorized: false } },
  });

  // Use any timestamp — we just need the Date header from the response
  const fakeTimestamp = Math.floor(Date.now() / 1000);
  const client_id = crypto.randomUUID();
  const url = `${API_HOST}/v1/trenches?chain=sol&timestamp=${fakeTimestamp}&client_id=${client_id}`;
  const body = JSON.stringify({ version: 'v2', new_creation: { limit: 1, filters: ['offchain', 'onchain'] } });
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'gmgn-cli/1.5.2',
    'X-APIKEY': apiKey,
    Accept: 'application/json',
  };

  const res = await request(url, {
    dispatcher,
    method: 'POST',
    body,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // Read the Date header — GMGN always returns it regardless of auth status
  const gmgnDateStr = res.headers?.date || res.headers?.Date;
  if (!gmgnDateStr) return null;

  const gmgnTimeMs = Date.parse(gmgnDateStr);
  if (!Number.isFinite(gmgnTimeMs)) return null;

  const gmgnTimeSec = Math.floor(gmgnTimeMs / 1000);
  const localTimeSec = Math.floor(Date.now() / 1000);
  const offset = localTimeSec - gmgnTimeSec;

  console.log(`[gmgn-clock] GMGN time: ${gmgnDateStr} (${gmgnTimeSec})`);
  console.log(`[gmgn-clock] Local time: ${new Date().toISOString()} (${localTimeSec})`);
  console.log(`[gmgn-clock] Difference: ${offset}s (local is ${offset >= 0 ? 'ahead' : 'behind'})`);

  return offset;
}

// Auto-calibrate at startup (1s delay to let stores load)
setTimeout(() => {
  calibrate().catch(() => {});
}, 1000);

// Periodic re-calibration
setInterval(() => {
  calibrate().catch(() => {});
}, CALIBRATION_INTERVAL_MS);
