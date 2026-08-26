import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SERVER_URL_KEY = 'trading-sim/server-url';
const DEVICE_ID_KEY = 'trading-sim/device-id';
const PUSH_TOKEN_KEY = 'trading-sim/push-token';

/** Derive the backend host from the Metro bundler host when available. */
function deriveDefaultUrl() {
  const explicit = process.env.EXPO_PUBLIC_API_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    const host = hostUri.split(':')[0];
    if (host) return `http://${host}:4000`;
  }
  return 'http://localhost:4000';
}

export async function getServerUrl(): Promise<string> {
  const stored = await AsyncStorage.getItem(SERVER_URL_KEY);
  if (stored) return stored.replace(/\/+$/, '');
  const fallback = deriveDefaultUrl();
  await AsyncStorage.setItem(SERVER_URL_KEY, fallback);
  return fallback;
}

export async function setServerUrl(url: string): Promise<void> {
  await AsyncStorage.setItem(SERVER_URL_KEY, url.replace(/\/+$/, ''));
}

export async function getDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (id) return id;
  id = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  return id;
}

export async function getPersistedPushToken(): Promise<string | null> {
  return AsyncStorage.getItem(PUSH_TOKEN_KEY);
}

export async function setPersistedPushToken(token: string | null): Promise<void> {
  if (token) {
    await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
  } else {
    await AsyncStorage.removeItem(PUSH_TOKEN_KEY);
  }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = await getServerUrl();
  const deviceId = await getDeviceId();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': deviceId,
        ...init.headers,
      },
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new ApiError(body?.error || `HTTP ${res.status}`, res.status);
    }
    return body as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(`No se pudo conectar con el servidor (${base}). Revisa Settings → Server URL.`, 0);
  } finally {
    clearTimeout(timer);
  }
}

/** Streaming POST — reads NDJSON lines, calling onLine for each. */
async function postStream(path: string, body: unknown, onLine: (line: any) => void): Promise<void> {
  const base = await getServerUrl();
  const deviceId = await getDeviceId();
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new ApiError(err?.error || `HTTP ${res.status}`, res.status);
  }
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        try { onLine(JSON.parse(trimmed)); } catch {}
      }
    }
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body != null ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body != null ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body != null ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  postStream,
};