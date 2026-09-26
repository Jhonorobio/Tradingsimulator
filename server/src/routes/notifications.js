import { Router } from 'express';
import { notificationConfig, notificationHistory, winners } from '../stores.js';
import { isValidPushToken } from '../services/push.js';
import { getSnapshots, getAllTracks } from '../services/token-snapshots.js';

const router = Router();

const VALID_CATEGORIES = ['new_creation', 'completed', 'x_tracker'];

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
        categories: { new_creation: false, completed: false, x_tracker: false },
        filters: {},
      });
    }
    const categories = {};
    for (const key of VALID_CATEGORIES) categories[key] = !!entry.categories?.[key];
    res.json({
      push_token: entry.push_token,
      categories,
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
    // Copy before sorting: getAll() returns the store's live array and poller
    // cap logic relies on its oldest-first insertion order.
    const entries = [...notificationHistory.getAll()]
      // Sort first so the newest entry per token wins the dedupe below —
      // x_tracker can produce several entries for the same address.
      .sort((a, b) => (b.notified_at || '').localeCompare(a.notified_at || ''))
      .filter((e, i, arr) => arr.findIndex(x => x.address === e.address && x.category === e.category) === i)
      .slice(0, limit)
      .map((e) => ({ ...e, snapshots: getSnapshots(e.address, e.category) }));
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
      .slice(0, 100)
      .map((e) => ({ ...e, snapshots: getSnapshots(e.address, e.category) }));
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
      const valid = ['sol'];
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

/**
 * POST /api/notifications/winners/reanalyze
 * Re-checks all history tokens against winner criteria and saves new winners.
 */
router.post('/winners/reanalyze', (_req, res) => {
  try {
    const entries = notificationHistory.getAll()
      .filter((e, i, arr) => arr.findIndex(x => x.address === e.address && x.category === e.category) === i);

    let added = 0;
    for (const entry of entries) {
      const existing = winners.getAll();
      if (existing.some((w) => w.address === entry.address && w.category === entry.category)) continue;

      const snapshots = getSnapshots(entry.address, entry.category);
      if (!snapshots || snapshots.length < 2) continue;

      const firstMcap = snapshots[0]?.usd_market_cap ?? snapshots[0]?.market_cap ?? entry.mcap;
      if (!firstMcap || firstMcap <= 0) continue;

      const maxMcap = snapshots.reduce((max, s) => {
        const v = s.usd_market_cap ?? s.market_cap;
        return v != null && v > max ? v : max;
      }, firstMcap);
      const gain = ((maxMcap - firstMcap) / firstMcap) * 100;

      const firstTime = new Date(snapshots[0].t).getTime();
      let peakMcap = 0;
      let peakTime = firstTime;
      for (const s of snapshots) {
        const v = s.usd_market_cap ?? s.market_cap;
        if (v != null && v > peakMcap) {
          peakMcap = v;
          peakTime = new Date(s.t).getTime();
        }
      }
      const timeToPeak = (peakTime - firstTime) / 60000;

      if (gain < 100 || timeToPeak < 2) continue;

      winners.add({
        address: entry.address,
        chain: entry.chain,
        symbol: entry.symbol,
        name: entry.name,
        category: entry.category,
        mcap: entry.mcap,
        logo: entry.logo,
        gain_pct: gain,
        time_to_peak_minutes: timeToPeak,
        added_at: new Date().toISOString(),
      });
      added++;
    }

    const all = winners.getAll();
    if (all.length > 100) {
      const sorted = all.sort((a, b) => (a.added_at || '').localeCompare(b.added_at || ''));
      const toRemove = sorted.slice(0, all.length - 100);
      for (const old of toRemove) {
        winners.delete((w) => w.id === old.id);
      }
    }

    res.json({ ok: true, added, total: winners.getAll().length });
  } catch (err) {
    fail(res, err);
  }
});

export default router;
