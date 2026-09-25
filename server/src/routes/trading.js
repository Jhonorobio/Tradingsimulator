import { Router } from 'express';
import * as trading from '../services/trading.js';
import { getTokenInfo as getDataTokenInfo, getPrices, SOL_MINT } from '../services/token-data.js';
import { getTokenInfo } from '../services/dexscreener.js';
import { getLiveMcap, getLiveMcapMany } from '../services/gmgn-mcap.js';

const router = Router();

const SOL_PRICE_FALLBACK = 150;

async function solPriceUsd() {
  try {
    const info = await getDataTokenInfo('sol', SOL_MINT);
    if (info?.price) return Number(info.price);
  } catch {
    // fall through to fallback
  }
  return SOL_PRICE_FALLBACK;
}

function deviceId(req) {
  const id = req.headers['x-device-id'] || req.params.deviceId;
  if (!id || typeof id !== 'string' || id.length > 128) {
    throw Object.assign(new Error('Missing or invalid X-Device-Id header'), { status: 400 });
  }
  return id;
}

function fail(res, err, status = 500) {
  const message = err?.message || String(err);
  if (process.env.NODE_ENV !== 'production') console.error('[trading]', message);
  res.status(err?.status || status).json({ error: message });
}

async function resolveToken(address, chain = 'sol') {
  const slug = chain === 'solana' ? 'sol' : chain || 'sol';
  // Live market cap (GMGN candles) prices the simulated trade; metadata and
  // the proxy/Dexscreener mcap remain as fallback when candles are empty.
  const [live, data, dex] = await Promise.all([
    slug === 'sol'
      ? getLiveMcap(address).catch(() => ({ marketCap: null, error: 'live-mcap failed' }))
      : Promise.resolve({ marketCap: null }),
    Promise.allSettled([
      getDataTokenInfo(chain, address),
      getTokenInfo(address),
    ]),
  ]);
  const dataInfo = data[0].status === 'fulfilled' ? data[0].value : null;
  const dexInfo = data[1].status === 'fulfilled' ? data[1].value : null;

  const marketCap = live?.marketCap ?? dataInfo?.marketCap ?? dexInfo?.marketCap ?? null;
  if (!marketCap || marketCap <= 0) {
    throw Object.assign(new Error('Could not resolve a market cap for this token'), { status: 422 });
  }

  return {
    token: {
      address,
      chain,
      symbol: dexInfo?.symbol ?? dataInfo?.symbol ?? null,
      name: dexInfo?.name ?? dataInfo?.name ?? null,
      logo: dexInfo?.logo ?? dataInfo?.logo ?? null,
    },
    marketCap,
    source: live?.marketCap != null
      ? 'gmgn-candles'
      : dataInfo?.marketCap != null ? dataInfo.source : 'dexscreener',
  };
}

/**
 * GET /api/wallet
 * Header: X-Device-Id
 */
router.get('/wallet', async (req, res) => {
  try {
    const id = deviceId(req);
    const solPrice = await solPriceUsd();
    const wallet = trading.getWallet(id, { solPrice });
    res.json({ wallet, sol_price: solPrice });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * POST /api/wallet/reset
 * Body: { budget?, gas_sol? } — budget is USD, converted to the SOL budget at SOL price.
 */
router.post('/wallet/reset', async (req, res) => {
  try {
    const id = deviceId(req);
    const solPrice = await solPriceUsd();
    const wallet = trading.resetWallet(id, {
      budget: Number(req.body.budget) || 10000,
      gasSol: req.body.gas_sol != null ? Number(req.body.gas_sol) : undefined,
      solPrice,
    });
    res.json({ wallet, sol_price: solPrice });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * POST /api/wallet/convert
 * Body: { direction: 'usd_to_sol' | 'sol_to_usd', amount }
 */
router.post('/wallet/convert', async (req, res) => {
  try {
    const id = deviceId(req);
    const solPrice = await solPriceUsd();
    const wallet = trading.convert(id, {
      direction: req.body.direction,
      amount: Number(req.body.amount),
      solPrice,
    });
    res.json({ wallet, sol_price: solPrice });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * POST /api/trade/buy
 * Body: { token_address, chain?, usd?, sol?, gas_sol? } — `usd` is the USD amount
 * to spend (converted to SOL at the current rate); `sol` is a raw SOL amount.
 */
router.post('/trade/buy', async (req, res) => {
  try {
    const id = deviceId(req);
    const { token_address, chain } = req.body;
    if (!token_address) throw Object.assign(new Error('token_address is required'), { status: 400 });

    const solPrice = await solPriceUsd();
    const { token, marketCap, source } = await resolveToken(token_address, chain || 'sol');

    const usd = req.body.usd != null ? Number(req.body.usd) : undefined;
    const sol = req.body.sol != null ? Number(req.body.sol) : undefined;
    const spendSol = usd != null && Number.isFinite(usd) && usd > 0 ? usd / solPrice : sol;

    const wallet = trading.getWallet(id, { solPrice });
    const result = trading.buy(id, token, {
      marketCap,
      sol: spendSol,
      gasSol: req.body.gas_sol != null ? Number(req.body.gas_sol) : undefined,
      solPrice,
    });
    res.json({ ...result, price_source: source, sol_price: solPrice });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * POST /api/trade/sell
 * Body: { token_address, chain?, quantity?, gas_sol? } — quantity omitted = sell all
 */
router.post('/trade/sell', async (req, res) => {
  try {
    const id = deviceId(req);
    const { token_address, chain } = req.body;
    if (!token_address) throw Object.assign(new Error('token_address is required'), { status: 400 });

    const solPrice = await solPriceUsd();
    const { token, marketCap, source } = await resolveToken(token_address, chain || 'sol');

    const wallet = trading.getWallet(id, { solPrice });
    const result = trading.sell(id, token, {
      quantity: req.body.quantity != null ? Number(req.body.quantity) : null,
      marketCap,
      gasSol: req.body.gas_sol != null ? Number(req.body.gas_sol) : undefined,
      solPrice,
    });
    res.json({ ...result, price_source: source, sol_price: solPrice });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * GET /api/portfolio — positions + live valuation + stats
 * Header: X-Device-Id
 */
router.get('/portfolio', async (req, res) => {
  try {
    const id = deviceId(req);
    const solPrice = await solPriceUsd();
    const wallet = trading.getWallet(id, { solPrice });
    const positions = trading.getPositions(id);
    const stats = trading.getStats(id);

    const mints = positions.map((p) => ({ address: p.token_address, chain: p.chain || 'sol' }));
    const solMints = positions
      .filter((p) => (p.chain || 'sol') === 'sol')
      .map((p) => p.token_address);
    const [market, live] = await Promise.all([
      getPrices(mints), // fallback batched request (GMGN proxy / Dexscreener)
      // Live mcap (GMGN candles) for SOL positions — fresh for 2s so a poll
      // only refetches what actually went stale.
      getLiveMcapMany(solMints, { freshMs: 2000 }).catch(() => ({})),
    ]);

    const enriched = positions.map((p) => {
      const m = market[p.token_address];
      const mcap = live[p.token_address]?.marketCap ?? m?.marketCap ?? p.entry_market_cap;
      const value = p.quantity * mcap;
      const pnl = value - p.cost_usdc;
      return {
        ...p,
        market_cap: mcap,
        value,
        pnl,
        pnl_percent: p.cost_usdc > 0 ? (pnl / p.cost_usdc) * 100 : 0,
      };
    });

    const invested = positions.reduce((s, p) => s + p.cost_usdc, 0);
    const totalValue = enriched.reduce((s, p) => s + p.value, 0);
    const unrealizedPnl = totalValue - invested;
    const solValueUsd = wallet.balance_sol * solPrice;
    const totalEquity = wallet.balance_usd + solValueUsd + totalValue;

    res.json({
      wallet,
      sol_price: solPrice,
      stats,
      positions: enriched,
      summary: {
        balance_usd: wallet.balance_usd,
        balance_sol: wallet.balance_sol,
        sol_value_usd: solValueUsd,
        invested,
        total_value: totalValue,
        unrealized_pnl: unrealizedPnl,
        total_equity: totalEquity,
      },
    });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * GET /api/orders?limit=50
 * Header: X-Device-Id
 */
router.get('/orders', (req, res) => {
  try {
    const id = deviceId(req);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json({ orders: trading.getOrders(id, limit) });
  } catch (err) {
    fail(res, err);
  }
});

export default router;