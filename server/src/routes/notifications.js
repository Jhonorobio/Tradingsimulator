import { Router } from 'express';
import { notificationConfig, notificationHistory, winners } from '../stores.js';
import { isValidPushToken } from '../services/push.js';

const router = Router();

const VALID_CATEGORIES = ['new_creation', 'completed', 'new_creation_robinhood', 'completed_robinhood', 'new_creation_bsc', 'completed_bsc'];

const FILTER_FIELDS = [
  'smart_degen_count', 'renowned_count', 'bot_degen_count', 'bot_degen_rate',
  'fresh_wallet_rate', 'rug_ratio', 'bundler_trader_amount_rate', 'entrapment_ratio', 'volume_24h', 'usd_market_cap',
];

function sanitizeFilters(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [cat, f] of Object.entries(raw)) {
    if (!VALID_CATEGORIES.includes(cat) || !f || typeof f !== 'object') continue;
    const clean = {};
    for (const field of FILTER_FIELDS) {
      const v = f[field];
      if (v && typeof v === 'object') {
        const min = v.min != null && v.min !== '' ? Number(v.min) : undefined;
        const max = v.max != null && v.max !== '' ? Number(v.max) : undefined;
        if (min != null || max != null) clean[field] = { min, max };
      }
    }
    if (Object.keys(clean).length > 0) out[cat] = clean;
  }
  return out;
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
  if (process.env.NODE_ENV !== 'production') console.error('[notifications]', message);
  res.status(err?.status || status).json({ error: message });
}

/**
 * PUT /api/notifications/config
 * Body: { push_token, categories: { new_creation: bool, completed: bool } }
 * Creates or replaces the notification config for this device.
 */
router.put('/config', (req, res) => {
  try {
    const id = deviceId(req);
    const { push_token, categories, filters } = req.body || {};

    if (!isValidPushToken(push_token)) {
      throw Object.assign(new Error('Invalid Expo push token'), { status: 400 });
    }
    if (!categories || typeof categories !== 'object') {
      throw Object.assign(new Error('categories is required'), { status: 400 });
    }

    const cats = {};
    for (const key of VALID_CATEGORIES) {
      cats[key] = !!categories[key];
    }

    const existing = notificationConfig.get(id);
    const mergedFilters = { ...(existing?.filters || {}), ...sanitizeFilters(filters) };
    // Remove filters for disabled categories
    for (const key of VALID_CATEGORIES) {
      if (!cats[key]) delete mergedFilters[key];
    }

    notificationConfig.set(id, {
      device_id: id,
      push_token,
      categories: cats,
      filters: mergedFilters,
      updated_at: new Date().toISOString(),
    });

    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * GET /api/notifications/config
 * Header: X-Device-Id
 * Returns the notification config for this device (or defaults with all off).
 */
router.get('/config', (req, res) => {
  try {
    const id = deviceId(req);
    const entry = notificationConfig.get(id);
    if (!entry) {
      return res.json({
        push_token: null,
        categories: { new_creation: false, completed: false, new_creation_robinhood: false, completed_robinhood: false, new_creation_bsc: false, completed_bsc: false },
        filters: {},
      });
    }
    res.json({
      push_token: entry.push_token,
      categories: entry.categories,
      filters: entry.filters || {},
    });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * GET /api/notifications/history
 * Header: X-Device-Id
 * Query: limit (default 50, max 200)
 * Returns global notification history, newest first.
 */
router.get('/history', (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 300);
    const entries = notificationHistory.getAll()
      .filter((e, i, arr) => arr.findIndex(x => x.address === e.address && x.category === e.category) === i)
      .sort((a, b) => (b.notified_at || '').localeCompare(a.notified_at || ''))
      .slice(0, limit);
    res.json({ history: entries });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * GET /api/notifications/winners
 * Returns winners (tokens with 100%+ gain), newest first, max 100.
 */
router.get('/winners', (_req, res) => {
  try {
    const entries = winners.getAll()
      .sort((a, b) => (b.added_at || '').localeCompare(a.added_at || ''))
      .slice(0, 100);
    res.json({ winners: entries });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * DELETE /api/notifications/history?chain=sol
 * Clears notification history, optionally filtered by chain.
 */
router.delete('/history', (req, res) => {
  try {
    const chain = req.query.chain;
    if (chain) {
      const valid = ['sol', 'bsc', 'robinhood'];
      if (!valid.includes(chain)) return fail(res, new Error('Invalid chain'), 400);
      const all = notificationHistory.getAll();
      const toKeep = all.filter((e) => e.chain !== chain);
      notificationHistory.setAll(toKeep);
      res.json({ ok: true, removed: all.length - toKeep.length });
    } else {
      const count = notificationHistory.getAll().length;
      notificationHistory.setAll([]);
      res.json({ ok: true, removed: count });
    }
  } catch (err) {
    fail(res, err);
  }
});

/**
 * DELETE /api/notifications/winners
 * Clears all winners.
 */
router.delete('/winners', (_req, res) => {
  try {
    const count = winners.getAll().length;
    winners.setAll([]);
    res.json({ ok: true, removed: count });
  } catch (err) {
    fail(res, err);
  }
});

export default router;
