import { Router } from 'express';
import * as trading from '../services/trading.js';
import { getMarketData, getPrices } from '../services/jupiter.js';
import { getTokenInfo } from '../services/dexscreener.js';

const router = Router();

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
  // Fetch fresh price/market data + metadata to price the simulated trade.
  const [jup, dex] = await Promise.allSettled([getMarketData(address), getTokenInfo(address)]);
  const jupInfo = jup.status === 'fulfilled' ? jup.value : null;
  const dexInfo = dex.status === 'fulfilled' ? dex.value : null;

  // Pump.fun bonding-curve tokens have no Jupiter pool yet, so fall back to Dexscreener.
  const price = jupInfo?.price ?? dexInfo?.price ?? null;
  if (!price) {
    throw Object.assign(new Error('Could not resolve a price for this token'), { status: 422 });
  }

  return {
    token: {
      address,
      chain,
      symbol: dexInfo?.symbol ?? jupInfo?.symbol ?? null,
      name: dexInfo?.name ?? jupInfo?.name ?? null,
      logo: dexInfo?.logo ?? null,
    },
    price,
    source: jupInfo?.price != null ? 'jupiter' : 'dexscreener',
    jup: jupInfo,
    dex: dexInfo,
  };
}

/**
 * GET /api/wallet
 * Header: X-Device-Id
 */
router.get('/wallet', (req, res) => {
  try {
    const id = deviceId(req);
    const wallet = trading.getWallet(id);
    res.json({ wallet });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * POST /api/wallet/reset
 * Body: { budget?, gas? }
 */
router.post('/wallet/reset', (req, res) => {
  try {
    const id = deviceId(req);
    const wallet = trading.resetWallet(id, {
      budget: Number(req.body.budget) || 10000,
      gas: req.body.gas != null ? Number(req.body.gas) : undefined,
    });
    res.json({ wallet });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * POST /api/trade/buy
 * Body: { token_address, chain?, usdc?, gas? }
 */
router.post('/trade/buy', async (req, res) => {
  try {
    const id = deviceId(req);
    const { token_address, chain } = req.body;
    if (!token_address) throw Object.assign(new Error('token_address is required'), { status: 400 });

    const { token, price, source } = await resolveToken(token_address, chain || 'sol');

    const wallet = trading.getWallet(id);
    const result = trading.buy(id, token, {
      price,
      usdc: Number(req.body.usdc),
      gas: req.body.gas != null ? Number(req.body.gas) : undefined,
    });
    res.json({ ...result, price_source: source });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * POST /api/trade/sell
 * Body: { token_address, chain?, quantity?, gas? } — quantity omitted = sell all
 */
router.post('/trade/sell', async (req, res) => {
  try {
    const id = deviceId(req);
    const { token_address, chain } = req.body;
    if (!token_address) throw Object.assign(new Error('token_address is required'), { status: 400 });

    const { token, price, source } = await resolveToken(token_address, chain || 'sol');

    const result = trading.sell(id, token, {
      quantity: req.body.quantity != null ? Number(req.body.quantity) : null,
      price,
      gas: req.body.gas != null ? Number(req.body.gas) : undefined,
    });
    res.json({ ...result, price_source: source });
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
    const wallet = trading.getWallet(id);
    const positions = trading.getPositions(id);
    const stats = trading.getStats(id);

    const mints = positions.map((p) => p.token_address);
    const prices = await getPrices(mints); // single batched request

    const enriched = positions.map((p) => {
      const price = prices[p.token_address] ?? p.avg_price_usdc;
      const value = p.quantity * price;
      const pnl = value - p.cost_usdc;
      return {
        ...p,
        current_price: price,
        value,
        pnl,
        pnl_percent: p.cost_usdc > 0 ? (pnl / p.cost_usdc) * 100 : 0,
      };
    });

    const invested = positions.reduce((s, p) => s + p.cost_usdc, 0);
    const totalValue = enriched.reduce((s, p) => s + p.value, 0);
    const unrealizedPnl = totalValue - invested;
    const totalEquity = wallet.balance_usdc + totalValue;

    res.json({
      wallet,
      stats,
      positions: enriched,
      summary: {
        balance: wallet.balance_usdc,
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