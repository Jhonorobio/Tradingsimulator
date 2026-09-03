import { cacheKey, withCache } from './cache.js';
import { getProxyTokenInfo } from './gmgn-proxy.js';
import { getTokenInfo as getDexTokenInfo, getTokensInfo as getDexTokensInfo } from './dexscreener.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

function normalizeDex(info) {
  if (!info) return null;
  return {
    address: info.address,
    chain: info.chain ?? 'sol',
    source: 'dexscreener',
    name: info.name ?? null,
    symbol: info.symbol ?? null,
    logo: info.logo ?? null,
    price: info.price ?? null,
    marketCap: info.marketCap ?? null,
    supply: null,
    liquidity: info.liquidity ?? 0,
    volume24h: info.volume24h ?? 0,
    holders: info.holders ?? null,
    dex: info.dex ?? null,
    priceChange: info.priceChange ?? null,
  };
}

/**
 * Full token info: GMGN direct first, Dexscreener fallback.
 * No disk cache — the client controls poll frequency (3s).
 * @param {string} chain
 * @param {string} address
 */
export async function getTokenInfo(chain, address) {
  const proxy = await getProxyTokenInfo(chain, address);
  if (proxy?.price != null) return proxy;
  const dex = await getDexTokenInfo(address);
  return normalizeDex(dex);
}

/**
 * Live token info for fast polls (no disk cache; supply handled internally).
 * GMGN proxy first, Dexscreener fallback.
 * @param {string} chain
 * @param {string} address
 */
export async function getLiveTokenInfo(chain, address) {
  const proxy = await getProxyTokenInfo(chain, address);
  if (proxy?.price != null) return proxy;
  const dex = await getDexTokenInfo(address);
  return normalizeDex(dex);
}

/**
 * Batched price/market-cap lookup for multiple mints. Uses GMGN proxy
 * (dedicated 2nd key, one request that yields both price and market cap),
 * falling back to Dexscreener batches. Dexscreener results are cached 15s.
 * @param {Array<{address: string, chain?: string}>|string[]} mints - array of {address, chain} or bare addresses (defaults to 'sol')
 * @returns {Promise<Record<string, { price: number|null, marketCap: number|null } | null>>}
 */
export async function getPrices(mints) {
  const normalized = mints.map((m) => typeof m === 'string' ? { address: m, chain: 'sol' } : m);
  const ids = [...new Set(normalized.map((m) => m.address).filter(Boolean))];
  if (!ids.length) return {};
  const chainMap = Object.fromEntries(normalized.map((m) => [m.address, m.chain || 'sol']));
  const out = {};
  const missing = [];

  const resolved = await Promise.all(
    ids.map(async (m) => {
      const info = await withCache(cacheKey('token-price', m), 1, () =>
        getProxyTokenInfo(chainMap[m], m)
      );
      return { m, info };
    })
  );
  for (const { m, info } of resolved) {
    if (info?.price != null) out[m] = { price: info.price, marketCap: info.marketCap ?? null };
    else missing.push(m);
  }

  if (missing.length) {
    const dexInfos = await getDexTokensInfo(missing); // order-preserving
    missing.forEach((m, i) => {
      const dex = dexInfos[i];
      out[m] = dex?.price != null
        ? { price: Number(dex.price), marketCap: dex.marketCap != null ? Number(dex.marketCap) : null }
        : null;
    });
  }
  return out;
}

/**
 * Single USD price for a mint (GMGN proxy, Dexscreener fallback).
 * @param {string} mint
 * @returns {Promise<number|null>}
 */
export async function getPrice(mint) {
  const prices = await getPrices([mint]);
  return prices[mint]?.price ?? null;
}