import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import { broadcast } from './ws-server.js';

// Cielo Finance live WS (Centrifugo 6.9.6 OSS protocol, no auth/proxy needed).
// `dex:price_marketcap:solana:<mint>` pushes { price_usd, market_cap_usd } on
// every swap — a second live market-cap source compared against GMGN in-app.
const CIELO_WS_URL = 'wss://stream.cielo.finance/connection/websocket';

let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let connectSeq = 0;
let msgId = 1;
let handshakeDone = false;
let lastError = null;
let received = 0;

const subscribedTokens = new Set(); // upstream price_marketcap channels wanted
const cieloData = new Map(); // address -> latest { price, mcap, pool, ... }

function channelFor(address) {
  return `dex:price_marketcap:solana:${address}`;
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ...obj, id: msgId++ }));
  }
}

function sendSubscriptions() {
  for (const address of subscribedTokens) {
    send({ subscribe: { channel: channelFor(address), flag: 1 } });
  }
}

function scheduleReconnect(delay) {
  if (reconnectTimer) return;
  const d = delay ?? Math.min(5000 * 2 ** reconnectAttempts, 60_000) + Math.floor(Math.random() * 1000);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, d);
}

function handlePush(push) {
  const channel = push.channel;
  if (typeof channel !== 'string' || !channel.startsWith('dex:price_marketcap:solana:')) return;
  const address = channel.slice('dex:price_marketcap:solana:'.length);
  const payload = push.pub?.data?.data;
  if (!address || !payload) return;

  const price = Number(payload.price_usd);
  const mcap = Number(payload.market_cap_usd);
  if (!Number.isFinite(price) || !Number.isFinite(mcap)) return;

  received++;
  const data = {
    price,
    mcap,
    pool: payload.pool_address ?? null,
    source: 'cielo',
    updatedAt: Date.now(),
  };
  cieloData.set(address, data);

  broadcast(`token_cielo:${address}`, {
    event: `token_cielo:${address}`,
    type: 'price_marketcap',
    address,
    data,
  });
}

function handleMessage(socket, raw) {
  if (socket !== ws) return;
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }

  // Centrifugo pings with a bare {} and expects a bare {} pong back.
  if (msg && typeof msg === 'object' && !Array.isArray(msg) && Object.keys(msg).length === 0) {
    if (socket === ws && socket.readyState === WebSocket.OPEN) socket.send('{}');
    return;
  }

  if (msg.connect) {
    handshakeDone = true;
    lastError = null;
    console.log(`[cielo-ws] connected (client ${msg.connect.client || '?'})`);
    sendSubscriptions();
    return;
  }
  if (msg.error) {
    lastError = `id=${msg.id} ${JSON.stringify(msg.error)}`;
    console.error(`[cielo-ws] error:`, lastError);
    return;
  }
  if (msg.subscribe || msg.unsubscribe || msg.pong) return;
  if (msg.push) handlePush(msg.push);
}

function connect() {
  if (ws) return;
  const seq = ++connectSeq;
  const socket = new WebSocket(CIELO_WS_URL);
  ws = socket;
  handshakeDone = false;
  console.log(`[cielo-ws] connecting (attempt ${reconnectAttempts + 1})`);

  socket.on('open', () => {
    if (ws !== socket || seq !== connectSeq) {
      try { socket.close(); } catch {}
      return;
    }
    reconnectAttempts = 0;
    send({
      connect: {
        data: { session_id: randomUUID(), opened_at: Math.floor(Date.now() / 1000) },
        name: 'js',
      },
    });
  });
  socket.on('message', (raw) => handleMessage(socket, raw));
  socket.on('error', (err) => {
    if (ws !== socket) return;
    console.error('[cielo-ws] socket error:', err.message);
    lastError = err.message;
  });
  socket.on('unexpected-response', (req, res) => {
    if (ws !== socket) {
      res.resume();
      return;
    }
    let body = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      console.error(`[cielo-ws] handshake rejected: HTTP ${res.statusCode} body=${JSON.stringify(body.slice(0, 300))}`);
      lastError = `HTTP ${res.statusCode} ${body.slice(0, 120)}`;
      ws = null;
      handshakeDone = false;
      scheduleReconnect();
      try { socket.terminate(); } catch {}
    };
    res.on('data', (c) => {
      if (body.length < 600) body += c;
    });
    res.on('end', finish);
    res.on('error', finish);
    setTimeout(finish, 3000);
  });
  socket.on('close', (code, reason) => {
    if (ws !== socket) return;
    ws = null;
    handshakeDone = false;
    console.log(`[cielo-ws] closed (${code}${reason ? ' ' + reason.toString() : ''})`);
    scheduleReconnect();
  });
}

export function startCieloWs() {
  connect();
}

export function subscribeCieloToken(address) {
  if (!address) return;
  const first = !subscribedTokens.has(address);
  subscribedTokens.add(address);
  if (first && handshakeDone) send({ subscribe: { channel: channelFor(address), flag: 1 } });
}

export function unsubscribeCieloToken(address) {
  if (!address || !subscribedTokens.delete(address)) return;
  if (handshakeDone) send({ unsubscribe: { channel: channelFor(address) } });
}

export function getCieloData(address) {
  return cieloData.get(address) || null;
}

export function getCieloStatus() {
  return {
    connected: !!ws && handshakeDone,
    connecting: !!ws && !handshakeDone,
    tokens: subscribedTokens.size,
    received,
    lastError,
    attempts: reconnectAttempts,
  };
}
