import { Router } from 'express';
import { runMarket, runConfigCheck } from '../cli/gmgn.js';
import { fetchTrenches, getPairCooldowns } from '../cli/args.js';
import { trenchesFilters, proxyConfigs } from '../stores.js';
import { searchTokens as dexSearch } from '../services/dexscreener.js';
import { cacheKey, withCache } from '../services/cache.js';
import { buildParamsFromConfig, TRENCH_TABS } from '../services/trenches-filters.js';
import { connectionForTab, getRefresherStatus } from '../services/trenches-refresher.js';
import { testProxy, getAllStatus, checkAllProxies } from '../services/proxy-health.js';
import { getAllTracksFiltered } from '../services/token-snapshots.js';
import { getMemescope, getMemescopeStatus, getPhotonFilters, setPhotonFilters, findPhotonToken } from '../services/photon-memescope.js';
import { getXTrackerStatus, getXTrackerTokens } from '../services/xtracker-watcher.js';
import { getFomoGraduated, getFomoTrending, getFomoStatus, setFomoProxy } from '../services/fomo-ws.js';
import { getFomoNotifyFilters, setFomoNotifyFilters } from '../services/fomo-notify.js';
import { setRefreshToken, getRefreshToken, getAccessToken, fomoAuthStatus } from '../services/fomo-auth.js';

const router = Router();

function deviceId(req) {
  return req.headers['x-device-id'] || req.params.deviceId || '';
}

const toN = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

function fail(res, err, status = 500) {
  const message = err?.message || String(err);
  if (process.env.NODE_ENV !== 'production') console.error('[market]', message);
  res.status(status).json({ error: message });
}

const VALID_TABS = ['new_creation', 'completed'];

/**
 * GET /api/market/proxies — returns saved proxy configs for all 3 tabs.
 */
router.get('/proxies', (_req, res) => {
  const configs = {};
  for (const tab of VALID_TABS) {
    const entry = proxyConfigs.get(tab);
    configs[tab] = entry ? { url: entry.url || '', apiKey: entry.apiKey || '', enabled: entry.enabled !== false } : { url: '', apiKey: '', enabled: true };
  }
  res.json(configs);
});

/**
 * PUT /api/market/proxies — save proxy config for a tab.
 * Body: { tab, url, apiKey }
 */
router.put('/proxies', (req, res) => {
  const { tab, url, apiKey, enabled } = req.body || {};
  if (!VALID_TABS.includes(tab)) return fail(res, new Error('Invalid tab'), 400);
  // new_creation (SOL) only needs API key, no proxy URL
  if (tab === 'new_creation') {
    if (!apiKey) return fail(res, new Error('apiKey is required'), 400);
  } else {
    if (!url || !apiKey) return fail(res, new Error('url and apiKey are required'), 400);
  }
  const existing = proxyConfigs.get(tab) || {};
  proxyConfigs.set(tab, {
    url: String(url || '').trim(),
    apiKey: String(apiKey).trim(),
    enabled: enabled !== false,
  });
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
    // Fallback to global config (saved via WebSocket)
    if (!config) {
      const global = trenchesFilters.get('global');
      config = global?.filters ?? null;
    }
    const result = await fetchTrenches(buildParamsFromConfig(config, tab), {
      ...(connectionForTab(tab) || {}),
      ttl: 2,
      tab,
      source: 'http',
    });
    res.json({ ...result, tab, fetched_at: new Date().toISOString() });
  } catch (err) {
    fail(res, err, err?.status || 500);
  }
});

/**
 * GET /api/market/trenches/filters — global trenches filters config.
 */
router.get('/trenches/filters', (_req, res) => {
  try {
    const entry = trenchesFilters.get('global');
    res.json({ filters: entry?.filters ?? null });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * PUT /api/market/trenches/filters — save global trenches filters.
 * Body: { filters }
 */
router.put('/trenches/filters', (req, res) => {
  try {
    const raw = req.body?.filters;
    if (raw == null) return fail(res, new Error('filters is required'), 400);
    trenchesFilters.set('global', { filters: raw, updated_at: new Date().toISOString() });
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

/**
 * GET /api/market/refresher-status — per-tab worker diagnostics.
 * Shows whether a worker is running for each tab and its last
 * success/error timestamps, so a frozen tab can be diagnosed live.
 */
router.get('/refresher-status', (_req, res) => {
  res.json({
    statuses: getRefresherStatus(),
    cooldowns: getPairCooldowns(),
    filtersSaved: trenchesFilters.get('global')?.filters ?? null,
    time: new Date().toISOString(),
  });
});

/**
 * GET /api/market/debug-tab/:tab — test-fetch a specific tab and return raw result.
 * Diagnostic endpoint: calls fetchTrenches directly with the saved filters
 * and returns the response + timing, so we can see exactly what GMGN returns.
 */
router.get('/debug-tab/:tab', async (req, res) => {
  const tab = req.params.tab;
  const config = trenchesFilters.get('global')?.filters;
  if (!config) return fail(res, new Error('No filters saved — press Confirmar first'), 400);
  const connection = connectionForTab(tab);
  if (!connection) return fail(res, new Error(`No API key for tab: ${tab}`), 400);
  const params = buildParamsFromConfig(config, tab);
  const start = Date.now();
  try {
    const result = await fetchTrenches(params, { ...connection, tab, source: 'debug', force: true });
    const elapsed = Date.now() - start;
    const tabData = result[tab] ?? [];
    res.json({
      tab,
      tokensCount: tabData.length,
      firstTokens: tabData.slice(0, 3).map((t) => ({ address: t?.address, name: t?.name, symbol: t?.symbol, usd_market_cap: t?.usd_market_cap, created_timestamp: t?.created_timestamp })),
      params,
      elapsedMs: elapsed,
      time: new Date().toISOString(),
    });
  } catch (err) {
    const elapsed = Date.now() - start;
    fail(res, Object.assign(new Error(`[${tab}] Fetch failed (${elapsed}ms): ${err.message}`), { status: err.status || 500 }));
  }
});

/**
 * GET /api/market/xtracker/status — diagnostics for the background Tracker
 * watchlist: active/stopped counts, stop reasons and last ticks.
 */
router.get('/xtracker/status', (_req, res) => {
  try {
    res.json(getXTrackerStatus());
  } catch (err) {
    fail(res, err);
  }
});

/**
 * GET /api/market/xtracker/tokens — watchlist behind the "Rastreando" tab.
 * Query: status=active|stopped|all (default active), q, limit
 */
router.get('/xtracker/tokens', (req, res) => {
  try {
    res.json(getXTrackerTokens({
      status: req.query.status,
      q: req.query.q,
      limit: req.query.limit,
    }));
  } catch (err) {
    fail(res, err);
  }
});

/** Shared query parsing for both FOMO feeds (absent/invalid = no bound). */
function fomoFeedQuery(req) {
  return {
    ageMinMin: toN(req.query.ageMinMin),
    ageMaxMin: toN(req.query.ageMaxMin),
    mcapMin: toN(req.query.mcapMin),
    mcapMax: toN(req.query.mcapMax),
    kolMin: toN(req.query.kolMin),
    kolMax: toN(req.query.kolMax),
    limit: toN(req.query.limit),
  };
}

/**
 * GET /api/market/fomo/graduated — FOMO (fomo.family) Solana graduated feed
 * filtered server-side. Query: ageMinMin, ageMaxMin, mcapMin, mcapMax, kolMin,
 * kolMax, limit (all optional; absent = no bound on that side of the axis).
 * Either KOL bound resolves KOL counts via Pulse (GMGN fallback) before
 * filtering. Snapshotted + live-merged by fomo-ws.
 */
router.get('/fomo/graduated', async (req, res) => {
  try {
    res.json(await getFomoGraduated(fomoFeedQuery(req)));
  } catch (err) {
    fail(res, err, 502);
  }
});

/**
 * GET /api/market/fomo/trending — same filters over FOMO's trending feed
 * (same WS connection/topicId, only Solana). Note: upstream sends no
 * `createdAt` for trending tokens — either age bound resolves it per token
 * via Pulse (`created_at`, token-age.js) before filtering.
 */
router.get('/fomo/trending', async (req, res) => {
  try {
    res.json(await getFomoTrending(fomoFeedQuery(req)));
  } catch (err) {
    fail(res, err, 502);
  }
});

/** GET /api/market/fomo/status — connection/auth diagnostics (never exposes tokens). */
router.get('/fomo/status', (_req, res) => {
  try {
    res.json(getFomoStatus());
  } catch (err) {
    fail(res, err);
  }
});

/**
 * GET /api/market/fomo/notify — the per-tab filters the alert matcher uses.
 * Values are numbers (bounds are numeric) or null (axis off).
 */
router.get('/fomo/notify', (_req, res) => {
  try {
    res.json(getFomoNotifyFilters());
  } catch (err) {
    fail(res, err);
  }
});

/**
 * PUT /api/market/fomo/notify — per-tab filters for FOMO alert notifications.
 * Body: { graduated?: { ageMinMin, ageMaxMin, mcapMin, mcapMax, kolMin, kolMax },
 *         trending?:  { ageMinMin, ageMaxMin, mcapMin, mcapMax, kolMin, kolMax } }
 * Numbers (or ''/absent = axis side off); only the provided feeds are replaced.
 * The matcher reseeds silently, so widening filters never bursts the list.
 */
router.put('/fomo/notify', (req, res) => {
  try {
    const { graduated, trending } = req.body || {};
    if (graduated == null && trending == null) {
      return fail(res, new Error('graduated o trending requerido'), 400);
    }
    res.json({ ok: true, filters: setFomoNotifyFilters({ graduated, trending }) });
  } catch (err) {
    fail(res, err, err?.status || 500);
  }
});

/**
 * PUT /api/market/fomo/auth — seed the long-lived Privy refresh token (e.g. on
 * a fresh deployment without data/fomo-auth.json). Body: { refresh_token }.
 * Verifies it mints an access token before saving. Never returns the token.
 */
router.put('/fomo/auth', async (req, res) => {
  try {
    const token = typeof req.body?.refresh_token === 'string' ? req.body.refresh_token.trim() : '';
    if (!token) {
      res.status(400).json({ error: 'refresh_token requerido' });
      return;
    }
    const prev = getRefreshToken();
    setRefreshToken(token);
    try {
      await getAccessToken({ force: true }); // throws → 400 if the token is bad
    } catch (err) {
      if (prev) setRefreshToken(prev); // don't clobber a working token
      fail(res, err, 400);
      return;
    }
    res.json({ ok: true, auth: fomoAuthStatus() });
  } catch (err) {
    fail(res, err, 400);
  }
});

/**
 * PUT /api/market/fomo/proxy — egress proxy for the FOMO WS (Cloudflare 432s
 * datacenter IPs). Body: { proxy: "host:port" | "http://…" | "" } — empty
 * clears it (direct connection). Reconnects the feed with the new transport.
 */
router.put('/fomo/proxy', (req, res) => {
  try {
    const raw = typeof req.body?.proxy === 'string' ? req.body.proxy : '';
    res.json({ ok: true, proxy: setFomoProxy(raw) });
  } catch (err) {
    fail(res, err, 400);
  }
});

/**
 * GET /api/market/memescope — Photon screener feed (New / Graduated) with
 * independent filters per column. Served from cache: the background poller
 * rotates one column per 1.3s tick (rate-limit safe; a faster cadence trips
 * Photon's 429 — see photon-memescope.js sweep notes).
 * Never 500s: on upstream failure it returns the last data + `error`.
 */
router.get('/memescope', async (_req, res) => {
  try {
    res.json(await getMemescope());
  } catch (err) {
    fail(res, err, 502);
  }
});

/** GET /api/market/memescope-status — poller/pacing diagnostics. */
router.get('/memescope-status', (_req, res) => {
  res.json(getMemescopeStatus());
});

/**
 * GET /api/market/memescope-filters — effective per-column screener filters
 * (defaults merged with the saved config in data/photon_filters.json).
 */
router.get('/memescope-filters', (_req, res) => {
  try {
    res.json({ filters: getPhotonFilters() });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * PUT /api/market/memescope-filters — save per-column filters.
 * Body: { filters: { col1: {age:{min,max}, holders:{...}, ...}, col3 } }
 * Sanitized server-side (numeric values only); picked up by the poller on the
 * next rotation step (~2.6s per column).
 */
router.put('/memescope-filters', (req, res) => {
  try {
    const raw = req.body?.filters;
    if (raw == null) return fail(res, new Error('filters is required'), 400);
    res.json({ ok: true, filters: setPhotonFilters(raw) });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * GET /api/market/snapshots-export
 * Export token snapshots for AI analysis.
 * Query:
 *   chain=sol|all (default: all)
 *   category=new_creation|completed|all (default: all)
 *   minGainPct=-100 (default: -100 = include losers)
 *   maxTracks=200 (default: 200)
 *   includeTimeline=true|false (default: true)
 *   sinceHours=168 (default: 168 = 7 days)
 *   balanceRatio=0.5 (default: 0.5 = 50% winners / 50% losers)
 */
router.get('/snapshots-export', (req, res) => {
  try {
    const {
      chain = 'all',
      category = 'all',
      minGainPct = -100,
      maxTracks = 200,
      includeTimeline = 'true',
      sinceHours = 168,
      balanceRatio = '0.5',
    } = req.query;

    const validChains = ['sol', 'all'];
    const validCategories = ['new_creation', 'completed', 'all'];

    if (!validChains.includes(chain)) return fail(res, new Error('Invalid chain'), 400);
    if (!validCategories.includes(category)) return fail(res, new Error('Invalid category'), 400);

    const data = getAllTracksFiltered({
      chain,
      category,
      minGainPct: Number(minGainPct),
      maxTracks: Math.min(Number(maxTracks), 500),
      includeTimeline: includeTimeline === 'true',
      sinceHours: Math.min(Number(sinceHours), 720),
      balanceRatio: Math.max(0, Math.min(1, Number(balanceRatio))),
    });

    res.json({
      meta: {
        generatedAt: new Date().toISOString(),
        filters: { chain, category, minGainPct: Number(minGainPct), maxTracks: Number(maxTracks), includeTimeline: includeTimeline === 'true', sinceHours: Number(sinceHours) },
        totalTracks: data.stats.total,
        includedTracks: data.tracks.length,
      },
      tracks: data.tracks,
      aggregatedStats: data.stats,
    });
  } catch (err) {
    fail(res, err);
  }
});

export default router;