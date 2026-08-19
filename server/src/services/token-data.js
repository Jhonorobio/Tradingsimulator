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
 * Full token info: GMGN proxy first (dedicated 2nd key), Dexscreener fallback.
 * Cached 15s on disk. Returns a unified shape (see gmgn-proxy.js) or null.
 * @param {string} chain
 * @param {string} address
 */
export async function getTokenInfo(chain, address) {
  return withCache(cacheKey('token', chain, address), 15, async () => {
    const proxy = await getProxyTokenInfo(chain, address);
    if (proxy?.price != null) return proxy;
    const dex = await getDexTokenInfo(address);
    return normalizeDex(dex);
  });
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
 * Batch USD prices for many mints. Each mint is resolved via GMGN proxy first
 * (dedicated 2nd key), falling back to Dexscreener batches. Dexscreener results
 * are cached 15s.
 * @param {string[]} mints
 * @returns {Promise<Record<string, number|null>>}
 */
export async function getPrices(mints) {
  const ids = [...new Set(mints.filter(Boolean))];
  if (!ids.length) return {};
  const out = {};
  const missing = [];

  const resolved = await Promise.all(
    ids.map(async (m) => {
      const info = await withCache(cacheKey('token-price', m), 15, () =>
        getProxyTokenInfo('sol', m)
      );
      return { m, info };
    })
  );
  for (const { m, info } of resolved) {
    if (info?.price != null) out[m] = info.price;
    else missing.push(m);
  }

  if (missing.length) {
    const dexInfos = await getDexTokensInfo(missing); // order-preserving
    missing.forEach((m, i) => {
      const dex = dexInfos[i];
      out[m] = dex?.price != null ? Number(dex.price) : null;
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
  return prices[mint] ?? null;
}