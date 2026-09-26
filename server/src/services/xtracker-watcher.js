/**
 * Background X-Tracker watcher.
 *
 * Ingests every token that shows up in trenches into a persistent watchlist
 * (it survives disappearing from the trenches list) and then, on a 10s tick:
 *
 *   1. Dexscreener phase (free, batch of 30 addresses per request)
 *        - mcap < 10_000            -> stop tracking (mcap_below_10k)
 *        - 3 checks w/o any pair    -> stop tracking (no_pairs)
 *        - older than 1h            -> stop tracking (max_age)
 *        - picks up the X handle from pair.info.socials
 *
 *   2. X phase (GMGN mentions = the "X Tracker" panel), only for eligible
 *      tokens (they have an X handle) while at least one device has the
 *      x_tracker notification category enabled.
 *        - first tweet w/ >= 1k followers              -> push
 *        - a tweet id never seen w/ >= 1k followers    -> push
 *
 * State is mutated in memory and flushed to disk at most once per tick.
 */

import { tokenWatchlist, notificationConfig, notificationHistory } from '../stores.js';
import { fetchTokensBatch } from './dexscreener.js';
import { getMentions, getMentionsStatus } from './gmgn-mentions.js';
import { sendPush } from './push.js';
import { broadcast } from './ws-server.js';

const TICK_MS = Number(process.env.XTRACKER_TICK_MS) || 10_000;
const MAX_AGE_MS = 60 * 60 * 1000;   // 1h rastreando como máximo
const MAX_MCAP = 10_000;             // por debajo se deja de rastrear
const NO_PAIRS_MAX = 3;              // chequeos consecutivos sin par
const MIN_FOLLOWERS = 1000;          // seguidores mínimos del autor del tweet
const X_DUE_MS = 10_000;             // cadencia mínima por token
const MAX_X_ENQUEUE_PER_TICK = 100;  // peticiones GMGN nuevas por tick (10s)
const MAX_X_QUEUE = 100;             // backpressure sobre la cola de GMGN
const MAX_NOTIFY_PER_TICK = 3;       // tweets nuevos notificados por token/tick
const MAX_DELIVERY_ATTEMPTS = 3;     // intentos de push antes de rendirse
const MAX_IDS = 300;                 // tweets recordados por token
const HISTORY_MAX_X = 300;           // entradas de historial x_tracker
const PRUNE_STOPPED_MS = 24 * 60 * 60 * 1000; // tokens detenidos se borran a las 24h

const watchlist = tokenWatchlist.getAll(); // live reference, flushed by flush()
let dirty = false;
let timer = null;
let lastTickAt = null;
let lastDexAt = null;
let lastFlushAt = null;
const inFlight = new Set();

// ─── helpers ────────────────────────────────────────────────────────────────

function normalizeTwitter(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/(?:twitter|x)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,20})/i);
  const handle = m ? m[1] : s.replace(/^@/, '');
  if (!handle || ['share', 'intent', 'search'].includes(handle.toLowerCase())) return null;
  return handle;
}

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
    twitter: null,
    mcap: null,
    liquidity: null,
    checks: 0,
    no_pairs: 0,
    last_dex_check: null,
    last_x_check: null,
    tweets: { count: 0, seen_ids: [], notified_ids: [], first_tweet_at: null, last_tweet_at: null },
  };
}

/**
 * Registers every token from a trenches response into the watchlist.
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
    const tw = normalizeTwitter(t.twitter);
    if (tw && !e.twitter) e.twitter = tw;
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
  console.log(`[xtracker] stop ${e.symbol || e.address} (${reason})`);
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

// ─── notification targets ───────────────────────────────────────────────────

function xTrackerDevices() {
  return Object.values(notificationConfig.getAll())
    .filter((e) => e?.push_token && e?.categories?.x_tracker);
}

// ─── dexscreener phase ──────────────────────────────────────────────────────

async function dexPhase() {
  const active = activeEntries();
  if (!active.length) return;

  const now = Date.now();
  const iso = new Date(now).toISOString();

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
    e.last_dex_check = iso;

    if (!info) {
      e.no_pairs += 1;
      if (e.no_pairs >= NO_PAIRS_MAX) stopEntry(e, 'no_pairs');
      dirty = true;
      continue;
    }

    e.no_pairs = 0;
    // marketCap is missing on some pairs; fdv is always >= mcap so it is a
    // safe fallback that keeps the "stop below 10k" rule from never firing.
    e.mcap = info.marketCap ?? info.fdv ?? null;
    e.liquidity = info.liquidity ?? e.liquidity;
    const tw = normalizeTwitter(info.twitter);
    if (tw && !e.twitter) e.twitter = tw;
    dirty = true;

    if (e.mcap != null && e.mcap < MAX_MCAP) stopEntry(e, 'mcap_below_10k');
  }
}

// ─── x phase ────────────────────────────────────────────────────────────────

function xPhase(devices) {
  const now = Date.now();
  const eligible = activeEntries().filter((e) => e.twitter);
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

    // force: siempre saltamos la caché de 60s, así un tweet nuevo se detecta
    // dentro del tick de 10s en vez de esperar a que caduque la caché.
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
  const seen = new Set(e.tweets.seen_ids || []);
  const notified = new Set(e.tweets.notified_ids || []);
  const attempts = (e.tweets.attempts && typeof e.tweets.attempts === 'object') ? e.tweets.attempts : {};

  const qualifying = sorted.filter((i) => {
    const id = i?.tweet_id != null ? String(i.tweet_id) : '';
    if (!id || notified.has(id)) return false;
    return followersOf(i) >= MIN_FOLLOWERS;
  });

  const isFirstDetection = seen.size === 0;
  const fresh = qualifying.filter((i) => !seen.has(String(i.tweet_id)));
  const toNotify = isFirstDetection
    ? qualifying.slice(0, 1)                              // solo el más reciente
    : fresh.slice(0, MAX_NOTIFY_PER_TICK);

  for (const i of sorted) {
    const id = i?.tweet_id != null ? String(i.tweet_id) : '';
    if (id) seen.add(id);
  }
  e.tweets.seen_ids = [...seen].slice(-MAX_IDS);
  e.tweets.count = items.length;
  if (sorted[0]) e.tweets.last_tweet_at = new Date(tweetTime(sorted[0]) || Date.now()).toISOString();
  if (!e.tweets.first_tweet_at && sorted.length) {
    e.tweets.first_tweet_at = new Date(tweetTime(sorted[sorted.length - 1]) || Date.now()).toISOString();
  }
  dirty = true;

  if (!toNotify.length) return;

  // A push that fails is NOT consumed: the id is un-seen so the next tick
  // retries it, until MAX_DELIVERY_ATTEMPTS is reached.
  const okIds = new Set();
  const giveUpIds = new Set();
  const outcomes = await Promise.all(toNotify.map((tw) => deliver(e, tw, devices)));
  toNotify.forEach((tw, i) => {
    const id = String(tw.tweet_id);
    if (outcomes[i]) { okIds.add(id); return; }
    attempts[id] = (attempts[id] || 0) + 1;
    if (attempts[id] >= MAX_DELIVERY_ATTEMPTS) giveUpIds.add(id);
    else seen.delete(id);
  });
  e.tweets.seen_ids = [...seen].slice(-MAX_IDS);
  e.tweets.notified_ids = [...new Set([...notified, ...okIds, ...giveUpIds])].slice(-MAX_IDS);

  const currentIds = new Set(sorted.map((t) => (t?.tweet_id != null ? String(t.tweet_id) : '')).filter(Boolean));
  for (const id of Object.keys(attempts)) {
    if (!currentIds.has(id) || e.tweets.notified_ids.includes(id)) delete attempts[id];
  }
  e.tweets.attempts = attempts;
  dirty = true;
}

// ─── delivery ───────────────────────────────────────────────────────────────

async function deliver(entry, tweet, devices) {
  if (!devices.length) return true;
  const now = new Date().toISOString();
  const author = tweet?.user?.screen_name || null;
  const followers = followersOf(tweet);
  const text = String(tweet?.content?.text || '').replace(/\s+/g, ' ').trim();
  const url = author && tweet?.tweet_id ? `https://x.com/${author}/status/${tweet.tweet_id}` : null;

  const title = `${entry.symbol || entry.name || 'Token'} — X Tracker`;
  const body = [
    `${author ? `@${author}` : 'Nuevo tweet'} · ${fmtFollowers(followers)} seg`,
    `MCap ${fmtUsd(entry.mcap)}`,
    text ? `${text.slice(0, 120)}${text.length > 120 ? '…' : ''}` : null,
  ].filter(Boolean).join('\n');

  const historyEntry = {
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
    tweet_author: author,
    tweet_followers: followers,
    tweet_text: text ? text.slice(0, 500) : null,
    tweet_url: url,
    tweet_count: entry.tweets.count,
    entered_at: entry.first_seen,
    notified_at: now,
    filter_matched_at: null,
  };

  let anyOk = false;
  for (const device of devices) {
    try {
      const { result } = await sendPush(device.push_token, {
        title,
        body,
        data: { address: entry.address, chain: entry.chain || 'sol', symbol: entry.symbol, type: 'x_tracker' },
      });
      if (result?.data?.status === 'error') {
        console.error(`[xtracker] push failed: ${result.data.message}`);
        continue;
      }
      anyOk = true;
      // History is written only after a successful push, so a retry never
      // duplicates the entry.
      const saved = notificationHistory.add({ ...historyEntry, device_id: device.device_id });
      broadcast(`notifications:${device.device_id}`, { event: 'notification_new', data: saved });
    } catch (err) {
      console.error(`[xtracker] deliver error: ${err.message}`);
    }
  }

  const all = notificationHistory.getAll().filter((h) => h.category === 'x_tracker');
  if (all.length > HISTORY_MAX_X) {
    const ordered = [...all].sort((a, b) => (a.notified_at || '').localeCompare(b.notified_at || ''));
    for (const old of ordered.slice(0, all.length - HISTORY_MAX_X)) {
      notificationHistory.delete((h) => h.id === old.id);
    }
  }
  return anyOk;
}

// ─── loop ───────────────────────────────────────────────────────────────────

async function tick() {
  lastTickAt = new Date().toISOString();
  try {
    pruneStopped();
    await dexPhase();
  } catch (err) {
    console.error('[xtracker] dex phase error:', err.message);
  }

  try {
    const devices = xTrackerDevices();
    if (devices.length) xPhase(devices);
  } catch (err) {
    console.error('[xtracker] x phase error:', err.message);
  }

  try {
    flush();
  } catch (err) {
    console.error('[xtracker] flush error:', err.message);
  }
}

export function startXTrackerWatcher({ onError = () => {} } = {}) {
  if (timer) return getXTrackerStatus();
  timer = setInterval(() => {
    tick().catch((err) => {
      console.error('[xtracker] tick error:', err.message);
      onError(err);
    });
  }, TICK_MS);
  tick().catch(() => {});
  console.log(`[xtracker] watcher started (tick ${TICK_MS}ms, max age ${MAX_AGE_MS / 60000}m, mcap floor ${MAX_MCAP})`);
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
    twitter: e.twitter ?? null,
    checks: e.checks || 0,
    no_pairs: e.no_pairs || 0,
    last_dex_check: e.last_dex_check ?? null,
    last_x_check: e.last_x_check ?? null,
    tweets: e.tweets?.count || 0,
    first_tweet_at: e.tweets?.first_tweet_at ?? null,
    last_tweet_at: e.tweets?.last_tweet_at ?? null,
    notified_tweets: e.tweets?.notified_ids?.length || 0,
    age_seconds: Number.isFinite(firstSeen) ? Math.max(0, Math.round((Date.now() - firstSeen) / 1000)) : null,
  };
}

/**
 * Watchlist snapshot for the app's "Rastreando" tab.
 * @param {{status?: 'active'|'stopped'|'all', limit?: number, q?: string, onlyX?: boolean}} [opts]
 * @returns {Array<object>}
 */
export function getXTrackerTokens(opts = {}) {
  const status = ['active', 'stopped', 'all'].includes(opts.status) ? opts.status : 'active';
  const limit = Math.min(Math.max(Number(opts.limit) || 300, 1), 1000);
  const q = String(opts.q || '').trim().toLowerCase();
  const onlyX = opts.onlyX === true || opts.onlyX === '1' || opts.onlyX === 'true';

  let list = Object.values(watchlist).filter(Boolean);
  if (status !== 'all') list = list.filter((e) => e.status === status);
  if (onlyX) list = list.filter((e) => e.twitter);

  if (q) {
    list = list.filter((e) =>
      (e.symbol || '').toLowerCase().includes(q) ||
      (e.name || '').toLowerCase().includes(q) ||
      String(e.address).toLowerCase().includes(q) ||
      String(e.twitter || '').toLowerCase().includes(q)
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
  const summary = {
    active: active.length,
    stopped: stopped.length,
    with_twitter: active.filter((t) => t.twitter).length,
    with_tweets: active.filter((t) => t.tweets > 0).length,
    notified: all.reduce((n, t) => n + (t.notified_tweets || 0), 0),
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
    rules: { maxAgeMs: MAX_AGE_MS, maxMcap: MAX_MCAP, noPairsMax: NO_PAIRS_MAX, minFollowers: MIN_FOLLOWERS },
    total: entries.length,
    active: active.length,
    stopped: entries.length - active.length,
    stopReasons,
    withTwitter: active.filter((e) => e.twitter).length,
    notifiedTweets: entries.reduce((n, e) => n + (e.tweets?.notified_ids?.length || 0), 0),
    devicesWithCategory: xTrackerDevices().length,
    inFlight: inFlight.size,
    gmgnQueue: queue,
    lastTickAt,
    lastDexAt,
    lastFlushAt,
    sample: active.slice(0, 15).map((e) => ({
      address: e.address,
      symbol: e.symbol,
      mcap: e.mcap,
      twitter: e.twitter,
      tweets: e.tweets?.count || 0,
      checks: e.checks,
      ageMin: Math.round((Date.now() - new Date(e.first_seen).getTime()) / 60000),
    })),
  };
}
