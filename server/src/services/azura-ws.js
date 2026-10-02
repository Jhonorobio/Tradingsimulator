/**
 * Azura WSS market feed for the tracker.
 *
 * Single connection to wss://data.v2.azura.xyz/ws — no auth required.
 * Subscribe one `explorerCard` stream per token mint (the `pool` field accepts
 * a mint). Messages arrive pushed only while the token has activity, shaped:
 *
 *   { type: 'explorerCard', chainId, tokenAddress,
 *     payload: { stats: { marketCap, liquidity: { amount: { usd } } } } }
 *
 * The subscription set survives reconnects: on every `open` the whole set is
 * re-sent, so callers only ever call azuraSubscribe/azuraUnsubscribe.
 * A protocol ping watchdog terminates silent sockets and triggers reconnect.
 */

import WebSocket from 'ws';

const AZURA_URL = 'wss://data.v2.azura.xyz/ws';
const CHAIN_ID = 1399811149; // Solana
const RECONNECT_MS = 3_000;
const PING_MS = 30_000;
const PONG_TIMEOUT_MS = 15_000;

let ws = null;
let running = false;
let reconnectTimer = null;
let pingTimer = null;
let pongTimer = null;
let onUpdate = null;

const subs = new Set(); // mint addresses currently subscribed

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch { /* closed mid-send */ }
  }
}

function subFrame(address) {
  return { type: 'subscribe', payload: { chain_id: CHAIN_ID, pool: address, subscription_types: ['explorerCard'] } };
}

function unsubFrame(address) {
  return { type: 'unsubscribe', payload: { chain_id: CHAIN_ID, pool: address, subscription_types: ['explorerCard'] } };
}

/** Adds a mint to the subscription set (idempotent). */
export function azuraSubscribe(address) {
  if (!address || subs.has(address)) return;
  subs.add(address);
  send(subFrame(address));
}

/** Removes a mint from the subscription set (idempotent). */
export function azuraUnsubscribe(address) {
  if (!address || !subs.has(address)) return;
  subs.delete(address);
  send(unsubFrame(address));
}

export function getAzuraStatus() {
  return {
    running,
    connected: ws != null && ws.readyState === WebSocket.OPEN,
    subs: subs.size,
  };
}

// ─── message parsing ────────────────────────────────────────────────────────

function parseExplorerCard(j) {
  const p = j.payload && typeof j.payload === 'object' ? j.payload : {};
  const st = p.stats && typeof p.stats === 'object' ? p.stats : p;
  const address = j.tokenAddress || p.tokenAddress || null;
  if (!address) return null;
  const mcap = Number(st.marketCap ?? p.marketCap);
  const liqUsd = Number(st.liquidity?.amount?.usd ?? p.liquidity?.usd);
  return {
    address,
    mcap: Number.isFinite(mcap) && mcap > 0 ? mcap : null,
    liquidity: Number.isFinite(liqUsd) && liqUsd > 0 ? liqUsd : null,
    dex: p.dex ?? null,
    holders: Number.isFinite(Number(p.holders)) ? Number(p.holders) : null,
  };
}

// ─── ping watchdog ──────────────────────────────────────────────────────────

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.ping(); } catch { return; }
    if (pongTimer) return;
    pongTimer = setTimeout(() => {
      pongTimer = null;
      // No pong in time — kill the socket; the close handler reconnects.
      try { ws?.terminate(); } catch { /* already gone */ }
    }, PONG_TIMEOUT_MS);
  }, PING_MS);
}

function stopPing() {
  if (pingTimer) clearInterval(pingTimer);
  if (pongTimer) clearTimeout(pongTimer);
  pingTimer = null;
  pongTimer = null;
}

// ─── connection ─────────────────────────────────────────────────────────────

function scheduleReconnect() {
  if (!running || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function connect() {
  if (!running) return;
  try {
    ws = new WebSocket(AZURA_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    if (!running) { try { ws.close(); } catch {} return; }
    for (const address of subs) send(subFrame(address));
    startPing();
    console.log(`[azura] connected (${subs.size} subscriptions restored)`);
  });

  ws.on('message', (data) => {
    let j;
    try { j = JSON.parse(data.toString()); } catch { return; }
    if (j?.type !== 'explorerCard') return;
    const parsed = parseExplorerCard(j);
    if (parsed && onUpdate) onUpdate(parsed);
  });

  ws.on('pong', () => {
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
  });

  ws.on('error', (err) => {
    console.log('[azura] socket error:', err.message);
  });

  ws.on('close', () => {
    stopPing();
    ws = null;
    if (running) {
      console.log('[azura] disconnected — reconnecting…');
      scheduleReconnect();
    }
  });
}

/**
 * Starts the feed. `callback({ address, mcap, liquidity, dex, holders })` fires
 * on every explorerCard message. Safe to call again (keeps existing subs).
 */
export function startAzura(callback) {
  onUpdate = callback;
  if (running) return;
  running = true;
  connect();
}

export function stopAzura() {
  running = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopPing();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  subs.clear();
}
