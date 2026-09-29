/**
 * Background Tracker watcher.
 *
 * Ingests every token that shows up in trenches or photon into a persistent
 * watchlist (it survives disappearing from the lists) and then, on a 10s tick:
 *
 *   1. Dexscreener phase (free, batch of 30 addresses per request)
 *     - mcap < 8_000            -> stop tracking (mcap_below_8k)
 *     - 3 checks w/o any pair   -> stop tracking (no_pairs)
 *     - older than 1h           -> stop tracking (max_age)
 *
 *   2. Tweet phase (GMGN mentions) — ONLY while at least one device has a
 *      `tracker_tweets` flag enabled, and only for tracked tokens whose source
 *      categories have at least one flag on (any device). Conditions per
 *      category:
 *        - watchlist: tweets by @AutorunAlert / @bitecong
 *        - others:    every other tweet (no follower minimum)
 *      Old and new tweets count alike: whatever matches a device's enabled
 *      condition is announced — the first fetches drain the old backlog at
 *      MAX_NOTIFY_PER_TICK per token per tick, and tweets no device wants
 *      stay pending until a matching condition is enabled. Each condition
 *      (watchlist / others) delivers at most TWEET_COND_LIMIT notifications
 *      PER TOKEN per device, each one from a DIFFERENT tweet author — a
 *      newly tracked token starts with a fresh quota, so one token's
 *      notifications never block another's; repeats from an
 *      already-notified author are skipped and every token's counters reset
 *      when the condition is toggled.
 *      Every delivered tweet pushes "… — Tracker" and stores an `x_tracker`
 *      history record that is merged into the token's original card as
 *      "notificó por tweet" + hora (separate Tracker cards are not shown).
 *
 * State is mutated in memory and flushed to disk at most once per tick.
 */

import { tokenWatchlist, notificationConfig, notificationHistory, tweetCondCounts, pushSubscriptions } from '../stores.js';
import { fetchTokensBatch } from './dexscreener.js';
import { getMentions, getMentionsStatus } from './gmgn-mentions.js';
import { sendPush } from './push.js';
import { broadcast } from './ws-server.js';

const TICK_MS = Number(process.env.XTRACKER_TICK_MS) || 10_000;
const MAX_AGE_MS = 60 * 60 * 1000;   // 1h rastreando como máximo
const MAX_MCAP = 8_000;              // por debajo se deja de rastrear
const NO_PAIRS_MAX = 3;              // chequeos consecutivos sin par
const PRUNE_STOPPED_MS = 24 * 60 * 60 * 1000; // tokens detenidos se borran a las 24h

// Tweet phase
const ALLOWLIST_ACCOUNTS = new Set(['autorunalert', 'bitecong']); // lowercased
const TWEET_CONDITIONS = ['watchlist', 'others'];
const TWEET_CATEGORIES = ['new_creation', 'completed', 'photon_new', 'photon_graduated'];
const X_DUE_MS = 10_000;             // cadencia mínima por token
const MAX_X_ENQUEUE_PER_TICK = 100;  // peticiones GMGN nuevas por tick (10s)
const MAX_X_QUEUE = 100;             // backpressure sobre la cola de GMGN
const MAX_NOTIFY_PER_TICK = 5;       // tweets por token/tick (el resto se reintenta)
const MAX_IDS = 300;                 // tweets recordados por token
const HISTORY_MAX_X = 300;           // entradas de historial category=x_tracker

const watchlist = tokenWatchlist.getAll(); // live reference, flushed by flush()
let dirty = false;
let timer = null;
let lastTickAt = null;
let lastDexAt = null;
let lastFlushAt = null;
const inFlight = new Set();

// ─── helpers ────────────────────────────────────────────────────────────────

function tweetTime(t) {
  let n = Number(t?.tw_timestamp);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n < 1e11) n *= 1000; // seconds -> ms
  return n;
}

function followersOf(item) {
  return Number(item?.user?.followers) || 0;
}

function fmtUsd(n) {
  if (n == null || isNaN(n)) return 'n/a';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtFollowers(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** 'watchlist' for the followed accounts, 'others' for everything else. */
export function classifyTweetAuthor(screenName) {
  const s = String(screenName || '').replace(/^@/, '').toLowerCase();
  return ALLOWLIST_ACCOUNTS.has(s) ? 'watchlist' : 'others';
}

/** Source categories of a watchlist entry (legacy 'photon' matches both). */
export function entryTweetCategories(entry) {
  const out = [];
  for (const c of entry?.categories || []) {
    if (c === 'photon') {
      if (!out.includes('photon_new')) out.push('photon_new');
      if (!out.includes('photon_graduated')) out.push('photon_graduated');
      continue;
    }
    if (TWEET_CATEGORIES.includes(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

// ─── watchlist ──────────────────────────────────────────────────────────────

function newEntry(address, token) {
  return {
    address,
    chain: token.chain || 'sol',
    symbol: token.symbol ?? null,
    name: token.name ?? null,
    logo: token.logo ?? null,
    categories: [],
    status: 'active',
    stop_reason: null,
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    stopped_at: null,
    mcap: null,
    liquidity: null,
    checks: 0,
    no_pairs: 0,
    last_dex_check: null,
    last_x_check: null,
    tweets: { notified_ids: [] },
  };
}

/**
 * Registers every token from a trenches/photon response into the watchlist.
 * Tokens already stopped are never resurrected.
 * @returns {number} how many brand-new entries were created
 */
export function ingestTrenches(tokens, category) {
  if (!Array.isArray(tokens)) return 0;
  const now = new Date().toISOString();
  let added = 0;
  for (const t of tokens) {
    if (!t?.address) continue;
    let e = watchlist[t.address];
    if (!e) {
      e = watchlist[t.address] = newEntry(t.address, t);
      added += 1;
    }
    if (e.status !== 'active') continue;
    if (t.symbol != null) e.symbol = t.symbol;
    if (t.name != null) e.name = t.name;
    if (t.logo != null) e.logo = t.logo;
    if (category && !e.categories.includes(category)) e.categories.push(category);
    e.last_seen = now;
    const mcap = t.usd_market_cap ?? t.market_cap ?? null;
    if (mcap != null) e.mcap = mcap;
    const liq = t.liquidity ?? null;
    if (liq != null) e.liquidity = liq;
    dirty = true;
  }
  return added;
}

function stopEntry(e, reason) {
  if (e.status === 'stopped') return;
  e.status = 'stopped';
  e.stop_reason = reason;
  e.stopped_at = new Date().toISOString();
  dirty = true;
  console.log(`[tracker] stop ${e.symbol || e.address} (${reason})`);
}

function activeEntries() {
  const out = [];
  for (const e of Object.values(watchlist)) {
    if (e?.status === 'active') out.push(e);
  }
  return out;
}

/** Drops stopped entries older than PRUNE_STOPPED_MS so the file stays small. */
function pruneStopped() {
  const cutoff = Date.now() - PRUNE_STOPPED_MS;
  for (const [address, e] of Object.entries(watchlist)) {
    if (e?.status !== 'stopped') continue;
    const at = new Date(e.stopped_at || e.first_seen).getTime();
    if (Number.isFinite(at) && at < cutoff) {
      delete watchlist[address];
      dropTokenQuota(address);
      dirty = true;
    }
  }
}

function flush() {
  if (!dirty) return;
  tokenWatchlist.setAll(watchlist);
  dirty = false;
  lastFlushAt = new Date().toISOString();
}

// ─── tweet conditions ───────────────────────────────────────────────────────

function hasAnyTweetFlag(flags) {
  if (!flags || typeof flags !== 'object') return false;
  for (const cond of TWEET_CONDITIONS) {
    const m = flags[cond];
    if (!m || typeof m !== 'object') continue;
    for (const cat of TWEET_CATEGORIES) if (m[cat]) return true;
  }
  return false;
}

/** True when the device has at least one tracker tweet condition enabled. */
export function hasActiveTweetConditions(flags) {
  return hasAnyTweetFlag(flags);
}

// ─── tweet condition quota (per token) ─────────────────────────────────────

const TWEET_COND_LIMIT = 2; // usuarios distintos por condición, por token

function quotaKey(deviceId, cond, address) {
  return `${deviceId}:${cond}:${address}`;
}

/** Authors already notified for this token+device+condition (lowercased). */
function condAuthors(entry, deviceId, cond) {
  const address = entry?.address;
  if (!deviceId || !TWEET_CONDITIONS.includes(cond) || !address) return [];
  const raw = tweetCondCounts.get(quotaKey(deviceId, cond, address));
  if (raw == null) return [];
  if (typeof raw === 'object' && Array.isArray(raw.authors)) return raw.authors;
  return [];
}

/** Notifications still available for this token+device+condition. */
export function tweetCondQuotaLeft(entry, deviceId, cond) {
  return Math.max(0, TWEET_COND_LIMIT - condAuthors(entry, deviceId, cond).length);
}

/**
 * Whether this token+device+condition may notify a tweet from `authorKey`:
 * the token's quota must have room AND this author must not have been
 * notified for THIS token yet (each of the 2 notifications comes from a
 * different user). Quota is tracked per token, so a freshly tracked token
 * always starts with TWEET_COND_LIMIT slots — one token's notifications
 * never block another's.
 */
export function tweetCondCanNotify(entry, deviceId, cond, authorKey) {
  if (!entry?.address) return false;
  if (tweetCondQuotaLeft(entry, deviceId, cond) <= 0) return false;
  const key = String(authorKey || 'tweet').toLowerCase();
  return !condAuthors(entry, deviceId, cond).includes(key);
}

/** Counts one delivered notification against THIS token's quota. */
export function recordTweetCondAuthor(entry, deviceId, cond, authorKey) {
  const address = entry?.address;
  if (!deviceId || !TWEET_CONDITIONS.includes(cond) || !address) return;
  const key = String(authorKey || 'tweet').toLowerCase();
  const authors = condAuthors(entry, deviceId, cond);
  if (authors.includes(key)) return;
  tweetCondCounts.set(quotaKey(deviceId, cond, address), { authors: [...authors, key].slice(-TWEET_COND_LIMIT) });
}

/** Clears every token's quota for a condition — called on toggle. */
export function resetTweetCondQuota(deviceId, cond) {
  if (!deviceId || !TWEET_CONDITIONS.includes(cond)) return;
  const prefix = `${deviceId}:${cond}:`;
  const legacy = `${deviceId}:${cond}`; // pre per-token global counter
  for (const key of Object.keys(tweetCondCounts.getAll())) {
    if (key === legacy || key.startsWith(prefix)) tweetCondCounts.delete(key);
  }
}

/** Drops a pruned token's quota entries so the store can't grow forever. */
function dropTokenQuota(address) {
  if (!address) return;
  for (const deviceId of Object.keys(notificationConfig.getAll())) {
    for (const cond of TWEET_CONDITIONS) {
      const key = `${deviceId}:${cond}:${address}`;
      if (tweetCondCounts.has(key)) tweetCondCounts.delete(key);
    }
  }
}

/** Devices with at least one tracker_tweets flag enabled, with their flags. */
function trackerTweetDevices() {
  return Object.values(notificationConfig.getAll())
    .filter((e) => e?.push_token && hasAnyTweetFlag(e?.tracker_tweets))
    .map((e) => ({ device: e, flags: e.tracker_tweets }));
}

/** Global set of categories with at least one flag on (any device). */
function enabledTweetCategories(devices) {
  const set = new Set();
  for (const { flags } of devices) {
    for (const cond of TWEET_CONDITIONS) {
      const m = flags?.[cond];
      if (!m || typeof m !== 'object') continue;
      for (const cat of TWEET_CATEGORIES) if (m[cat]) set.add(cat);
    }
  }
  return set;
}

// ─── dexscreener phase ──────────────────────────────────────────────────────

async function dexPhase() {
  const active = activeEntries();
  if (!active.length) return;

  const now = Date.now();

  // mcap max age applies even if the batch request fails
  for (const e of active) {
    if (now - new Date(e.first_seen).getTime() >= MAX_AGE_MS) stopEntry(e, 'max_age');
  }
  const live = active.filter((e) => e.status === 'active');
  if (!live.length) return;

  const { results, failed } = await fetchTokensBatch(live.map((e) => e.address));
  lastDexAt = new Date().toISOString();

  for (let i = 0; i < live.length; i++) {
    const e = live[i];
    if (e.status !== 'active') continue;
    if (now - new Date(e.first_seen).getTime() >= MAX_AGE_MS) { stopEntry(e, 'max_age'); continue; }

    const info = results[i];
    if (failed.has(e.address)) continue; // HTTP error: unknown, don't count

    e.checks += 1;
    e.last_dex_check = new Date(now).toISOString();

    if (!info) {
      e.no_pairs += 1;
      if (e.no_pairs >= NO_PAIRS_MAX) stopEntry(e, 'no_pairs');
      dirty = true;
      continue;
    }

    e.no_pairs = 0;
    // marketCap is missing on some pairs; fdv is always >= mcap so it is a
    // safe fallback that keeps the "stop below 8k" rule from never firing.
    e.mcap = info.marketCap ?? info.fdv ?? null;
    e.liquidity = info.liquidity ?? e.liquidity;
    dirty = true;

    if (e.mcap != null && e.mcap < MAX_MCAP) stopEntry(e, 'mcap_below_8k');
  }
}

// ─── tweet phase ────────────────────────────────────────────────────────────

function xPhase(devices) {
  const now = Date.now();
  const enabledCats = enabledTweetCategories(devices);
  if (!enabledCats.size) return;

  const eligible = activeEntries().filter((e) =>
    entryTweetCategories(e).some((c) => enabledCats.has(c)));
  if (!eligible.length) return;

  let status;
  try {
    status = getMentionsStatus();
  } catch {
    status = null;
  }
  if (status && status.queueLength >= MAX_X_QUEUE) return;
  if (status && status.backoffRemainingMs > 0) return;

  let enqueued = 0;
  for (const e of eligible) {
    if (enqueued >= MAX_X_ENQUEUE_PER_TICK) break;
    if (inFlight.has(e.address)) continue;
    if (e.last_x_check && now - new Date(e.last_x_check).getTime() < X_DUE_MS) continue;

    e.last_x_check = new Date(now).toISOString();
    dirty = true;
    inFlight.add(e.address);
    enqueued += 1;

    // force: saltamos la caché de 60s para detectar un tweet nuevo dentro del
    // tick de 10s.
    getMentions(e.address, { limit: 20, force: true })
      .then((res) => handleMentions(e.address, res, devices))
      .catch(() => { /* retry next tick */ })
      .finally(() => inFlight.delete(e.address));
  }
}

async function handleMentions(address, res, devices) {
  const e = watchlist[address];
  if (!e || e.status !== 'active') return;
  const items = Array.isArray(res?.items) ? res.items : [];
  if (!items.length && res?.error) return; // upstream failed: no state change

  const sorted = [...items].sort((a, b) => tweetTime(b) - tweetTime(a));
  const state = e.tweets && typeof e.tweets === 'object' ? e.tweets : (e.tweets = {});
  const notified = new Set(state.notified_ids || []);

  // Old and new tweets alike: anything not delivered yet is pending. Tweets
  // no device currently wants stay pending WITHOUT consuming the per-tick
  // quota, so enabling a condition later still announces them (and matching
  // ones below in the list are never starved by non-matching ones above).
  const cats = entryTweetCategories(e);
  const pending = [];
  for (const i of sorted) {
    const id = i?.tweet_id != null ? String(i.tweet_id) : '';
    if (!id || notified.has(id)) continue;
    const type = classifyTweetAuthor(i?.user?.screen_name || null);
    const authorKey = i?.user?.screen_name || null;
    // A condition without quota — or that already notified this author —
    // keeps waiting too: after the user toggles it again the backlog resumes
    // from where it stopped (and blocked tweets never eat the tick quota).
    const wanted = devices.some(({ device, flags }) =>
      cats.some((c) => flags?.[type]?.[c]) && tweetCondCanNotify(e, device.device_id, type, authorKey));
    if (wanted) pending.push(i);
  }
  if (!pending.length) return;

  const toNotify = pending.slice(0, MAX_NOTIFY_PER_TICK);
  const okIds = new Set();
  for (const tweet of toNotify) {
    const anyPush = await deliverToMatching(e, tweet, devices);
    if (anyPush) okIds.add(String(tweet.tweet_id));
  }
  if (okIds.size) {
    state.notified_ids = [...new Set([...notified, ...okIds])].slice(-MAX_IDS);
    dirty = true;
  }
}

/** Sends the tweet to every device whose matching condition still has quota. */
export async function deliverToMatching(entry, tweet, devices) {
  const author = tweet?.user?.screen_name || null;
  const type = classifyTweetAuthor(author);
  const cats = entryTweetCategories(entry);
  if (!cats.length) return false;

  const followers = followersOf(tweet);
  const text = String(tweet?.content?.text || '').replace(/\s+/g, ' ').trim();
  const url = author && tweet?.tweet_id ? `https://x.com/${author}/status/${tweet.tweet_id}` : null;

  let anyOk = false;
  for (const { device, flags } of devices) {
    const matchedCat = cats.find((c) => flags?.[type]?.[c]);
    if (!matchedCat) continue;
    if (!tweetCondCanNotify(entry, device.device_id, type, author)) continue;
    const ok = await deliver(entry, tweet, device, { author, followers, text, url });
    if (ok) {
      anyOk = true;
      recordTweetCondAuthor(entry, device.device_id, type, author);
    }
  }
  return anyOk;
}

/**
 * Live update: the raw `x_tracker` record is not rendered as its own card
 * anymore, so rebroadcast the token's ORIGINAL history card with
 * `tweet_notified_at` refreshed from every stored tweet record.
 */
function broadcastTweetUpdate(savedEntry, deviceId) {
  const all = notificationHistory.getAll();
  const original = all
    .filter((h) => h.address === savedEntry.address && h.category !== 'x_tracker')
    .sort((a, b) => (b.notified_at || '').localeCompare(a.notified_at || ''))[0];
  if (!original) return; // no original card — GET /history will attach later
  const times = all
    .filter((h) => h.address === savedEntry.address && h.category === 'x_tracker')
    .map((h) => h.notified_at)
    .filter(Boolean)
    .sort()
    .slice(-5);
  const payload = { ...original, tweet_notified_at: times };
  const targets = new Set([deviceId]);
  for (const dev of pushSubscriptions.getAll()) {
    if (dev?.device_id) targets.add(dev.device_id);
  }
  for (const id of targets) {
    broadcast(`notifications:${id}`, { event: 'notification_new', data: payload });
  }
}

async function deliver(entry, tweet, device, info) {
  const now = new Date().toISOString();
  const title = `${entry.symbol || entry.name || 'Token'} — Tracker`;
  const body = [
    `${info.author ? `@${info.author}` : 'Tweet'} · ${fmtFollowers(info.followers)} seg`,
    `MCap ${fmtUsd(entry.mcap)}`,
    info.text ? `${info.text.slice(0, 120)}${info.text.length > 120 ? '…' : ''}` : null,
  ].filter(Boolean).join('\n');

  const historyEntry = {
    device_id: device.device_id,
    address: entry.address,
    chain: entry.chain || 'sol',
    symbol: entry.symbol || null,
    name: entry.name || null,
    category: 'x_tracker',
    mcap: entry.mcap,
    liq: entry.liquidity ?? null,
    vol24h: null,
    logo: entry.logo || null,
    smart_degen_count: null,
    renowned_count: null,
    fresh_wallet_rate: null,
    bot_degen_count: null,
    bot_degen_rate: null,
    rug_ratio: null,
    bundler_rate: null,
    bundler_trader_amount_rate: null,
    entrapment_ratio: null,
    tweet_id: tweet?.tweet_id ?? null,
    tweet_author: info.author,
    tweet_followers: info.followers,
    tweet_text: info.text ? info.text.slice(0, 500) : null,
    tweet_url: info.url,
    tweet_count: entry.tweets?.count ?? null,
    entered_at: entry.first_seen,
    notified_at: now,
    filter_matched_at: null,
  };

  try {
    const { result } = await sendPush(device.push_token, {
      title,
      body,
      data: { address: entry.address, chain: entry.chain || 'sol', symbol: entry.symbol, type: 'x_tracker' },
    });
    if (result?.data?.status === 'error') {
      console.error(`[tracker] push failed: ${result.data.message}`);
      return false;
    }
    // History is written only after a successful push, so a retry never
    // duplicates the entry.
    const saved = notificationHistory.add(historyEntry);
    broadcastTweetUpdate(saved, device.device_id);

    const all = notificationHistory.getAll().filter((h) => h.category === 'x_tracker');
    if (all.length > HISTORY_MAX_X) {
      const ordered = [...all].sort((a, b) => (a.notified_at || '').localeCompare(b.notified_at || ''));
      for (const old of ordered.slice(0, all.length - HISTORY_MAX_X)) {
        notificationHistory.delete((h) => h.id === old.id);
      }
    }
    return true;
  } catch (err) {
    console.error(`[tracker] deliver error: ${err.message}`);
    return false;
  }
}

// ─── loop ───────────────────────────────────────────────────────────────────

async function tick() {
  lastTickAt = new Date().toISOString();
  try {
    pruneStopped();
    await dexPhase();
  } catch (err) {
    console.error('[tracker] dex phase error:', err.message);
  }

  try {
    const devices = trackerTweetDevices();
    if (devices.length) xPhase(devices);
  } catch (err) {
    console.error('[tracker] tweet phase error:', err.message);
  }

  try {
    flush();
  } catch (err) {
    console.error('[tracker] flush error:', err.message);
  }
}

export function startXTrackerWatcher({ onError = () => {} } = {}) {
  if (timer) return getXTrackerStatus();
  timer = setInterval(() => {
    tick().catch((err) => {
      console.error('[tracker] tick error:', err.message);
      onError(err);
    });
  }, TICK_MS);
  tick().catch(() => {});
  console.log(`[tracker] watcher started (tick ${TICK_MS}ms, max age ${MAX_AGE_MS / 60000}m, mcap floor ${MAX_MCAP})`);
  return getXTrackerStatus();
}

export function stopXTrackerWatcher() {
  if (timer) clearInterval(timer);
  timer = null;
}

function mapWatchToken(e) {
  const firstSeen = new Date(e.first_seen).getTime();
  return {
    address: e.address,
    chain: e.chain || 'sol',
    symbol: e.symbol ?? null,
    name: e.name ?? null,
    logo: e.logo ?? null,
    status: e.status,
    stop_reason: e.stop_reason ?? null,
    categories: e.categories || [],
    first_seen: e.first_seen,
    last_seen: e.last_seen,
    stopped_at: e.stopped_at ?? null,
    mcap: e.mcap ?? null,
    liquidity: e.liquidity ?? null,
    checks: e.checks || 0,
    no_pairs: e.no_pairs || 0,
    last_dex_check: e.last_dex_check ?? null,
    age_seconds: Number.isFinite(firstSeen) ? Math.max(0, Math.round((Date.now() - firstSeen) / 1000)) : null,
  };
}

/**
 * Watchlist snapshot for the app's "Rastreando" tab.
 * @param {{status?: 'active'|'stopped'|'all', limit?: number, q?: string}} [opts]
 * @returns {Array<object>}
 */
export function getXTrackerTokens(opts = {}) {
  const status = ['active', 'stopped', 'all'].includes(opts.status) ? opts.status : 'active';
  const limit = Math.min(Math.max(Number(opts.limit) || 300, 1), 1000);
  const q = String(opts.q || '').trim().toLowerCase();

  let list = Object.values(watchlist).filter(Boolean);
  if (status !== 'all') list = list.filter((e) => e.status === status);

  if (q) {
    list = list.filter((e) =>
      (e.symbol || '').toLowerCase().includes(q) ||
      (e.name || '').toLowerCase().includes(q) ||
      String(e.address).toLowerCase().includes(q)
    );
  }

  list.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    const ta = a.last_seen ? new Date(a.last_seen).getTime() : 0;
    const tb = b.last_seen ? new Date(b.last_seen).getTime() : 0;
    return tb - ta;
  });

  const all = list.map(mapWatchToken);
  const active = all.filter((t) => t.status === 'active');
  const stopped = all.filter((t) => t.status === 'stopped');
  const isPhoton = (c) => c === 'photon' || c === 'photon_new' || c === 'photon_graduated';
  const summary = {
    active: active.length,
    stopped: stopped.length,
    photon: active.filter((t) => t.categories.some(isPhoton)).length,
    trenches: active.filter((t) =>
      t.categories.includes('new_creation') || t.categories.includes('completed'),
    ).length,
  };
  return { tokens: all.slice(0, limit), summary, total: all.length };
}

/** Diagnostic snapshot for GET /api/market/xtracker/status */
export function getXTrackerStatus() {
  const entries = Object.values(watchlist);
  const active = entries.filter((e) => e.status === 'active');
  const stopReasons = {};
  for (const e of entries) if (e.stop_reason) stopReasons[e.stop_reason] = (stopReasons[e.stop_reason] || 0) + 1;

  let queue = null;
  try { queue = getMentionsStatus(); } catch { queue = null; }

  return {
    running: timer != null,
    tickMs: TICK_MS,
    rules: { maxAgeMs: MAX_AGE_MS, maxMcap: MAX_MCAP, noPairsMax: NO_PAIRS_MAX },
    total: entries.length,
    active: active.length,
    stopped: entries.length - active.length,
    stopReasons,
    tweetDevices: trackerTweetDevices().length,
    inFlight: inFlight.size,
    gmgnQueue: queue,
    lastTickAt,
    lastDexAt,
    lastFlushAt,
    sample: active.slice(0, 15).map((e) => ({
      address: e.address,
      symbol: e.symbol,
      mcap: e.mcap,
      checks: e.checks,
      ageMin: Math.round((Date.now() - new Date(e.first_seen).getTime()) / 60000),
    })),
  };
}
