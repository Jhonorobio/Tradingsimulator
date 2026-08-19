import { Router } from 'express';
import { runMarket, runConfigCheck } from '../cli/gmgn.js';
import { fetchTrenches } from '../cli/args.js';
import { db } from '../db.js';
import { getTokenInfo as getDexTokenInfo, searchTokens as dexSearch } from '../services/dexscreener.js';
import { findToken } from '../services/trenches-store.js';
import { getProxyMarketCap } from '../services/gmgn-proxy.js';
import { getTokenInfo, getLiveTokenInfo, getPrices, SOL_MINT } from '../services/token-data.js';
import { cacheKey, withCache } from '../services/cache.js';

const router = Router();

function deviceId(req) {
  return req.headers['x-device-id'] || req.params.deviceId || '';
}

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
 * GET /api/market/trenches/filters — saved per-device trenches filters.
 * Header: X-Device-Id
 */
router.get('/trenches/filters', (req, res) => {
  const id = deviceId(req);
  if (!id) return fail(res, new Error('X-Device-Id header is required'), 400);
  try {
    const row = db.prepare('SELECT filters FROM trenches_filters WHERE device_id = ?').get(id);
    res.json({ filters: row ? JSON.parse(row.filters) : null });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * PUT /api/market/trenches/filters — save per-device trenches filters.
 * Header: X-Device-Id · Body: { filters }
 */
router.put('/trenches/filters', (req, res) => {
  const id = deviceId(req);
  if (!id) return fail(res, new Error('X-Device-Id header is required'), 400);
  try {
    const raw = req.body?.filters;
    if (raw == null) return fail(res, new Error('filters is required'), 400);
    const json = JSON.stringify(raw);
    db.prepare(
      `INSERT INTO trenches_filters (device_id, filters, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(device_id) DO UPDATE SET filters = excluded.filters, updated_at = excluded.updated_at`
    ).run(id, json);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * GET /api/market/search?query=...&chain=...
 * gmgn-cli v1.5.2 has no `market search` command, so we use Dexscreener's
 * search endpoint (name / symbol / mint). Wallet search is unavailable.
 */
router.get('/search', async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) throw Object.assign(new Error('query is required'), { status: 400 });
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const coins = await withCache(cacheKey('search', String(query), String(limit)), 300, () =>
      dexSearch(String(query), limit)
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

/** Looks up a token in the in-memory trenches store (no GMGN call). */
function findInTrenches(chain, address) {
  return findToken(address);
}

/**
 * GET /api/market/sol-price — current SOL price (GMGN proxy, Dexscreener
 * fallback). Lightweight endpoint for the dashboard's live poll.
 */
router.get('/sol-price', async (req, res) => {
  try {
    const info = await getLiveTokenInfo('sol', SOL_MINT);
    res.json({ sol_price: info?.price ?? null, source: info?.source ?? null });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * GET /api/market/prices?addresses=mint1,mint2,... — batch USD prices via GMGN
 * proxy (dedicated 2nd key) with Dexscreener fallback.
 * SOL is always included in the result.
 * Returns { prices: { mint: number|null } }.
 */
router.get('/prices', async (req, res) => {
  try {
    const raw = req.query.addresses;
    const mints = [].concat(cleanValue(raw)).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
    const all = [...new Set([...mints, SOL_MINT])];
    if (!all.length) return fail(res, new Error('addresses is required'), 400);
    const prices = await getPrices(all);
    res.json({ prices, fetched_at: new Date().toISOString() });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * GET /api/market/token/:chain/:address — token detail.
 * Prefers GMGN trenches data when the token is in trenches (fast, cached 3s);
 * otherwise GMGN proxy (dedicated 2nd key) with Dexscreener fallback.
 */
router.get('/token/:chain/:address', async (req, res) => {
  try {
    const { chain, address } = req.params;

    const trench = findInTrenches(chain, address);
    if (trench) {
      return res.json({
        chain,
        address,
        name: trench.name ?? null,
        symbol: trench.symbol ?? null,
        logo: trench.logo ?? null,
        price: trench.price ?? null,
        marketCap: trench.usd_market_cap ?? trench.market_cap ?? null,
        supply: trench.total_supply ?? null,
        liquidity: trench.liquidity ?? 0,
        volume24h: trench.volume_24h ?? 0,
        priceChange: null,
        holders: trench.holder_count ?? null,
        dex: trench.launchpad_platform ?? null,
        dexPairs: 0,
        sources: { dex: false, gmgn: false, trenches: true },
      });
    }

    const info = await getTokenInfo(chain, address);
    if (!info) throw Object.assign(new Error('Token not found'), { status: 404 });

    res.json({
      chain,
      address,
      name: info.name ?? null,
      symbol: info.symbol ?? null,
      logo: info.logo ?? null,
      price: info.price ?? null,
      marketCap: info.marketCap ?? null,
      supply: info.supply ?? null,
      liquidity: info.liquidity ?? 0,
      volume24h: info.volume24h ?? 0,
      priceChange: info.priceChange ?? null,
      holders: info.holders ?? null,
      dex: info.dex ?? null,
      dexPairs: 0,
      sources: { dex: info.source === 'dexscreener', gmgn: info.source === 'gmgn', trenches: false },
    });
  } catch (err) {
    fail(res, err, err?.status || 500);
  }
});

/**
 * GET /api/market/token/:chain/:address/live — fresh GMGN-proxy price +
 * marketcap (no 15s cache), falling back to Dexscreener. Polled every 2s.
 */
router.get('/token/:chain/:address/live', async (req, res) => {
  try {
    const { chain, address } = req.params;
    const info = await getLiveTokenInfo(chain, address);
    res.json({
      price: info?.price ?? null,
      marketCap: info?.marketCap ?? null,
      supply: info?.supply ?? null,
      liquidity: info?.liquidity ?? null,
      priceChange24h: info?.priceChange?.h24 ?? null,
      source: info?.source ?? null,
    });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * GET /api/market/token/:chain/:address/mcap — market cap via the GMGN proxy
 * (dedicated 2nd API key), falling back to Dexscreener on any proxy failure.
 * Polled every 1s by the app.
 */
router.get('/token/:chain/:address/mcap', async (req, res) => {
  try {
    const { chain, address } = req.params;
    const proxyMc = await getProxyMarketCap(chain, address);
    if (proxyMc != null) {
      return res.json({ marketCap: proxyMc, source: 'gmgn' });
    }
    const dex = await getDexTokenInfo(address);
    res.json({ marketCap: dex?.marketCap ?? null, source: 'dexscreener' });
  } catch (err) {
    fail(res, err);
  }
});

export default router;