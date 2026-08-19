import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SERVER_URL_KEY = 'trading-sim/server-url';
const DEVICE_ID_KEY = 'trading-sim/device-id';

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

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body != null ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body != null ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body != null ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};