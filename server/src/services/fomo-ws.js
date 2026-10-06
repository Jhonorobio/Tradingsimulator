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
 * read by GET /api/market/fomo/graduated with per-query filters.
 */
import WebSocket from 'ws';
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
      } else if (p.kind === 'update' && p.update) {
        const rec = normalize(p.update);
        if (rec) tokens.set(rec.address, rec);
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

  let socket;
  try {
    socket = new WebSocket(FOMO_WS_URL, {
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
  });

  socket.on('close', (code) => {
    if (ws !== socket) return;
    ws = null;
    subscribed = false;
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
  subscribed = false;
  try { ws?.close(); } catch { /* already closed */ }
  ws = null;
}

/**
 * Filtered read for GET /api/market/fomo/graduated.
 * All filters optional; empty string/absent = no bound on that axis.
 */
export function getFomoGraduated({ ageMaxMin, mcapMin, mcapMax, limit } = {}) {
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
    auth: fomoAuthStatus(),
  };
}
