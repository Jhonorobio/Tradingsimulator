import { Router } from 'express';
import * as trading from '../services/trading.js';

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

/**
 * GET /api/wallet
 * Header: X-Device-Id
 */
router.get('/wallet', async (req, res) => {
  try {
    const id = deviceId(req);
    const wallet = trading.getWallet(id);
    res.json({ wallet });
  } catch (err) {
    fail(res, err);
  }
});

export default router;
