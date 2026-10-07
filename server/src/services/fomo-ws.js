/**
 * FOMO (fomo.family) feeds for Solana: graduated + trending.
 *
 * Single connection to wss://prod-api.fomo.family/ws — the server challenges
 * on connect and expects a Privy customer access token (see fomo-auth.js).
 * Protocol:
 *
 *   ← { type: 'challenge' }
 *   → { type: 'challengeResponse', jwt }
 *   ← { type: 'challengeAccepted' }
 *   → { type: 'subscribe', topicType: 'graduated_tokens', topicId: '1399811149' }
 *   → { type: 'subscribe', topicType: 'trending_tokens',    topicId: '1399811149' }
 *   ← { type: 'subscribed', topicType, topicId }
 *
 * Messages carry `topicType`/`topicId` at the top level, so both subscriptions
 * are demultiplexed on the one socket (all `type: 'data'`):
 *
 *   { topicType, payload: { kind: 'snapshot', tokens: [ { change24, createdAt,
 *       marketCap, priceUSD, token: { address, networkId, name, symbol, info,
 *       launchpad }, volume24, holders } ] } }   — full list, on subscribe
 *   { topicType, payload: { kind: 'update', update: <same item>, tokenKey,
 *       index } }                                — delta (index = rank)
 *   { topicType, payload: { kind: 'remove', tokenKey } } — token left the list
 *
 * Numeric fields arrive as strings. `topicId` 1399811149 is Solana (FOMO's
 * chains bundle: 1=ETH, 56=BSC, 8453=Base, …). Trending items never carry
 * `createdAt` — when the age filter is active it is resolved per token via
 * Pulse (`created_at`, see token-age.js) and kept through snapshot merges.
 * Trending items do carry `index` — the ranking the app sorts them by.
 *
 * Each feed keeps its own token map in memory, snapshotted on every
 * (re)subscribe and merged with updates/removes, read by
 * GET /api/market/fomo/{graduated,trending} with per-query filters (age/mcap/
 * KOL — the KOL count comes from Trenchers' Pulse with a GMGN fallback).
 *
 * Real-time push: changes are batched (PUSH_MS window) and broadcast per feed —
 * WS topics `fomo`/`fomo_trending`, events `fomo_updated`/`fomo_trending_updated`
 * ({ tokens, removed?, savedAt, snapshot? }) — `snapshot: true` means "replace
 * your map", otherwise merge (and drop the `removed` addresses). The app fills
 * its initial state over REST and keeps the 10s poll as fallback.
 *
 * Egress: FOMO (Cloudflare) rejects datacenter IPs with HTTP 432 during the
 * upgrade, so the connection supports an HTTP/SOCKS proxy — persisted via
 * PUT /api/market/fomo/proxy (data/fomo-ws.json), overridable with the
 * FOMO_WS_PROXY env var. With a proxy configured the attempts alternate
 * proxy → direct → proxy… until one handshake succeeds.
 */
import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { JsonStore } from '../json-store.js';
import { broadcast, getSubscriptions, registerTopicProvider } from './ws-server.js';
import { getKolCount } from './pulse-kol.js';
import { getCreatedAt } from './token-age.js';
import { getAccessToken, invalidateAccessToken, hasCredentials, fomoAuthStatus } from './fomo-auth.js';
import { setFomoFeeder, noteFomoSnapshot, handleFomoRecord, forgetFomoRecord } from './fomo-notify.js';

const FOMO_WS_URL = 'wss://prod-api.fomo.family/ws';
const TOPIC_TYPE = 'graduated_tokens';
const TRENDING_TYPE = 'trending_tokens';
const SOLANA_TOPIC_ID = '1399811149';
const RECONNECT_MS = 3_000;
const PING_MS = 30_000;
const PONG_TIMEOUT_MS = 15_000;
/** No data for this long → socket is a zombie (list always has activity). */
const DATA_TIMEOUT_MS = 300_000;
const AUTH_TIMEOUT_MS = 10_000; // challenge → challengeAccepted must be quick
const PRUNE_MS = 60_000;
/** Drop tokens FOMO graduated longer ago than this (no filter needs them). */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TOKENS = 5_000;

const num = (v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── Feeds: one upstream socket, two subscriptions (graduados + trending) ──
/** Initial push on subscribe: newest N tokens (REST backfills older ones). */
const PUSH_TOP_N = 250;
/** Upstream sends ~100 msgs/s — batch them into one push per window. */
const PUSH_MS = 1_000;
/** Rank fallback for ordered reads (unknown rank sorts last). */
const MAX_RANK = Number.MAX_SAFE_INTEGER;

/**
 * One upstream feed (topicType) with its own token map, ack flags and a
 * batched push channel to app clients subscribed to `topic`.
 */
function makeFeed({ name, topicType, topic, event, ranked }) {
  return {
    /** Notification feed id ('graduated' | 'trending') — matches fomo-notify. */
    name,
    topicType,
    /** App WS topic clients subscribe to. */
    topic,
    /** App WS event name used for pushes. */
    event,
    /** Ranking-based feed (trending) — sorts by rank, skips the age filter. */
    ranked,
    /** address → normalized record. */
    tokens: new Map(),
    subscribed: false,
    snapshots: 0,
    /** Last data message for THIS feed (per-feed liveness in status). */
    lastMsgAt: 0,
    /** Addresses changed / removed since the last flush. */
    dirty: new Set(),
    removed: new Set(),
    pushTimer: null,
    snapshotPending: false,
  };
}

const GRAD = makeFeed({ name: 'graduated', topicType: TOPIC_TYPE, topic: 'fomo', event: 'fomo_updated', ranked: false });
const TREND = makeFeed({ name: 'trending', topicType: TRENDING_TYPE, topic: 'fomo_trending', event: 'fomo_trending_updated', ranked: true });
const FEEDS = [GRAD, TREND];
const feedByType = new Map(FEEDS.map((f) => [f.topicType, f]));

// Alert notifications (fomo-notify) evaluate every ingested record against the
// per-tab filters; it gets the live maps + the shared KOL cache from here
// instead of importing this module (no import cycle).
setFomoFeeder({
  readTokens: (name) => (name === TREND.name ? TREND : GRAD).tokens,
  resolveKol: (address) => ensureKol(address),
  resolveAge: (address) => getCreatedAt(address),
});

/** Display/push order: trending by rank, graduados by newest graduation. */
function orderedTokens(feed) {
  const list = [...feed.tokens.values()];
  return feed.ranked
    ? list.sort((a, b) => (a.rank ?? MAX_RANK) - (b.rank ?? MAX_RANK))
    : list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

function flushPush(feed) {
  feed.pushTimer = null;
  if (feed.dirty.size === 0 && feed.removed.size === 0 && !feed.snapshotPending) return;
  // Nobody listening → skip (the 10s REST poll keeps laggards in sync).
  if (!getSubscriptions().has(feed.topic)) {
    feed.dirty.clear();
    feed.removed.clear();
    feed.snapshotPending = false;
    return;
  }
  const full = feed.snapshotPending;
  let list;
  if (full) {
    list = orderedTokens(feed);
  } else {
    list = [];
    for (const addr of feed.dirty) {
      const rec = feed.tokens.get(addr);
      if (rec) list.push(rec);
    }
  }
  const removed = full ? [] : [...feed.removed];
  feed.dirty.clear();
  feed.removed.clear();
  feed.snapshotPending = false;
  if (list.length === 0 && removed.length === 0) return;
  broadcast(feed.topic, {
    event: feed.event,
    data: {
      tokens: list,
      savedAt: Date.now(),
      ...(removed.length ? { removed } : {}),
      ...(full ? { snapshot: true } : {}),
    },
  });
}

/** Queue a push — batched: one broadcast per PUSH_MS window at most. */
function queuePush(feed, addr = null) {
  if (addr) feed.dirty.add(addr);
  if (feed.pushTimer) return;
  feed.pushTimer = setTimeout(() => flushPush(feed), PUSH_MS);
}

/** Snapshot pending → the next flush tells clients to REPLACE their map. */
function markSnapshot(feed) {
  feed.snapshotPending = true;
  queuePush(feed);
}

// A client subscribing to a feed topic gets a full initial list immediately
// (no REST hop). Capped to the newest PUSH_TOP_N — the REST poll backfills
// older entries if a wide age filter needs them.
for (const feed of FEEDS) {
  registerTopicProvider(feed.topic, () => {
    if (feed.tokens.size === 0) return null;
    return {
      event: feed.event,
      data: { tokens: orderedTokens(feed).slice(0, PUSH_TOP_N), savedAt: Date.now(), snapshot: true },
    };
  });
}

const store = new JsonStore('fomo-ws');
const PROXY_PROTOCOLS = ['http:', 'https:', 'socks:', 'socks4:', 'socks5:'];

/** '' → '' (direct); a bare `host:port` gets an http:// scheme; throws on junk. */
function normalizeProxy(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`proxy inválido: ${v.slice(0, 80)}`);
  }
  if (!PROXY_PROTOCOLS.includes(u.protocol)) {
    throw new Error(`protocolo de proxy no soportado: ${u.protocol} (usa http:// o socks5://)`);
  }
  if (!u.hostname) throw new Error('proxy sin host');
  return withScheme;
}

/** Configured proxy URL or null → direct connection. Store wins over env. */
function getProxyUrl() {
  const raw = store.has('proxy') ? store.get('proxy') : process.env.FOMO_WS_PROXY || '';
  try {
    return normalizeProxy(raw) || null;
  } catch {
    return null; // bad env value → degrade to direct instead of crash-looping
  }
}

function makeAgent(url) {
  return url.startsWith('socks') ? new SocksProxyAgent(url) : new HttpsProxyAgent(url);
}

let ws = null;
let running = false;
let reconnectTimer = null;
let pruneTimer = null;
let watchdogTimer = null;
let lastMsgAt = 0;
let lastPongAt = 0;
let challengeAt = 0;
/** Handshake-level flag: at least one feed acked `subscribed` this connection. */
let subscribed = false;
let authFailures = 0;
let lastError = null;
/** With a proxy configured, prefer it; flip to direct only if its handshake fails. */
let preferProxy = true;
/** Transport of the current/last attempt ('proxy' | 'direct') — surfaced in status. */
let currentTransport = 'direct';

function normalize(item) {
  const t = item?.token;
  if (!t?.address) return null;
  return {
    address: t.address,
    networkId: num(t.networkId),
    symbol: t.symbol ?? null,
    name: t.name ?? null,
    image: t.info?.imageThumbUrl ?? null,
    launchpad: t.launchpad?.launchpadName ?? null,
    createdAt: num(item.createdAt), // unix seconds
    mcap: num(item.marketCap),
    price: num(item.priceUSD),
    vol24: num(item.volume24),
    change24: num(item.change24),
    holders: num(item.holders),
    updatedAt: Date.now(),
  };
}

function handleMessage(raw, socket) {
  lastMsgAt = Date.now();
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  switch (msg.type) {
    case 'challenge':
      // Mint/use an access token and answer; failures surface via close/error.
      // Answer on the socket that challenged us (ws may already be a newer one).
      getAccessToken()
        .then((jwt) => {
          if (socket.readyState === WebSocket.OPEN) {
            challengeAt = Date.now();
            socket.send(JSON.stringify({ type: 'challengeResponse', jwt }));
          }
        })
        .catch((err) => {
          lastError = err.message;
          authFailures++;
          try { socket.close(); } catch { /* already closed */ }
        });
      break;

    case 'challengeAccepted':
      challengeAt = 0;
      for (const feed of FEEDS) {
        socket.send(JSON.stringify({ type: 'subscribe', topicType: feed.topicType, topicId: SOLANA_TOPIC_ID }));
      }
      break;

    case 'subscribed': {
      const feed = feedByType.get(msg.topicType);
      if (feed) {
        feed.subscribed = true;
        feed.lastMsgAt = Date.now();
      }
      subscribed = true;
      lastError = null;
      break;
    }

    case 'error':
      lastError = typeof msg.message === 'string' ? msg.message : JSON.stringify(msg).slice(0, 300);
      console.log('[fomo-ws] server error:', lastError);
      break;

    case 'data': {
      // Demux by topicType (absent → graduados, the pre-trending behavior).
      const feed = feedByType.get(msg.topicType) ?? GRAD;
      applyFeedData(feed, msg.payload);
      break;
    }

    default:
      break;
  }
}

/**
 * Apply one payload to its feed: a snapshot rebuilds the map (entries missing
 * there left FOMO's list), an update merges in place — preserving kolCount and
 * rank the raw record doesn't repeat — and a remove drops the token and pushes
 * the deletion so clients delete it too.
 */
function applyFeedData(feed, p) {
  if (!p) return;
  feed.lastMsgAt = Date.now();

  if (p.kind === 'snapshot' && Array.isArray(p.tokens)) {
    const next = new Map();
    p.tokens.forEach((item, i) => {
      const rec = normalize(item);
      if (!rec) return;
      if (feed.ranked) rec.rank = i; // trending snapshot order IS the ranking
      const prev = feed.tokens.get(rec.address);
      if (prev?.kolCount != null && rec.kolCount == null) rec.kolCount = prev.kolCount;
      // Pulse-resolved age (trending) — upstream never repeats it.
      if (prev?.createdAt != null && rec.createdAt == null) rec.createdAt = prev.createdAt;
      next.set(rec.address, rec);
    });
    feed.tokens.clear();
    for (const [addr, rec] of next) feed.tokens.set(addr, rec);
    feed.snapshots++;
    feed.subscribed = true;
    subscribed = true;
    markSnapshot(feed);
    noteFomoSnapshot(feed.name, feed.tokens);
  } else if (p.kind === 'update' && p.update) {
    const rec = normalize(p.update);
    if (rec) {
      if (typeof p.index === 'number') rec.rank = p.index;
      const prev = feed.tokens.get(rec.address);
      if (prev) {
        if (rec.rank == null) rec.rank = prev.rank;
        if (prev.kolCount != null && rec.kolCount == null) rec.kolCount = prev.kolCount;
        if (prev.createdAt != null && rec.createdAt == null) rec.createdAt = prev.createdAt;
      }
      feed.tokens.set(rec.address, rec);
      queuePush(feed, rec.address);
      handleFomoRecord(feed.name, rec);
    }
  } else if (p.kind === 'remove' && typeof p.tokenKey === 'string') {
    // tokenKey = `${address}:${networkId}` — addresses themselves never contain ':'.
    const addr = p.tokenKey.split(':')[0];
    if (feed.tokens.delete(addr)) {
      feed.removed.add(addr);
      queuePush(feed);
      forgetFomoRecord(feed.name, addr);
    }
  }
}

function pruneFeed(feed) {
  const cutoff = Date.now() - MAX_AGE_MS;
  let removed = 0;
  for (const [addr, rec] of feed.tokens) {
    // Trending items carry no createdAt — only graduados age out here.
    if (rec.createdAt != null && rec.createdAt * 1000 < cutoff) {
      feed.tokens.delete(addr);
      removed++;
    }
  }
  if (feed.tokens.size > MAX_TOKENS) {
    // Evict the oldest graduations first.
    const sorted = [...feed.tokens.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    for (const rec of sorted.slice(0, feed.tokens.size - MAX_TOKENS)) {
      feed.tokens.delete(rec.address);
      removed++;
    }
  }
  return removed;
}

function prune() {
  let removed = 0;
  for (const feed of FEEDS) removed += pruneFeed(feed);
  // Drop KOL memos for tokens that no longer exist in any feed.
  for (const addr of kolLocal.keys()) {
    if (FEEDS.every((feed) => !feed.tokens.has(addr))) kolLocal.delete(addr);
  }
  return removed;
}

function scheduleReconnect() {
  if (!running || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function connect() {
  if (!running) return;

  if (!hasCredentials()) {
    lastError = 'no refresh token configured';
    scheduleReconnect();
    return;
  }

  subscribed = false;
  for (const feed of FEEDS) feed.subscribed = false;
  challengeAt = 0;
  lastPongAt = Date.now();
  lastMsgAt = Date.now();

  const proxyUrl = getProxyUrl();
  const useProxy = Boolean(proxyUrl) && preferProxy;
  currentTransport = useProxy ? 'proxy' : 'direct';

  let socket;
  try {
    socket = new WebSocket(FOMO_WS_URL, {
      ...(useProxy ? { agent: makeAgent(proxyUrl) } : {}),
      handshakeTimeout: 15_000,
      headers: {
        origin: 'https://fomo.family',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
      },
    });
  } catch (err) {
    lastError = err.message;
    scheduleReconnect();
    return;
  }
  ws = socket;

  // Handshake never completed → try the other transport on the next attempt
  // (so a dead proxy falls back to direct, and a 432'd direct goes back to proxy).
  let opened = false;
  let flipped = false;
  const flipTransport = () => {
    if (!flipped && !opened && proxyUrl) {
      flipped = true;
      preferProxy = !preferProxy;
    }
  };

  socket.on('open', () => {
    opened = true;
  });

  socket.on('message', (raw) => {
    if (ws !== socket) return;
    handleMessage(raw, socket);
  });

  socket.on('pong', () => {
    if (ws !== socket) return;
    lastPongAt = Date.now();
  });

  socket.on('error', (err) => {
    lastError = err.message;
    flipTransport();
  });

  socket.on('close', (code) => {
    if (ws !== socket) return;
    ws = null;
    subscribed = false;
    for (const feed of FEEDS) feed.subscribed = false;
    flipTransport();
    // 1008 = policy violation (bad/expired JWT) — mint a fresh token next try.
    if (code === 1008) {
      invalidateAccessToken();
      authFailures++;
      lastError = `auth rejected (close ${code})`;
    }
    scheduleReconnect();
  });
}

/** True while the feed is receiving data (used for the UI live dot). */
function isLive() {
  return Boolean(ws && ws.readyState === WebSocket.OPEN && subscribed && lastMsgAt && Date.now() - lastMsgAt < 60_000);
}

/** Current egress config (never exposes proxy credentials beyond the URL itself). */
function proxyInfo() {
  const url = getProxyUrl();
  return {
    url: url || '',
    enabled: Boolean(url),
    transport: currentTransport,
  };
}

/**
 * Persist the egress proxy for the FOMO WS and reconnect with it.
 * `url` = '' clears it (direct). Throws on invalid input (route → 400).
 */
export function setFomoProxy(url) {
  const normalized = normalizeProxy(url); // '' allowed → direct
  store.set('proxy', normalized);
  store.set('updated_at', new Date().toISOString());
  preferProxy = Boolean(normalized); // fresh config → try the proxy first
  if (running) {
    if (ws) {
      try { ws.close(); } catch { /* already closed */ } // close → scheduleReconnect
    } else {
      scheduleReconnect(); // no-op if a reconnect is already pending
    }
  }
  return proxyInfo();
}

export function startFomoWatcher() {
  if (running) return;
  running = true;
  connect();
  pruneTimer = setInterval(() => {
    const removed = prune();
    if (removed) console.log(`[fomo-ws] pruned ${removed} stale tokens (${GRAD.tokens.size}+${TREND.tokens.size} kept)`);
  }, PRUNE_MS);

  // Protocol ping + watchdogs (mirrors azura-ws.js): pong silence or data
  // silence means the socket is a zombie — terminate and let close→reconnect.
  watchdogTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - lastPongAt > PING_MS + PONG_TIMEOUT_MS || now - lastMsgAt > DATA_TIMEOUT_MS) {
      console.log(`[fomo-ws] feed silent (pong ${now - lastPongAt}ms, data ${now - lastMsgAt}ms) — restarting`);
      try { ws.terminate(); } catch { /* already gone */ }
      return;
    }
    // A challenge that never completes also means a stuck handshake.
    if (challengeAt && now - challengeAt > AUTH_TIMEOUT_MS * 10) {
      try { ws.terminate(); } catch { /* already gone */ }
      return;
    }
    try { ws.ping(); } catch { /* closing */ }
  }, PING_MS);

  console.log(`[fomo-ws] started (Solana topic ${SOLANA_TOPIC_ID}: graduados + trending)`);
}

export function stopFomoWatcher() {
  running = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  for (const feed of FEEDS) {
    if (feed.pushTimer) { clearTimeout(feed.pushTimer); feed.pushTimer = null; }
    feed.dirty.clear();
    feed.removed.clear();
    feed.snapshotPending = false;
    feed.subscribed = false;
  }
  subscribed = false;
  try { ws?.close(); } catch { /* already closed */ }
  ws = null;
}

// ── KOL enrichment for the kolMin filter (Trenchers Pulse → GMGN) ──
/** Solid counts move slowly — refetch a token at most every 5 min. */
const KOL_FRESH_MS = 300_000;
/** null (no data / both APIs down) → retry sooner than a real count. */
const KOL_RETRY_MS = 60_000;
/** Only the newest N candidates are enriched (bounded Pulse load per call). */
const KOL_ENRICH_CAP = 500;
const KOL_CONCURRENCY = 25;
/** Cap for age resolution (Pulse) per read — same bounded-load idea. */
const AGE_ENRICH_CAP = 300;
const kolLocal = new Map(); // address -> { count: number|null, at }

async function ensureKol(address) {
  const hit = kolLocal.get(address);
  const ttl = hit && hit.count == null ? KOL_RETRY_MS : KOL_FRESH_MS;
  if (hit && Date.now() - hit.at < ttl) return hit.count;
  // getKolCount dedupes concurrent callers itself (inflight map + 10s memo).
  const count = await getKolCount(address);
  kolLocal.set(address, { count, at: Date.now() });
  return count;
}

/**
 * Attach `kolCount` to the newest candidates (mutates the stored records, so
 * live WS pushes carry it too) in bounded-concurrency batches.
 */
async function enrichKol(targets) {
  for (let i = 0; i < targets.length; i += KOL_CONCURRENCY) {
    await Promise.all(
      targets.slice(i, i + KOL_CONCURRENCY).map(async (t) => {
        t.kolCount = await ensureKol(t.address);
      }),
    );
  }
}

/**
 * Attach `createdAt` to records upstream doesn't carry (trending) via Pulse's
 * `created_at` — bounded-concurrency batch; the value sticks to the record
 * (preserved through snapshot merges), so each token resolves once per boot.
 */
async function enrichAge(targets) {
  const missing = targets.filter((t) => t.createdAt == null);
  for (let i = 0; i < missing.length; i += KOL_CONCURRENCY) {
    await Promise.all(
      missing.slice(i, i + KOL_CONCURRENCY).map(async (t) => {
        const ts = await getCreatedAt(t.address);
        if (ts != null) t.createdAt = ts;
      }),
    );
  }
}

/**
 * Filtered read shared by GET /api/market/fomo/graduated and /fomo/trending.
 * All filters optional; empty string/absent = no bound on that axis.
 * When `ageMaxMin` is set, records without `createdAt` (trending) get it
 * resolved via Pulse (token-age.js) first — bounded batch, ranked candidates
 * first, and the resolved value sticks to the record. When `kolMin` is set,
 * candidates get a KOL count (Trenchers Pulse → GMGN fallback via
 * pulse-kol.js) attached before filtering — see ensureKol().
 */
async function readFeed(feed, { ageMaxMin, mcapMin, mcapMax, kolMin, limit } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const maxAgeSec = ageMaxMin != null ? ageMaxMin * 60 : null;

  let list = [...feed.tokens.values()];
  // Cheap bounds first, so enrichment only runs over actual candidates.
  if (mcapMin != null || mcapMax != null) {
    list = list.filter((t) => t.mcap != null && (mcapMin == null || t.mcap >= mcapMin) && (mcapMax == null || t.mcap <= mcapMax));
  }
  if (maxAgeSec != null) {
    const candidates = feed.ranked
      ? [...list].sort((a, b) => (a.rank ?? MAX_RANK) - (b.rank ?? MAX_RANK)).slice(0, AGE_ENRICH_CAP)
      : list.slice(0, AGE_ENRICH_CAP);
    await enrichAge(candidates);
    list = list.filter((t) => t.createdAt != null && now - t.createdAt <= maxAgeSec);
  }
  list.sort(feed.ranked
    ? (a, b) => (a.rank ?? MAX_RANK) - (b.rank ?? MAX_RANK)
    : (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

  if (kolMin != null) {
    await enrichKol(list.slice(0, KOL_ENRICH_CAP));
    list = list.filter((t) => t.kolCount != null && t.kolCount >= kolMin);
  }

  const total = list.length;
  const cap = Math.min(Math.max(Math.floor(limit ?? 200), 1), 1000);
  return {
    tokens: list.slice(0, cap),
    total,
    savedAt: Date.now(),
    status: getFomoStatus(),
  };
}

export async function getFomoGraduated(filters) {
  return readFeed(GRAD, filters);
}

export async function getFomoTrending(filters) {
  return readFeed(TREND, filters);
}

export function getFomoStatus() {
  const open = Boolean(ws && ws.readyState === WebSocket.OPEN);
  const feedLive = (feed) =>
    Boolean(open && feed.subscribed && feed.lastMsgAt && Date.now() - feed.lastMsgAt < 60_000);
  return {
    running,
    connected: open,
    subscribed,
    live: isLive(),
    count: GRAD.tokens.size,
    snapshots: GRAD.snapshots,
    authFailures,
    lastMsgAgeMs: lastMsgAt ? Date.now() - lastMsgAt : null,
    lastError,
    proxy: proxyInfo(),
    auth: fomoAuthStatus(),
    // Per-feed diagnostics for the trending tab (graduados = the top-level fields).
    trending: {
      subscribed: TREND.subscribed,
      count: TREND.tokens.size,
      snapshots: TREND.snapshots,
      lastMsgAgeMs: TREND.lastMsgAt ? Date.now() - TREND.lastMsgAt : null,
      live: feedLive(TREND),
    },
  };
}
