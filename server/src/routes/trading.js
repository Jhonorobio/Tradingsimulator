import { Router } from 'express';
import * as trading from '../services/trading.js';
import { getTokenInfo as dexGetTokenInfo } from '../services/dexscreener.js';

const router = Router();

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_PRICE_FALLBACK = 150;

async function solPriceUsd() {
  try {
    const info = await dexGetTokenInfo(SOL_MINT);
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

export default router;
