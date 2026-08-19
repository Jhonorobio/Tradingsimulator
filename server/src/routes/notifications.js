import { Router } from 'express';
import { db } from '../db.js';
import { isValidPushToken } from '../services/push.js';

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
  if (process.env.NODE_ENV !== 'production') console.error('[notifications]', message);
  res.status(err?.status || status).json({ error: message });
}

const VALID_TYPES = new Set(['new_creation', 'near_completion', 'completed']);

/**
 * POST /api/notifications/subscribe
 * Body: {
 *   push_token, chain?, types?, filter_preset?,
 *   min_smart_degen?, min_volume_24h?, max_rug_ratio?
 * }
 */
router.post('/subscribe', (req, res) => {
  try {
    const id = deviceId(req);
    const { push_token } = req.body;
    if (!isValidPushToken(push_token)) {
      throw Object.assign(new Error('Invalid Expo push token'), { status: 400 });
    }

    const chain = req.body.chain || 'sol';
    const rawTypes = Array.isArray(req.body.types) && req.body.types.length
      ? req.body.types.filter((t) => VALID_TYPES.has(t))
      : ['new_creation'];
    if (!rawTypes.length) throw Object.assign(new Error('types must be one of new_creation, near_completion, completed'), { status: 400 });

    const filterPreset = req.body.filter_preset || null;
    const minSmartDegen = req.body.min_smart_degen != null ? Math.max(0, Number(req.body.min_smart_degen)) : null;
    const minVolume24h = req.body.min_volume_24h != null ? Math.max(0, Number(req.body.min_volume_24h)) : null;
    const maxRugRatio = req.body.max_rug_ratio != null ? Number(req.body.max_rug_ratio) : null;

    const info = db.prepare(`
      INSERT INTO push_subscriptions
        (device_id, push_token, enabled, chain, types, filter_preset, min_smart_degen, min_volume_24h, max_rug_ratio)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(id, push_token, chain, JSON.stringify(rawTypes), filterPreset, minSmartDegen, minVolume24h, maxRugRatio);

    res.json({
      subscription: db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(info.lastInsertRowid),
    });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * GET /api/notifications/subscriptions
 * Header: X-Device-Id
 */
router.get('/subscriptions', (req, res) => {
  try {
    const id = deviceId(req);
    const list = db.prepare(
      'SELECT * FROM push_subscriptions WHERE device_id = ? ORDER BY id DESC'
    ).all(id);
    res.json({ subscriptions: list.map((s) => ({ ...s, types: JSON.parse(s.types) })) });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * PATCH /api/notifications/subscriptions/:id
 * Body: { enabled? } (toggles on/off)
 */
router.patch('/subscriptions/:id', (req, res) => {
  try {
    const id = deviceId(req);
    const subId = Number(req.params.id);
    const current = db.prepare('SELECT * FROM push_subscriptions WHERE id = ? AND device_id = ?').get(subId, id);
    if (!current) throw Object.assign(new Error('Subscription not found'), { status: 404 });

    const enabled = req.body.enabled != null ? (req.body.enabled ? 1 : 0) : current.enabled;
    db.prepare('UPDATE push_subscriptions SET enabled = ? WHERE id = ?').run(enabled, subId);
    const updated = db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(subId);
    res.json({ subscription: { ...updated, types: JSON.parse(updated.types) } });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * DELETE /api/notifications/subscriptions/:id
 */
router.delete('/subscriptions/:id', (req, res) => {
  try {
    const id = deviceId(req);
    const subId = Number(req.params.id);
    const info = db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND device_id = ?').run(subId, id);
    if (!info.changes) throw Object.assign(new Error('Subscription not found'), { status: 404 });
    db.prepare('DELETE FROM notified_tokens WHERE subscription_id = ?').run(subId);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

export default router;