const PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

/**
 * Sends a push notification through the Expo Push API.
 * @param {string} token - Expo push token (ExponentPushToken[...])
 * @param {{ title, body, data? }} payload
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
    return await res.json();
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