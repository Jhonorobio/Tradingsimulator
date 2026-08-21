import { Router } from 'express';
import { pushSubscriptions, notifiedTokens } from '../stores.js';
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

    const subscription = pushSubscriptions.add({
      device_id: id,
      push_token,
      enabled: 1,
      chain,
      types: rawTypes,
      filter_preset: filterPreset,
      min_smart_degen: minSmartDegen,
      min_volume_24h: minVolume24h,
      max_rug_ratio: maxRugRatio,
      created_at: new Date().toISOString(),
    });

    res.json({ subscription });
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
    const list = pushSubscriptions.filter((s) => s.device_id === id);
    list.sort((a, b) => (b.id || 0) - (a.id || 0));
    res.json({ subscriptions: list });
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
    const current = pushSubscriptions.getById(subId);
    if (!current || current.device_id !== id) {
      throw Object.assign(new Error('Subscription not found'), { status: 404 });
    }

    const enabled = req.body.enabled != null ? (req.body.enabled ? 1 : 0) : current.enabled;
    const updated = pushSubscriptions.update((s) => s.id === subId, { enabled });
    res.json({ subscription: updated });
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
    const current = pushSubscriptions.getById(subId);
    if (!current || current.device_id !== id) {
      throw Object.assign(new Error('Subscription not found'), { status: 404 });
    }
    pushSubscriptions.delete((s) => s.id === subId);
    notifiedTokens.delete(String(subId));
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

export default router;
