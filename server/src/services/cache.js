import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), 'data', 'cache');
const inflight = new Map();

function filePath(key) {
  return path.join(CACHE_DIR, `${key}.json`);
}

/** Deterministic key from any number of string parts. */
export function cacheKey(...parts) {
  return createHash('sha1').update(parts.filter(Boolean).join('|')).digest('hex');
}

/** Returns cached data if present and not older than ttlSeconds, else null. */
export function readCache(key, ttlSeconds) {
  try {
    const entry = JSON.parse(readFileSync(filePath(key), 'utf8'));
    if (Date.now() - entry.savedAt <= ttlSeconds * 1000) return entry.data;
  } catch {
    // miss or unreadable entry
  }
  return null;
}

/** Writes data to disk (best-effort). */
export function writeCache(key, data) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(filePath(key), JSON.stringify({ savedAt: Date.now(), data }), 'utf8');
  } catch {
    // best effort
  }
}

/**
 * Returns fresh cached data, otherwise runs fetcher, stores the result and
 * returns it. Concurrent callers for the same key share a single fetch.
 */
export async function withCache(key, ttlSeconds, fetcher) {
  const hit = readCache(key, ttlSeconds);
  if (hit !== null) return hit;
  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    const data = await fetcher();
    if (data !== null && data !== undefined) writeCache(key, data);
    return data;
  })();
  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

/** Force-removes a key from disk and in-flight state. */
export function invalidateCache(key) {
  try {
    inflight.delete(key);
    require('node:fs').unlinkSync(filePath(key));
  } catch {
    // nothing to invalidate
  }
}