import { Router } from 'express';
import { notificationConfig, notificationHistory } from '../stores.js';
import { isValidPushToken } from '../services/push.js';

const router = Router();

const VALID_CATEGORIES = ['new_creation', 'completed', 'new_creation_robinhood', 'completed_robinhood'];

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
    const { push_token, categories } = req.body || {};

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

    notificationConfig.set(id, {
      device_id: id,
      push_token,
      categories: cats,
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
        categories: { new_creation: false, completed: false, new_creation_robinhood: false, completed_robinhood: false },
      });
    }
    res.json({
      push_token: entry.push_token,
      categories: entry.categories,
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
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const entries = notificationHistory
      .sort((a, b) => (b.notified_at || '').localeCompare(a.notified_at || ''))
      .slice(0, limit);
    res.json({ history: entries });
  } catch (err) {
    fail(res, err);
  }
});

export default router;
