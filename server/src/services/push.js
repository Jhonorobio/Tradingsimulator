const PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_ENDPOINT = 'https://exp.host/--/api/v2/push/getReceipts';

/**
 * Sends a push notification through the Expo Push API.
 * @param {string} token - Expo push token (ExponentPushToken[...])
 * @param {{ title, body, data? }} payload
 * @returns {{ ticketId: string|null, result: object }} receipt ticket for later verification
 */
export async function sendPush(token, { title, body, data = {} }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(PUSH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to: token, title, body, data }),
      signal: controller.signal,
    });
    const result = await res.json();
    return { ticketId: result?.data?.id || null, result };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendPushes(entries) {
  const chunks = [];
  for (let i = 0; i < entries.length; i += 100) chunks.push(entries.slice(i, i + 100));
  const results = [];
  for (const chunk of chunks) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(PUSH_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(chunk),
        signal: controller.signal,
      });
      results.push(await res.json());
    } finally {
      clearTimeout(timer);
    }
  }
  return results.flat();
}

/**
 * Validate / normalize an Expo push token. Returns null if invalid.
 */
export function isValidPushToken(token) {
  return typeof token === 'string' && /^ExponentPushToken\[[A-Za-z0-9-]+\]$/.test(token);
}

/**
 * Checks push receipt tickets from Expo. Returns a Set of device IDs
 * whose push tokens should be removed (DeviceNotRegistered or InvalidCredentials).
 * @param {string[]} ticketIds - receipt ticket IDs from sendPush responses
 * @param {Map<string,string>} ticketToDevice - maps ticketId → device_id
 * @returns {Promise<Set<string>>} device IDs to remove
 */
export async function checkReceipts(ticketIds, ticketToDevice) {
  if (!ticketIds.length) return new Set();

  const invalidDevices = new Set();

  // Check in chunks of 100 (Expo limit)
  for (let i = 0; i < ticketIds.length; i += 100) {
    const chunk = ticketIds.slice(i, i + 100);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(RECEIPTS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ids: chunk }),
        signal: controller.signal,
      });
      const receipts = await res.json();
      if (receipts?.data) {
        for (const [ticketId, receipt] of Object.entries(receipts.data)) {
          if (receipt?.status === 'error') {
            const err = receipt.details?.error;
            // DeviceNotRegistered = token is stale, InvalidCredentials = token invalid
            if (err === 'DeviceNotRegistered' || err === 'InvalidCredentials') {
              const deviceId = ticketToDevice.get(ticketId);
              if (deviceId) invalidDevices.add(deviceId);
            }
          }
        }
      }
    } catch {
      // Receipt check failed — skip, will retry next cycle
    } finally {
      clearTimeout(timer);
    }
  }

  return invalidDevices;
}