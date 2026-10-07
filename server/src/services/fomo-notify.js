/**
 * FOMO per-feed alert notifications (graduados + trending).
 *
 * The app stores each tab's filters server-side (PUT /api/market/fomo/notify)
 * and the delivery toggles per device inside the notification config
 * (`fomo_graduated_alerts` / `fomo_trending_alerts`, merge-only fields of
 * PUT /api/notifications/config). fomo-ws feeds every ingested record here;
 * a record that NEWLY matches its feed's filters is recorded in the
 * notification history (category `fomo`, column = feed) and pushed to every
 * enabled device.
 *
 * Lifecycle:
 *  - Feed inactive (no filters configured yet, or no device with the toggle
 *    on) → nothing is evaluated at all.
 *  - The first evaluation pass after activation silently marks the currently
 *    matching tokens — no burst on boot, on enabling the toggle or after a
 *    filter change (reseedFomoFeed() re-arms that silent pass).
 *  - `matched` tracks which addresses currently match, so a transition into
 *    the filter set (new token, mcap crossing the band) notifies exactly once;
 *    a per-feed+address cooldown absorbs oscillations around a bound.
 *  - The KOL bound (kolMin) resolves counts through fomo-ws's shared cache
 *    (setFomoFeeder) and the age bound (ageMaxMin) resolves `createdAt` for
 *    trending records upstream never sends — both async, only for records
 *    that pass every other bound.
 *
 * No import cycle: fomo-ws imports this module and injects the live token
 * maps + the KOL/age resolvers via setFomoFeeder().
 */
import { JsonStore } from '../json-store.js';
import { notificationConfig, notificationHistory, pushSubscriptions } from '../stores.js';
import { broadcast } from './ws-server.js';
import { sendPush, isValidPushToken } from './push.js';

const FEEDS = ['graduated', 'trending'];
/** Re-notify the same feed+address at most this often (bound oscillations). */
const NOTIFY_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const FOMO_HISTORY_MAX = 200;
const NOTIFY_MEM_CAP = 5_000;

const store = new JsonStore('fomo-notify');

const EMPTY_FILTERS = Object.freeze({
  ageMaxMin: null,
  mcapMin: null,
  mcapMax: null,
  kolMin: null,
});

/** Injected by fomo-ws: live token map per feed + KOL/age resolvers. */
let readTokens = () => new Map();
let resolveKol = async () => null;
let resolveAge = async () => null;

export function setFomoFeeder({ readTokens: read, resolveKol: kol, resolveAge: age } = {}) {
  if (read) readTokens = read;
  if (kol) resolveKol = kol;
  if (age) resolveAge = age;
}

function toBound(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sanitizeFilters(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    ageMaxMin: toBound(raw.ageMaxMin),
    mcapMin: toBound(raw.mcapMin),
    mcapMax: toBound(raw.mcapMax),
    kolMin: toBound(raw.kolMin),
  };
}

export function getFomoNotifyFilters() {
  return {
    graduated: store.get('filters_graduated') ?? EMPTY_FILTERS,
    trending: store.get('filters_trending') ?? EMPTY_FILTERS,
  };
}

/**
 * Replace the given feeds' filters (partial update) and re-arm the silent
 * re-evaluation pass so widened filters never burst the current list.
 */
export function setFomoNotifyFilters(partial) {
  for (const feed of FEEDS) {
    if (!partial || !(feed in partial)) continue;
    const clean = sanitizeFilters(partial[feed]);
    if (!clean) continue;
    store.set(`filters_${feed}`, clean);
    store.set('updated_at', new Date().toISOString());
    reseedFomoFeed(feed);
  }
  return getFomoNotifyFilters();
}

// ── Evaluation state ──
/** Addresses of each feed that currently match the configured filters. */
const matched = { graduated: new Set(), trending: new Set() };
/** `${feed}:${address}` → last notify timestamp (cooldown). */
const lastNotified = new Map();
/** First pass after activation marks matches silently instead of notifying. */
const seeded = { graduated: false, trending: false };
/** KOL lookups in flight (`${feed}:${address}`). */
const kolInflight = new Set();
/** Age (creation time) lookups in flight — trending records have none. */
const ageInflight = new Set();

/** Filters changed or the toggle was just enabled → silent pass next. */
export function reseedFomoFeed(feed) {
  if (!matched[feed]) return;
  matched[feed].clear();
  seeded[feed] = false;
}

/** The token left the upstream list — stop tracking it (cooldown persists). */
export function forgetFomoRecord(feed, address) {
  matched[feed]?.delete(address);
}

function enabledDevices(feed) {
  const flag = feed === 'trending' ? 'fomo_trending_alerts' : 'fomo_graduated_alerts';
  return Object.values(notificationConfig.getAll())
    .filter((d) => d?.[flag] === true && isValidPushToken(d.push_token));
}

/** Active = filters configured for the tab AND at least one device opted in. */
function feedActive(feed) {
  return store.has(`filters_${feed}`) && enabledDevices(feed).length > 0;
}

/**
 * Bounds that decide without the network. The age bound is only checked when
 * the creation time is known — records without one (trending) are resolved
 * asynchronously in evaluate(); a failed resolve excludes them (same
 * semantics as a token without KOL data).
 */
function boundsOk(feed, rec, f) {
  if (f.ageMaxMin != null && rec.createdAt != null) {
    const age = Math.floor(Date.now() / 1000) - rec.createdAt;
    if (age > f.ageMaxMin * 60) return false;
  }
  if (f.mcapMin != null || f.mcapMax != null) {
    if (rec.mcap == null) return false;
    if (f.mcapMin != null && rec.mcap < f.mcapMin) return false;
    if (f.mcapMax != null && rec.mcap > f.mcapMax) return false;
  }
  return true;
}

/**
 * Record a match transition: entering the set delivers (unless silent or in
 * cooldown); leaving it clears the address so a later re-entry notifies again.
 */
function decide(feed, rec, isMatch, silent) {
  const set = matched[feed];
  if (!isMatch) {
    set.delete(rec.address);
    return;
  }
  if (set.has(rec.address)) return;
  set.add(rec.address);
  if (silent) return;
  deliver(feed, rec);
}

function evaluate(feed, rec, silent) {
  const f = store.get(`filters_${feed}`) ?? EMPTY_FILTERS;
  if (!boundsOk(feed, rec, f)) {
    decide(feed, rec, false, silent);
    return;
  }
  if (f.ageMaxMin != null && rec.createdAt == null) {
    // Creation time unknown (trending never has one upstream) — Pulse
    // resolves it, then this record re-enters evaluation. No resolve →
    // excluded; a later update retries (token-age memoizes failures for 60s,
    // so retries are cached, never a burst).
    const key = `age:${feed}:${rec.address}`;
    if (ageInflight.has(key)) return;
    ageInflight.add(key);
    resolveAge(rec.address)
      .then((ts) => {
        ageInflight.delete(key);
        if (ts == null) {
          decide(feed, rec, false, silent);
          return;
        }
        rec.createdAt = ts;
        evaluate(feed, rec, silent);
      })
      .catch(() => ageInflight.delete(key));
    return;
  }
  if (f.kolMin == null) {
    decide(feed, rec, true, silent);
    return;
  }
  if (rec.kolCount != null) {
    decide(feed, rec, rec.kolCount >= f.kolMin, silent);
    return;
  }
  // KOL bound needs the network — resolve once, then decide like the sync path.
  const key = `${feed}:${rec.address}`;
  if (kolInflight.has(key)) return;
  kolInflight.add(key);
  resolveKol(rec.address)
    .then((count) => {
      kolInflight.delete(key);
      if (count != null) rec.kolCount = count; // cache on the record for reads
      if (count == null) return; // no data yet → the next update retries
      decide(feed, rec, count >= f.kolMin, silent);
    })
    .catch(() => kolInflight.delete(key));
}

/**
 * A feed snapshot arrived: the first pass after activation marks the whole
 * current list silently; later snapshots (reconnects) evaluate normally —
 * already-matched addresses are no-ops, genuinely new ones notify.
 */
export function noteFomoSnapshot(feed, tokens) {
  if (!matched[feed] || !feedActive(feed)) return;
  const silent = !seeded[feed];
  for (const rec of tokens.values()) evaluate(feed, rec, silent);
  if (silent) seeded[feed] = true;
}

/** One ingested record (update / newly listed token). */
export function handleFomoRecord(feed, rec) {
  if (!matched[feed] || !feedActive(feed)) return;
  if (!seeded[feed]) {
    // First activity after activation: mark the current list silently.
    for (const r of readTokens(feed).values()) evaluate(feed, r, true);
    seeded[feed] = true;
    return; // the full pass already covered this record (it lives in the map)
  }
  evaluate(feed, rec, false);
}

function fmtUsd(n) {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function trimNotifyMem(now) {
  if (lastNotified.size <= NOTIFY_MEM_CAP) return;
  const keep = [...lastNotified]
    .sort((a, b) => b[1] - a[1])
    .slice(0, NOTIFY_MEM_CAP / 2);
  lastNotified.clear();
  for (const [k, t] of keep) lastNotified.set(k, t);
}

/** History entry + live History update + Expo push to every opted-in device. */
function deliver(feed, rec) {
  const now = Date.now();
  const coolKey = `${feed}:${rec.address}`;
  const prev = lastNotified.get(coolKey);
  if (prev && now - prev < NOTIFY_COOLDOWN_MS) return;
  const devices = enabledDevices(feed);
  if (!devices.length) return;
  lastNotified.set(coolKey, now);
  trimNotifyMem(now);

  const column = feed; // 'graduated' | 'trending'
  const nowIso = new Date().toISOString();
  const saved = notificationHistory.add({
    device_id: 'fomo',
    address: rec.address,
    chain: 'sol',
    column,
    symbol: rec.symbol,
    name: rec.name,
    category: 'fomo',
    mcap: rec.mcap,
    liq: null,
    vol24h: rec.vol24h,
    logo: rec.image,
    smart_degen_count: null,
    renowned_count: rec.kolCount ?? null,
    fresh_wallet_rate: null,
    bot_degen_count: null,
    bot_degen_rate: null,
    rug_ratio: null,
    bundler_rate: null,
    bundler_trader_amount_rate: null,
    entrapment_ratio: null,
    bundle_holders_count: null,
    buys_count: null,
    tp_holders_count: null,
    top_holders_rate: null,
    holders_count: rec.holders,
    entered_at: nowIso,
    notified_at: nowIso,
    filter_matched_at: nowIso,
  });

  // Cap this category at FOMO_HISTORY_MAX (drop the oldest).
  const fomoEntries = notificationHistory.getAll().filter((e) => e.category === 'fomo');
  if (fomoEntries.length > FOMO_HISTORY_MAX) {
    const ordered = [...fomoEntries].sort((a, b) => (a.notified_at || '').localeCompare(b.notified_at || ''));
    for (const old of ordered.slice(0, fomoEntries.length - FOMO_HISTORY_MAX)) {
      notificationHistory.delete((e) => e.id === old.id);
    }
  }

  // Live push: History merges `notification_new` on `notifications:{device}`.
  for (const dev of pushSubscriptions.getAll()) {
    if (dev?.device_id) broadcast(`notifications:${dev.device_id}`, { event: 'notification_new', data: saved });
  }

  deliverPushes(devices, feed, rec).catch(() => {});
}

async function deliverPushes(devices, feed, rec) {
  const label = feed === 'trending' ? 'FOMO Trending' : 'FOMO Graduados';
  const parts = [];
  if (feed === 'trending' && rec.rank != null) parts.push(`#${rec.rank + 1}`);
  if (feed === 'graduated' && rec.createdAt != null) {
    parts.push(`${Math.max(1, Math.round((Date.now() / 1000 - rec.createdAt) / 60))}m`);
  }
  if (rec.mcap != null) parts.push(`MC ${fmtUsd(rec.mcap)}`);
  if (rec.vol24 != null) parts.push(`Vol ${fmtUsd(rec.vol24)}`);
  if (rec.change24 != null) parts.push(`${rec.change24 >= 0 ? '+' : ''}${(rec.change24 * 100).toFixed(0)}%`);
  if (rec.kolCount != null) parts.push(`${rec.kolCount} KOL`);
  const body = parts.join(' · ') || 'Pasa tus filtros';
  const type = feed === 'trending' ? 'fomo_trending' : 'fomo_graduated';

  for (const dev of devices) {
    try {
      const { result } = await sendPush(dev.push_token, {
        title: `${rec.symbol || rec.name || 'Token'} — ${label}`,
        body,
        data: { address: rec.address, chain: 'sol', symbol: rec.symbol, type },
      });
      if (result?.data?.status === 'error') {
        console.error(`[fomo-notify] push failed: ${result.data.message}`);
      }
    } catch (err) {
      console.error(`[fomo-notify] push deliver error: ${err.message}`);
    }
  }
}
