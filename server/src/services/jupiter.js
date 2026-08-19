const BASE_URL = 'https://api.jup.ag';
import { cacheKey, withCache } from './cache.js';

// Client-side throttle: keep bursts within the plan's RPS (Free tier = 1 RPS).
const MAX_RPS = Math.max(0.1, Number(process.env.JUPITER_MAX_RPS) || 1);
const MIN_INTERVAL_MS = Math.floor(1000 / MAX_RPS);
let lastRequestAt = 0;

async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, lastRequestAt + MIN_INTERVAL_MS - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function fetchJson(url, timeout = 10_000, retries = 3) {
  await throttle();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = { Accept: 'application/json' };
  if (process.env.JUPITER_API_KEY) headers['x-api-key'] = process.env.JUPITER_API_KEY;
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (res.status === 429 && retries > 0) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const waitMs = reset ? Math.max(0, reset * 1000 - Date.now()) : 1000;
      await new Promise((r) => setTimeout(r, waitMs));
      return fetchJson(url, timeout, retries - 1);
    }
    if (!res.ok) throw new Error(`Jupiter HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Current USD price via Price API V3 (falls back to deprecated V2).
 * @returns {{ price: number, decimals: number, liquidity: number, priceChange24h: number } | null}
 */
export async function getPrice(mint) {
  try {
    const json = await fetchJson(`${BASE_URL}/price/v3?ids=${encodeURIComponent(mint)}`);
    const entry = json?.[mint];
    if (entry) {
      return {
        price: entry.usdPrice != null ? Number(entry.usdPrice) : null,
        decimals: entry.decimals ?? null,
        liquidity: entry.liquidity ?? null,
        priceChange24h: entry.priceChange24h ?? null,
      };
    }
  } catch {
    // fall through to V2
  }
  try {
    const json = await fetchJson(`${BASE_URL}/price/v2?ids=${encodeURIComponent(mint)}`);
    const entry = json?.data?.[mint];
    if (entry?.price != null) {
      return { price: Number(entry.price), decimals: null, liquidity: null, priceChange24h: null };
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Batch USD prices for many mints in a single request (Price API V3).
 * @param {string[]} mints
 * @returns {Promise<Record<string, number|null>>}
 */
export async function getPrices(mints) {
  const ids = [...new Set(mints.filter(Boolean))];
  if (!ids.length) return {};
  const url = `${BASE_URL}/price/v3?ids=${encodeURIComponent(ids.join(','))}`;
  try {
    const json = await fetchJson(url);
    return Object.fromEntries(
      ids.map((m) => [m, json?.[m]?.usdPrice != null ? Number(json[m].usdPrice) : null])
    );
  } catch {
    return Object.fromEntries(ids.map((m) => [m, null]));
  }
}

/**
 * Token metadata + supply from Tokens API V2 (query by mint).
 * @returns {{ mint, name, symbol, icon, decimals, circSupply, totalSupply, holderCount } | null}
 */
export async function getToken(mint) {
  const json = await fetchJson(`${BASE_URL}/tokens/v2/search?query=${encodeURIComponent(mint)}`);
  const item = Array.isArray(json) ? json[0] : json;
  if (!item) return null;
  return {
    mint: item.id ?? mint,
    name: item.name ?? null,
    symbol: item.symbol ?? null,
    icon: item.icon ?? null,
    decimals: item.decimals ?? 0,
    circSupply: item.circSupply != null ? Number(item.circSupply) : null,
    totalSupply: item.totalSupply != null ? Number(item.totalSupply) : null,
    holderCount: item.holderCount ?? null,
  };
}

/**
 * Searches tokens by name / symbol / mint via the Tokens API V2.
 * The installed gmgn-cli has no `market search` command, so this replaces it.
 * @returns {Array<{address,name,symbol,logo,chain,price,market_cap,liquidity,total_supply,holder_count,created_timestamp}>}
 */
export async function searchTokens(query, limit = 20) {
  const json = await fetchJson(`${BASE_URL}/tokens/v2/search?query=${encodeURIComponent(query)}`);
  const list = Array.isArray(json) ? json : [];
  return list.slice(0, limit).map((t) => ({
    address: t.id ?? null,
    name: t.name ?? null,
    symbol: t.symbol ?? null,
    logo: t.icon ?? null,
    chain: 'sol',
    price: t.usdPrice != null ? Number(t.usdPrice) : null,
    market_cap: t.mcap != null ? Number(t.mcap) : null,
    liquidity: t.liquidity != null ? Number(t.liquidity) : null,
    total_supply: t.totalSupply != null ? Number(t.totalSupply) : null,
    holder_count: t.holderCount ?? null,
    created_timestamp: t.createdAt ? Math.floor(new Date(t.createdAt).getTime() / 1000) : undefined,
    open_source: t.audit?.openSource ?? undefined,
  }));
}

/**
 * Computes price + market cap via Jupiter:
 * marketCap = usdPrice * circulatingSupply.
 * Falls back to totalSupply when circSupply is missing.
 */
export async function getMarketData(mint) {
  return withCache(cacheKey('jupiter', mint), 15, async () => {
    const [priceRes, tokenRes] = await Promise.allSettled([getPrice(mint), getToken(mint)]);
    const price = priceRes.status === 'fulfilled' ? priceRes.value : null;
    const token = tokenRes.status === 'fulfilled' ? tokenRes.value : null;

    const supply = token?.circSupply ?? token?.totalSupply ?? null;
    const marketCap = price?.price != null && supply != null ? price.price * supply : null;

    return {
      price: price?.price ?? null,
      marketCap,
      supply,
      decimals: token?.decimals ?? price?.decimals ?? null,
      liquidity: price?.liquidity ?? null,
      priceChange24h: price?.priceChange24h ?? null,
      name: token?.name ?? null,
      symbol: token?.symbol ?? null,
      icon: token?.icon ?? null,
      holderCount: token?.holderCount ?? null,
    };
  });
}