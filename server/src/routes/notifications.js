import { Router } from 'express';
import { notificationConfig, notificationHistory, winners } from '../stores.js';
import { isValidPushToken } from '../services/push.js';
import { getSnapshots, getAllTracks, getTracksStatus } from '../services/token-snapshots.js';
import { resetTweetCondQuota } from '../services/xtracker-watcher.js';
import { reseedFomoFeed } from '../services/fomo-notify.js';

const router = Router();

const VALID_CATEGORIES = ['new_creation', 'completed', 'x_tracker', 'photon_new', 'photon_graduated'];
// Tracker tweet conditions: which tracked-token tweets notify, per category.
const TWEET_CONDITIONS = ['watchlist', 'others'];
const TWEET_CATEGORIES = ['new_creation', 'completed', 'photon_new', 'photon_graduated'];

function defaultTrackerTweets() {
  const out = {};
  for (const cond of TWEET_CONDITIONS) {
    out[cond] = {};
    for (const cat of TWEET_CATEGORIES) out[cond][cat] = false;
  }
  return out;
}

function sanitizeTrackerTweets(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = defaultTrackerTweets();
  for (const cond of TWEET_CONDITIONS) {
    const m = raw[cond];
    if (!m || typeof m !== 'object') continue;
    for (const cat of TWEET_CATEGORIES) out[cond][cat] = !!m[cat];
  }
  return out;
}

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
    const { push_token, categories, filters, tracker_tweets, vol_mcap_alerts, vol_mcap_min_mcap, vol_mcap_kol,
      fomo_graduated_alerts, fomo_trending_alerts } = req.body || {};

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

    // Tracker tweet flags are independent of the main category toggles: only
    // replace them when the client sends the object (old clients keep theirs).
    let trackerTweets;
    if (tracker_tweets !== undefined) {
      trackerTweets = sanitizeTrackerTweets(tracker_tweets) || defaultTrackerTweets();
      // Toggling a condition resets every token's "2 notifications" quota.
      for (const cond of TWEET_CONDITIONS) {
        const before = JSON.stringify(existing?.tracker_tweets?.[cond] ?? null);
        if (before !== JSON.stringify(trackerTweets[cond])) {
          resetTweetCondQuota(id, cond);
        }
      }
    } else {
      trackerTweets = sanitizeTrackerTweets(existing?.tracker_tweets) || defaultTrackerTweets();
    }

    // Independent toggle (like tracker_tweets): only replaced when the client
    // sends it; missing everywhere → ON by default.
    const volMcapAlerts = vol_mcap_alerts !== undefined
      ? !!vol_mcap_alerts
      : existing ? existing.vol_mcap_alerts !== false : true;

    // Optional conditions for the vol≈mcap alert: a minimum market cap in USD
    // (null = off) and a ≥1 KOL holder requirement (off by default). Each is
    // replaced only when the client sends it, so old clients keep their value.
    const volMcapMinMcap = vol_mcap_min_mcap !== undefined
      ? (typeof vol_mcap_min_mcap === 'number' && Number.isFinite(vol_mcap_min_mcap) && vol_mcap_min_mcap > 0
        ? Math.round(vol_mcap_min_mcap)
        : null)
      : (typeof existing?.vol_mcap_min_mcap === 'number' ? existing.vol_mcap_min_mcap : null);
    const volMcapKol = vol_mcap_kol !== undefined
      ? !!vol_mcap_kol
      : existing?.vol_mcap_kol === true;

    // Per-feed FOMO alert toggles (off by default, merge-only like vol_mcap):
    // enabling a feed re-arms fomo-notify's silent pass so the tokens already
    // matching the filters don't burst on the moment the switch flips on.
    const fomoGrad = fomo_graduated_alerts !== undefined
      ? !!fomo_graduated_alerts
      : existing?.fomo_graduated_alerts === true;
    const fomoTrend = fomo_trending_alerts !== undefined
      ? !!fomo_trending_alerts
      : existing?.fomo_trending_alerts === true;
    if (fomoGrad && existing?.fomo_graduated_alerts !== true) reseedFomoFeed('graduated');
    if (fomoTrend && existing?.fomo_trending_alerts !== true) reseedFomoFeed('trending');

    notificationConfig.set(id, {
      device_id: id,
      push_token,
      categories: cats,
      filters: mergedFilters,
      tracker_tweets: trackerTweets,
      vol_mcap_alerts: volMcapAlerts,
      vol_mcap_min_mcap: volMcapMinMcap,
      vol_mcap_kol: volMcapKol,
      fomo_graduated_alerts: fomoGrad,
      fomo_trending_alerts: fomoTrend,
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
        categories: { new_creation: false, completed: false, x_tracker: false, photon_new: false, photon_graduated: false },
        filters: {},
        tracker_tweets: defaultTrackerTweets(),
        vol_mcap_alerts: true,
        vol_mcap_min_mcap: null,
        vol_mcap_kol: false,
        fomo_graduated_alerts: false,
        fomo_trending_alerts: false,
      });
    }
    const categories = {};
    for (const key of VALID_CATEGORIES) categories[key] = !!entry.categories?.[key];
    res.json({
      push_token: entry.push_token,
      categories,
      filters: entry.filters || {},
      tracker_tweets: sanitizeTrackerTweets(entry.tracker_tweets) || defaultTrackerTweets(),
      vol_mcap_alerts: entry.vol_mcap_alerts !== false,
      vol_mcap_min_mcap: typeof entry.vol_mcap_min_mcap === 'number' ? entry.vol_mcap_min_mcap : null,
      vol_mcap_kol: entry.vol_mcap_kol === true,
      fomo_graduated_alerts: entry.fomo_graduated_alerts === true,
      fomo_trending_alerts: entry.fomo_trending_alerts === true,
    });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Notification history cards, newest first, capped at `limit`.
 *
 * Tweet records (category `x_tracker`) are never rendered as their own card.
 * Instead every stored tweet record is merged into the token's ORIGINAL card
 * as `tweet_notified_at` (ascending ISO times, last 5) so the card shows
 * "notificó por tweet" + hora alongside the normal data/timeline.
 */
export function buildHistoryEntries(limit) {
  // Copy before sorting: getAll() returns the store's live array and poller
  // cap logic relies on its oldest-first insertion order.
  const all = [...notificationHistory.getAll()]
    // Sort first so the newest entry per token wins the dedupe below — the
    // same address can produce several categories. Photon keeps one entry
    // per column (new/graduated), so `column` joins the key.
    .sort((a, b) => (b.notified_at || '').localeCompare(a.notified_at || ''));

  // Tweet times per address — collected before dedupe/limit so every tweet
  // record counts even when several exist for the same token.
  const tweetsByAddr = new Map();
  for (const e of all) {
    if (e.category !== 'x_tracker' || !e.address) continue;
    const list = tweetsByAddr.get(e.address) || [];
    if (e.notified_at) list.push(e.notified_at);
    tweetsByAddr.set(e.address, list);
  }

  return all
    .filter((e) => e.category !== 'x_tracker')
    .filter((e, i, arr) => arr.findIndex(
      (x) => x.address === e.address && x.category === e.category
        && (x.column ?? null) === (e.column ?? null),
    ) === i)
    .slice(0, limit)
    .map((e) => {
      const card = { ...e, snapshots: getSnapshots(e.address, e.category) };
      const times = tweetsByAddr.get(e.address);
      return times?.length ? { ...card, tweet_notified_at: [...times].sort().slice(-5) } : card;
    });
}

/**
 * GET /api/notifications/history
 * Header: X-Device-Id
 * Query: limit (default 50, max 200)
 * Returns global notification history, newest first.
 */
router.get('/history', (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 300);
    res.json({ history: buildHistoryEntries(limit) });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * GET /api/notifications/snapshots/status
 * Diagnostics: active track counts per category (open/closed totals).
 */
router.get('/snapshots/status', (_req, res) => {
  try {
    res.json({ tracks: getTracksStatus() });
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
