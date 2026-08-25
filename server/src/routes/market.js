import { Router } from 'express';
import { runMarket, runConfigCheck } from '../cli/gmgn.js';
import { fetchTrenches } from '../cli/args.js';
import { trenchesFilters, proxyConfigs } from '../stores.js';
import { getTokenInfo as getDexTokenInfo, searchTokens as dexSearch } from '../services/dexscreener.js';
import { findToken } from '../services/trenches-store.js';
import { suppressBroadcast, unsuppressBroadcast } from '../services/trenches-store.js';
import { getProxyMarketCap } from '../services/gmgn-proxy.js';
import { getTokenInfo, getLiveTokenInfo, getPrices, SOL_MINT } from '../services/token-data.js';
import { cacheKey, withCache } from '../services/cache.js';
import { buildParamsFromConfig, TRENCH_TABS } from '../services/trenches-filters.js';
import { connectionForTab } from '../services/trenches-refresher.js';
import { testProxy, getAllStatus, checkAllProxies } from '../services/proxy-health.js';

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

const VALID_TABS = ['new_creation', 'near_completion', 'completed', 'token_info'];

/**
 * GET /api/market/proxies — returns saved proxy configs for all 3 tabs.
 */
router.get('/proxies', (_req, res) => {
  const configs = {};
  for (const tab of VALID_TABS) {
    const entry = proxyConfigs.get(tab);
    configs[tab] = entry ? { url: entry.url || '', apiKey: entry.apiKey || '' } : { url: '', apiKey: '' };
  }
  res.json(configs);
});

/**
 * PUT /api/market/proxies — save proxy config for a tab.
 * Body: { tab, url, apiKey }
 */
router.put('/proxies', (req, res) => {
  const { tab, url, apiKey } = req.body || {};
  if (!VALID_TABS.includes(tab)) return fail(res, new Error('Invalid tab'), 400);
  if (!url || !apiKey) return fail(res, new Error('url and apiKey are required'), 400);
  proxyConfigs.set(tab, { url: String(url).trim(), apiKey: String(apiKey).trim() });
  res.json({ ok: true });
});

/**
 * POST /api/market/proxies/test — test a proxy without saving it.
 * Body: { url, apiKey }
 */
router.post('/proxies/test', async (req, res) => {
  const { url, apiKey } = req.body || {};
  if (!url || !apiKey) return fail(res, new Error('url and apiKey are required'), 400);
  try {
    const result = await testProxy(String(url).trim(), String(apiKey).trim());
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});

/**
 * POST /api/market/proxies/batch-test — test a list of proxies via real GMGN API.
 * Streams results as NDJSON. No egress IP resolution (faster, closer to production).
 * Body: { proxies: string[], apiKey: string }
 */
router.post('/proxies/batch-test', async (req, res) => {
  const { proxies, apiKey } = req.body || {};
  if (!Array.isArray(proxies) || !apiKey) {
    return fail(res, new Error('proxies (array) and apiKey are required'), 400);
  }
  if (proxies.length === 0) return res.json({ results: [] });

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const { ProxyAgent, request } = await import('undici');
  const { gmgnTimestamp } = await import('../services/gmgn-clock.js');

  for (const raw of proxies) {
    const proxy = String(raw).trim();
    if (!proxy) continue;
    const url = proxy.startsWith('http') || proxy.startsWith('socks')
      ? proxy
      : `http://${proxy}`;
    const start = Date.now();
    try {
      const dispatcher = new ProxyAgent(url, {
        connect: { timeout: 5_000, tls: { rejectUnauthorized: false } },
      });
      const timestamp = gmgnTimestamp();
      const client_id = crypto.randomUUID();
      const apiUrl = `https://openapi.gmgn.ai/v1/trenches?chain=sol&timestamp=${timestamp}&client_id=${client_id}`;
      const body = JSON.stringify({
        version: 'v2',
        new_creation: { limit: 1, filters: ['offchain', 'onchain'] },
      });
      const r = await request(apiUrl, {
        dispatcher,
        method: 'POST',
        body,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'gmgn-cli/1.5.2',
          'X-APIKEY': apiKey,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(8_000),
      });
      const latencyMs = Date.now() - start;
      const text = await r.body.text();
      let json;
      try { json = JSON.parse(text); } catch {}
      const ok = r.statusCode === 200 && json?.code === 0;
      const error = ok ? undefined : (json?.error || json?.message || `HTTP ${r.statusCode}`);
      res.write(JSON.stringify({ proxy: url, ok, latencyMs, egressIp: null, error }) + '\n');
    } catch (err) {
      res.write(JSON.stringify({ proxy: url, ok: false, latencyMs: Date.now() - start, egressIp: null, error: err.message }) + '\n');
    }
  }
  res.end();
});

/**
 * POST /api/market/proxies/tcp-test — test TCP connectivity to a list of proxies (parallel, fast).
 * Body: { proxies: string[] }
 * Just checks if the proxy host:port accepts connections. No GMGN involved.
 * Returns { results: [{ proxy, ok, latencyMs, error }] }
 */
router.post('/proxies/tcp-test', async (req, res) => {
  const { proxies } = req.body || {};
  if (!Array.isArray(proxies)) {
    return fail(res, new Error('proxies (array) is required'), 400);
  }
  if (proxies.length === 0) return res.json({ results: [] });

  const { default: net } = await import('node:net');

  const results = await Promise.all(
    proxies.map(async (raw) => {
      const proxy = String(raw).trim();
      if (!proxy) return { proxy: '', ok: false, latencyMs: 0, error: 'empty' };
      // Extract host:port from url or bare "host:port"
      const clean = proxy.replace(/^(https?|socks[45]):\/\//, '');
      const [host, portStr] = clean.split(':');
      const port = Number(portStr);
      if (!host || !port) return { proxy, ok: false, latencyMs: 0, error: 'invalid format' };

      const start = Date.now();
      return new Promise((resolve) => {
        const socket = net.createConnection({ host, port, timeout: 5000 });
        const done = (ok, error) => {
          socket.destroy();
          resolve({ proxy, ok, latencyMs: Date.now() - start, error: error || undefined });
        };
        socket.on('connect', () => done(true));
        socket.on('timeout', () => done(false, 'timeout'));
        socket.on('error', (err) => done(false, err.message));
      });
    })
  );

  res.json({ results });
});

/**
 * POST /api/market/proxies/latency-test — measure latency from each proxy to GMGN.
 * Body: { proxies: string[] }
 * Does a HEAD request to https://gmgn.ai through each proxy. No API key needed.
 * Returns NDJSON stream: { proxy, ok, latencyMs, httpStatus, error }
 */
router.post('/proxies/latency-test', async (req, res) => {
  const { proxies } = req.body || {};
  if (!Array.isArray(proxies)) {
    return fail(res, new Error('proxies (array) is required'), 400);
  }
  if (proxies.length === 0) return res.json({ results: [] });

  const { ProxyAgent, request } = await import('undici');

  const results = await Promise.all(
    proxies.map(async (raw) => {
      const proxy = String(raw).trim();
      if (!proxy) return { proxy: '', ok: false, latencyMs: 0, httpStatus: null, error: 'empty' };
      const url = proxy.startsWith('http') || proxy.startsWith('socks')
        ? proxy
        : `http://${proxy}`;
      const start = Date.now();
      try {
        const dispatcher = new ProxyAgent(url, {
          connect: { timeout: 5_000, tls: { rejectUnauthorized: false } },
        });
        const r = await request('https://gmgn.ai', {
          method: 'HEAD',
          dispatcher,
          signal: AbortSignal.timeout(8_000),
        });
        return { proxy: url, ok: true, latencyMs: Date.now() - start, httpStatus: r.statusCode };
      } catch (err) {
        return { proxy: url, ok: false, latencyMs: Date.now() - start, httpStatus: null, error: err.message };
      }
    })
  );

  res.json({ results });
});

/**
 * GET /api/market/proxies/status — health status of all configured proxies.
 */
router.get('/proxies/status', async (_req, res) => {
  try {
    const statuses = await checkAllProxies(proxyConfigs);
    res.json({ statuses });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * GET /api/market/trenches
 * Query: tab=new_creation|near_completion|completed
 * Applies the device's saved filter config (PUT /api/market/trenches/filters);
 * the app never sends GMGN params. Returns that tab's token list.
 */
router.get('/trenches', async (req, res) => {
  try {
    const id = deviceId(req);
    const tab = TRENCH_TABS.includes(req.query.tab) ? req.query.tab : 'new_creation';
    let config = null;
    if (id) {
      const entry = trenchesFilters.get(id);
      config = entry?.filters ?? null;
    }
    const result = await fetchTrenches(buildParamsFromConfig(config, tab), {
      ...(connectionForTab(tab) || {}),
      ttl: 2,
    });
    res.json({ ...result, tab, fetched_at: new Date().toISOString() });
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
    const entry = trenchesFilters.get(id);
    res.json({ filters: entry?.filters ?? null });
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
    trenchesFilters.set(id, { filters: raw, updated_at: new Date().toISOString() });
    // Suppress WS broadcasts for 5s so the refresher's stale data
    // (fetched with old filters) doesn't overwrite the HTTP response.
    for (const tab of ['new_creation', 'near_completion', 'completed']) {
      suppressBroadcast(tab);
      setTimeout(() => unsuppressBroadcast(tab), 5000);
    }
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
    const data = await getPrices(all);
    const prices = Object.fromEntries(Object.entries(data).map(([m, v]) => [m, v?.price ?? null]));
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