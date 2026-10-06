/**
 * FOMO (fomo.family) graduated-tokens feed for Solana.
 *
 * Single connection to wss://prod-api.fomo.family/ws — the server challenges
 * on connect and expects a Privy customer access token (see fomo-auth.js).
 * Protocol:
 *
 *   ← { type: 'challenge' }
 *   → { type: 'challengeResponse', jwt }
 *   ← { type: 'challengeAccepted' }
 *   → { type: 'subscribe', topicType: 'graduated_tokens', topicId: '1399811149' }
 *   ← { type: 'subscribed' }
 *
 * Messages on the topic (all `type: 'data'`):
 *
 *   { payload: { kind: 'snapshot', tokens: [ { change24, createdAt, marketCap,
 *       priceUSD, token: { address, networkId, name, symbol, info, launchpad },
 *       volume24, holders } ] } }            — full list, on subscribe
 *   { payload: { kind: 'update', update: <same item>, tokenKey, index } } — delta
 *
 * Numeric fields arrive as strings. `topicId` 1399811149 is Solana (FOMO's
 * chains bundle: 1=ETH, 56=BSC, 8453=Base, …).
 *
 * The token list lives in memory (≈100 entries — FOMO's own list is small),
 * snapshotted on every (re)subscribe and merged with incoming updates, then
 * read by GET /api/market/fomo/graduated with per-query filters (age/mcap/
 * KOL — the KOL count comes from Trenchers' Pulse with a GMGN fallback).
 *
 * Real-time push: changes are batched (PUSH_MS window) and broadcast to app
 * clients subscribed to WS topic `fomo` as `fomo_updated`
 * ({ tokens, savedAt, snapshot? }) — `snapshot: true` means "replace your
 * map" (authoritative upstream rebuild), otherwise merge. The app fills its
 * initial state over REST and keeps the 10s poll as fallback.
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
import { getAccessToken, invalidateAccessToken, hasCredentials, fomoAuthStatus } from './fomo-auth.js';

const FOMO_WS_URL = 'wss://prod-api.fomo.family/ws';
const TOPIC_TYPE = 'graduated_tokens';
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

// ── Real-time push to app clients (WS topic `fomo`) ──
const FOMO_TOPIC = 'fomo';
/** Upstream sends ~100 msgs/s — batch them into one push per window. */
const PUSH_MS = 1_000;
/** Addresses changed since the last flush. */
const dirty = new Set();
/** Initial push on subscribe: newest N tokens (REST backfills older ones). */
const PUSH_TOP_N = 250;
let pushTimer = null;
let snapshotPending = false;

function flushPush() {
  pushTimer = null;
  if (dirty.size === 0 && !snapshotPending) return;
  // Nobody listening → skip (the 10s REST poll keeps laggards in sync).
  if (!getSubscriptions().has(FOMO_TOPIC)) {
    dirty.clear();
    snapshotPending = false;
    return;
  }
  const full = snapshotPending;
  let list;
  if (full) {
    list = [...tokens.values()];
  } else {
    list = [];
    for (const addr of dirty) {
      const rec = tokens.get(addr);
      if (rec) list.push(rec);
    }
  }
  dirty.clear();
  snapshotPending = false;
  if (list.length === 0) return;
  broadcast(FOMO_TOPIC, {
    event: 'fomo_updated',
    data: { tokens: list, savedAt: Date.now(), ...(full ? { snapshot: true } : {}) },
  });
}

/** Queue a push — batched: one broadcast per PUSH_MS window at most. */
function queuePush(addr = null) {
  if (addr) dirty.add(addr);
  if (pushTimer) return;
  pushTimer = setTimeout(flushPush, PUSH_MS);
}

// A client subscribing to `fomo` gets a full initial list immediately (no REST
// hop). Capped to the newest PUSH_TOP_N — the REST poll backfills older entries
// if a wide age filter needs them.
registerTopicProvider(FOMO_TOPIC, () => {
  if (tokens.size === 0) return null;
  const list = [...tokens.values()]
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, PUSH_TOP_N);
  return { event: 'fomo_updated', data: { tokens: list, savedAt: Date.now(), snapshot: true } };
});

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

/** address → normalized token record. */
const tokens = new Map();

let ws = null;
let running = false;
let reconnectTimer = null;
let pruneTimer = null;
let watchdogTimer = null;
let lastMsgAt = 0;
let lastPongAt = 0;
let challengeAt = 0;
let subscribed = false;
let authFailures = 0;
let lastError = null;
let snapshotCount = 0;
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
      socket.send(JSON.stringify({ type: 'subscribe', topicType: TOPIC_TYPE, topicId: SOLANA_TOPIC_ID }));
      break;

    case 'subscribed':
      subscribed = true;
      lastError = null;
      break;

    case 'error':
      lastError = typeof msg.message === 'string' ? msg.message : JSON.stringify(msg).slice(0, 300);
      console.log('[fomo-ws] server error:', lastError);
      break;

    case 'data': {
      const p = msg.payload;
      if (!p) break;
      if (p.kind === 'snapshot' && Array.isArray(p.tokens)) {
        // Authoritative list on every (re)subscribe: rebuild from it — entries
        // missing here were graduated out of FOMO's list, so drop them too.
        const next = new Map();
        for (const item of p.tokens) {
          const rec = normalize(item);
          if (rec) next.set(rec.address, rec);
        }
        tokens.clear();
        for (const [addr, rec] of next) tokens.set(addr, rec);
        snapshotCount++;
        subscribed = true;
        snapshotPending = true; // push tells clients to REPLACE their map
        queuePush();
      } else if (p.kind === 'update' && p.update) {
        const rec = normalize(p.update);
        if (rec) {
          tokens.set(rec.address, rec);
          queuePush(rec.address);
        }
      }
      break;
    }

    default:
      break;
  }
}

function prune() {
  const cutoff = Date.now() - MAX_AGE_MS;
  let removed = 0;
  for (const [addr, rec] of tokens) {
    if (rec.createdAt != null && rec.createdAt * 1000 < cutoff) {
      tokens.delete(addr);
      removed++;
    }
  }
  if (tokens.size > MAX_TOKENS) {
    // Evict the oldest graduations first.
    const sorted = [...tokens.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    for (const rec of sorted.slice(0, tokens.size - MAX_TOKENS)) {
      tokens.delete(rec.address);
      removed++;
    }
  }
  // Drop KOL memos for tokens that no longer exist.
  for (const addr of kolLocal.keys()) {
    if (!tokens.has(addr)) kolLocal.delete(addr);
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
    if (removed) console.log(`[fomo-ws] pruned ${removed} stale tokens (${tokens.size} kept)`);
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

  console.log(`[fomo-ws] started (Solana topic ${SOLANA_TOPIC_ID})`);
}

export function stopFomoWatcher() {
  running = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
  dirty.clear();
  snapshotPending = false;
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
 * Filtered read for GET /api/market/fomo/graduated.
 * All filters optional; empty string/absent = no bound on that axis.
 * When `kolMin` is set, candidates get a KOL count (Trenchers Pulse → GMGN
 * fallback via pulse-kol.js) attached before filtering — see ensureKol().
 */
export async function getFomoGraduated({ ageMaxMin, mcapMin, mcapMax, kolMin, limit } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const maxAgeSec = ageMaxMin != null ? ageMaxMin * 60 : null;

  let list = [...tokens.values()];
  if (maxAgeSec != null) {
    list = list.filter((t) => t.createdAt != null && now - t.createdAt <= maxAgeSec);
  }
  if (mcapMin != null || mcapMax != null) {
    list = list.filter((t) => t.mcap != null && (mcapMin == null || t.mcap >= mcapMin) && (mcapMax == null || t.mcap <= mcapMax));
  }
  list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

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

export function getFomoStatus() {
  return {
    running,
    connected: Boolean(ws && ws.readyState === WebSocket.OPEN),
    subscribed,
    live: isLive(),
    count: tokens.size,
    snapshots: snapshotCount,
    authFailures,
    lastMsgAgeMs: lastMsgAt ? Date.now() - lastMsgAt : null,
    lastError,
    proxy: proxyInfo(),
    auth: fomoAuthStatus(),
  };
}
