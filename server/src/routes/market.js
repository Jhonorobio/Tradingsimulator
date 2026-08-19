import { Router } from 'express';
import { runMarket, runConfigCheck } from '../cli/gmgn.js';
import { fetchTrenches } from '../cli/args.js';
import { getMarketData, searchTokens } from '../services/jupiter.js';
import { getTokenInfo } from '../services/dexscreener.js';
import { cacheKey, withCache } from '../services/cache.js';

const router = Router();

const KLINE_RES = new Set(['30s', '1m', '5m', '15m', '1h', '4h', '1d']);
const TRENDING_SORTS = new Set([
  'default', 'swaps', 'marketcap', 'history_highest_market_cap', 'liquidity', 'volume',
  'holder_count', 'smart_degen_count', 'renowned_count', 'gas_fee', 'price',
  'change1m', 'change5m', 'change1h', 'creation_timestamp',
]);

function fail(res, err, status = 500) {
  const message = err?.message || String(err);
  if (process.env.NODE_ENV !== 'production') console.error('[market]', message);
  res.status(status).json({ error: message });
}

function cleanValue(v) {
  if (Array.isArray(v)) return v.map(cleanValue);
  return typeof v === 'string' ? v.trim() : v;
}

/**
 * GET /api/market/trenches
 * Query: chain, types[], filterPreset, sortBy, direction, limit, plus range flags.
 */
router.get('/trenches', async (req, res) => {
  try {
    const result = await fetchTrenches(req.query);
    res.json({ ...result, fetched_at: new Date().toISOString() });
  } catch (err) {
    fail(res, err, err?.status || 500);
  }
});

/**
 * GET /api/market/trending
 * Query: chain, interval, limit, orderBy, direction, platform[], filter[]
 */
router.get('/trending', async (req, res) => {
  try {
    const args = [];
    const chain = cleanValue(req.query.chain) || 'sol';
    args.push('--chain', chain);

    const interval = cleanValue(req.query.interval) || '1h';
    args.push('--interval', interval);

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    args.push('--limit', String(limit));

    if (req.query.orderBy) {
      if (!TRENDING_SORTS.has(req.query.orderBy)) throw Object.assign(new Error(`Unsupported orderBy: ${req.query.orderBy}`), { status: 400 });
      args.push('--order-by', req.query.orderBy);
    }
    if (req.query.direction) args.push('--direction', req.query.direction);

    if (req.query.platform) for (const p of [].concat(cleanValue(req.query.platform)).filter(Boolean)) args.push('--platform', p);
    if (req.query.filter) for (const f of [].concat(cleanValue(req.query.filter)).filter(Boolean)) args.push('--filter', f);

    const trendRanges = {
      minVolume: 'min-volume', maxVolume: 'max-volume',
      minLiquidity: 'min-liquidity', maxLiquidity: 'max-liquidity',
      minMarketcap: 'min-marketcap', maxMarketcap: 'max-marketcap',
      minHolderCount: 'min-holder-count', maxHolderCount: 'max-holder-count',
      minSmartDegenCount: 'min-smart-degen-count', maxSmartDegenCount: 'max-smart-degen-count',
      minRenownedCount: 'min-renowned-count', maxRenownedCount: 'max-renowned-count',
      maxInsiderRate: 'max-insider-rate', maxBundlerRate: 'max-bundler-rate',
      maxRugRatio: 'max-rug-ratio', minRugRatio: 'min-rug-ratio',
      maxCreated: 'max-created', minCreated: 'min-created',
    };
    for (const [key, flag] of Object.entries(trendRanges)) {
      if (req.query[key] != null && req.query[key] !== '') args.push(`--${flag}`, String(req.query[key]));
    }

    const json = await withCache(cacheKey('trending', args.join(' ')), 60, () =>
      runMarket('trending', args)
    );
    const list = json?.data?.rank ?? json?.rank ?? (Array.isArray(json) ? json : []);
    res.json({ list, fetched_at: new Date().toISOString() });
  } catch (err) {
    fail(res, err, err?.status || 500);
  }
});

/**
 * GET /api/market/kline
 * Query: chain, address, resolution, from, to
 */
router.get('/kline', async (req, res) => {
  try {
    const { address, resolution } = req.query;
    if (!address) throw Object.assign(new Error('address is required'), { status: 400 });
    if (!KLINE_RES.has(resolution)) throw Object.assign(new Error(`Unsupported resolution: ${resolution}`), { status: 400 });

    const chain = cleanValue(req.query.chain) || 'sol';
    const args = ['--chain', chain, '--address', String(address), '--resolution', resolution];
    if (req.query.from) args.push('--from', String(req.query.from));
    if (req.query.to) args.push('--to', String(req.query.to));

    const json = await withCache(cacheKey('kline', args.join(' ')), 30, () =>
      runMarket('kline', args)
    );
    const list = json?.data?.list ?? json?.list ?? (Array.isArray(json) ? json : []);
    res.json({ list, fetched_at: new Date().toISOString() });
  } catch (err) {
    fail(res, err, err?.status || 500);
  }
});

/**
 * GET /api/market/search?query=...&chain=...
 * gmgn-cli v1.5.2 has no `market search` command, so we use Jupiter's
 * Tokens API V2 search (name / symbol / mint). Wallet search is unavailable.
 */
router.get('/search', async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) throw Object.assign(new Error('query is required'), { status: 400 });
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const coins = await withCache(cacheKey('search', String(query), String(limit)), 300, () =>
      searchTokens(String(query), limit)
    );
    res.json({ coins, wallets: [], fetched_at: new Date().toISOString() });
  } catch (err) {
    fail(res, err, err?.status || 500);
  }
});

/**
 * GET /api/market/status — health check for gmgn config.
 */
router.get('/status', async (_req, res) => {
  const check = await runConfigCheck();
  res.json(check);
});

/**
 * GET /api/market/token/:chain/:address — combined Jupiter price/marketcap + Dexscreener info.
 */
router.get('/token/:chain/:address', async (req, res) => {
  try {
    const { chain, address } = req.params;
    const [dex, jup] = await Promise.allSettled([
      getTokenInfo(address),
      getMarketData(address),
    ]);

    const dexInfo = dex.status === 'fulfilled' ? dex.value : null;
    const jupInfo = jup.status === 'fulfilled' ? jup.value : null;

    const price = jupInfo?.price ?? dexInfo?.price ?? null;
    const marketCap = jupInfo?.marketCap ?? dexInfo?.marketCap ?? null;

    res.json({
      chain,
      address,
      name: dexInfo?.name ?? null,
      symbol: dexInfo?.symbol ?? null,
      logo: dexInfo?.logo ?? null,
      price,
      marketCap,
      supply: jupInfo?.supply ?? null,
      liquidity: dexInfo?.liquidity ?? 0,
      volume24h: dexInfo?.volume24h ?? 0,
      priceChange: dexInfo?.priceChange ?? null,
      holders: dexInfo?.holders ?? null,
      dex: dexInfo?.dex ?? null,
      dexPairs: dexInfo?.pairCount ?? 0,
      sources: { dex: !!dexInfo, jupiter: !!jupInfo },
    });
  } catch (err) {
    fail(res, err);
  }
});

export default router;