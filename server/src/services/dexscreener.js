const BASE_URL = 'https://api.dexscreener.com/latest/dex';
import { cacheKey, withCache } from './cache.js';

async function fetchJson(url, timeout = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Dexscreener HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches token info from Dexscreener. Picks the pair with the most liquidity.
 * @returns {{ address, name, symbol, logo, price, marketCap, liquidity, volume, holders, pairs } | null}
 */
export async function getTokenInfo(address) {
  return withCache(cacheKey('dexscreener', address), 15, async () => {
    const json = await fetchJson(`${BASE_URL}/tokens/${encodeURIComponent(address)}`);
    const pairs = json?.pairs ?? [];
    if (!pairs.length) return null;

    pairs.sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));
    const best = pairs[0];
    const baseToken = best.baseToken ?? {};

    return {
      address: baseToken.address ?? address,
      chain: best.chainId ?? null,
      dex: best.dexId ?? null,
      name: baseToken.name ?? null,
      symbol: baseToken.symbol ?? null,
      logo: baseToken.icon ?? best.info?.imageUrl ?? null,
      price: best.priceUsd != null ? Number(best.priceUsd) : null,
      priceNative: best.priceNative ?? null,
      marketCap: best.marketCap != null ? Number(best.marketCap) : null,
      liquidity: Number(best.liquidity?.usd) || 0,
      fdv: best.fdv != null ? Number(best.fdv) : null,
      volume24h: Number(best.volume?.h24) || 0,
      priceChange: {
        m5: Number(best.priceChange?.m5) || 0,
        h1: Number(best.priceChange?.h1) || 0,
        h6: Number(best.priceChange?.h6) || 0,
        h24: Number(best.priceChange?.h24) || 0,
      },
      txns24h: {
        buys: Number(best.txns?.h24?.buys) || 0,
        sells: Number(best.txns?.h24?.sells) || 0,
      },
      holders: null, // Dexscreener does not expose holders
      pairAddress: best.pairAddress ?? null,
      pairCount: pairs.length,
    };
  });
}

/**
 * Searches tokens by name / symbol / mint via Dexscreener's search endpoint.
 * @returns {Array<{address,name,symbol,logo,chain,price,market_cap,liquidity,volume24h,priceChange,created_timestamp}>}
 */
export async function searchTokens(query, limit = 20) {
  const json = await fetchJson(`${BASE_URL}/search?q=${encodeURIComponent(query)}`);
  const pairs = json?.pairs ?? [];
  const seen = new Map();
  for (const pair of pairs) {
    const addr = pair.baseToken?.address;
    if (!addr || seen.has(addr)) continue;
    seen.set(addr, mapPair(pair));
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

/**
 * Batch fetch for many addresses at once (max 30 per request).
 */
export async function getTokensInfo(addresses) {
  const results = [];
  for (let i = 0; i < addresses.length; i += 30) {
    const chunk = addresses.slice(i, i + 30);
    try {
      const json = await fetchJson(`${BASE_URL}/tokens/${chunk.join(',')}`);
      const pairs = json?.pairs ?? [];
      const byAddress = new Map();
      for (const pair of pairs) {
        const addr = pair.baseToken?.address;
        if (!addr) continue;
        const current = byAddress.get(addr);
        const liq = Number(pair.liquidity?.usd) || 0;
        if (!current || liq > (Number(current.liquidity) || 0)) byAddress.set(addr, pair);
      }
      for (const addr of chunk) {
        const pair = byAddress.get(addr);
        results.push(pair ? mapPair(pair) : null);
      }
    } catch {
      for (const _ of chunk) results.push(null);
    }
  }
  return results;
}

function mapPair(pair) {
  const baseToken = pair.baseToken ?? {};
  return {
    address: baseToken.address,
    chain: pair.chainId ?? null,
    dex: pair.dexId ?? null,
    name: baseToken.name ?? null,
    symbol: baseToken.symbol ?? null,
    logo: baseToken.icon ?? pair.info?.imageUrl ?? null,
    price: pair.priceUsd != null ? Number(pair.priceUsd) : null,
    marketCap: pair.marketCap != null ? Number(pair.marketCap) : null,
    liquidity: Number(pair.liquidity?.usd) || 0,
    volume24h: Number(pair.volume?.h24) || 0,
    priceChange: {
      m5: Number(pair.priceChange?.m5) || 0,
      h1: Number(pair.priceChange?.h1) || 0,
      h6: Number(pair.priceChange?.h6) || 0,
      h24: Number(pair.priceChange?.h24) || 0,
    },
  };
}