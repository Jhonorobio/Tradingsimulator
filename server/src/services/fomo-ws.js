import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { broadcast } from './ws-server.js';
import { resolveSupply } from './gmgn-ws.js';

// fomo.family live WS — second market-cap source (compared against GMGN).
// Auth: Privy challenge/JWT (1h) auto-refreshed via refresh_token.

const FOMO_WS_URL = 'wss://prod-api.fomo.family/ws';
const FOMO_ORIGIN = 'https://fomo.family';
const PRIVY_APP_ID = 'cm6h485o300n3zj9yl6vpedq7';
const PRIVY_CLIENT = 'react-auth:3.34.0';
const PRIVY_SESSIONS_URL = 'https://auth.privy.io/api/v1/sessions';
const FOMO_NETWORK_ID = '1399811149'; // Solana in fomo.topic IDs
const TOKEN_MARGIN_MS = 5 * 60_000; // refresh JWT when <5min left

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, '..', '..', 'data'));
const AUTH_FILE = path.join(DATA_DIR, 'fomo-auth.json');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  'Accept-Language': 'es-US,es;q=0.9,en-US;q=0.8,en;q=0.7,es-419;q=0.6',
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
};

let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let authenticated = false;
let refreshInFlight = null;
let diagDone = false;
const subscribedTokens = new Set();
const fomoData = new Map();

// Egress proxy: fomo's WAF returns HTTP 432 for some datacenter IPs (e.g.
// Railway) but accepts others. Sources, in order: FOMO_WS_PROXY (comma-
// separated), proxies pinned for GMGN trenches, GMGN_PROXY_URL. Direct
// connection is the last resort.
function proxyList() {
  const list = [];
  if (process.env.FOMO_WS_PROXY) {
    list.push(...process.env.FOMO_WS_PROXY.split(',').map((s) => s.trim()).filter(Boolean));
  }
  try {
    const pins = JSON.parse(process.env.TRENCHES_PINS || '{}');
    for (const v of Object.values(pins)) {
      if (v && typeof v === 'object' && v.proxy) list.push(v.proxy);
    }
  } catch {}
  if (process.env.GMGN_PROXY_URL) list.push(process.env.GMGN_PROXY_URL);
  return [...new Set(list)];
}

let proxyIdx = 0;

function envProxy() {
  return proxyList().length ? ` via proxy #${proxyIdx % (proxyList().length || 1)}` : '';
}

function rotateProxy() {
  const list = proxyList();
  if (list.length) proxyIdx = (proxyIdx + 1) % list.length;
}

function proxyAgent() {
  const list = proxyList();
  if (!list.length) return undefined;
  const url = list[proxyIdx % list.length];
  return /^socks5/i.test(url) ? new SocksProxyAgent(url) : new HttpsProxyAgent(url);
}

function readAuth() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeAuth(auth) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
  } catch (err) {
    console.error('[fomo-ws] save auth failed:', err.message);
  }
}

function jwtExpiresAt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function doRefresh(refreshToken) {
  const res = await fetch(PRIVY_SESSIONS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'privy-app-id': PRIVY_APP_ID,
      'privy-client': PRIVY_CLIENT,
      Origin: FOMO_ORIGIN,
      'User-Agent': HEADERS['User-Agent'],
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    throw new Error(`refresh HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json.token) throw new Error('refresh returned no access token');
  writeAuth({ refresh_token: refreshToken, access_token: json.token, updated_at: new Date().toISOString() });
  console.log(`[fomo-ws] JWT refreshed (exp ${new Date(jwtExpiresAt(json.token)).toISOString()})`);
  return json.token;
}

async function ensureAccessToken() {
  const stored = readAuth();
  const refreshToken = stored?.refresh_token || process.env.FOMO_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error(`no fomo auth — set FOMO_REFRESH_TOKEN or add refresh_token to ${AUTH_FILE}`);
  }
  if (stored?.access_token && jwtExpiresAt(stored.access_token) - Date.now() > TOKEN_MARGIN_MS) {
    return stored.access_token;
  }
  if (!refreshInFlight) {
    refreshInFlight = doRefresh(refreshToken).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

function invalidateToken() {
  const stored = readAuth();
  if (stored?.access_token) writeAuth({ refresh_token: stored.refresh_token, updated_at: new Date().toISOString() });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function handleData(msg) {
  const address = typeof msg.topicId === 'string' ? msg.topicId.split(':')[0] : null;
  if (!address) return;
  const payload = msg.payload || {};

  let fields;
  if (msg.topicType === 'prices') {
    const price = num(payload.priceUsd);
    fields = {
      price: price != null && price > 0 ? price : undefined,
      priceTimestamp: payload.timestamp ?? undefined,
    };
    if (fields.price == null) delete fields.price;
  } else if (msg.topicType === 'token_details') {
    fields = {
      change1m: num(payload.change1m),
      change5m: num(payload.change5m),
      change1h: num(payload.change1h),
      change4h: num(payload.change4h),
      change6h: num(payload.change6h),
      change12h: num(payload.change12h),
      change24h: num(payload.change24h),
      buys5min: num(payload.buys5min),
      buys1h: num(payload.buys1h),
      buys4h: num(payload.buys4h),
      buys24h: num(payload.buys24h),
      sells1h: num(payload.sells1h),
      detailsTimestamp: payload.timestamp ?? undefined,
    };
    Object.keys(fields).forEach((k) => fields[k] == null && delete fields[k]);
  } else {
    return;
  }

  // Price comes from fomo; supply once per token (Dexscreener FDV÷price).
  const probe = { ...(fomoData.get(address) || {}), ...fields };
  let supply = null;
  if (probe.price) {
    supply = await resolveSupply(address);
  }

  // Re-read after the await so concurrent messages don't clobber each other.
  const data = { ...(fomoData.get(address) || {}), ...fields, source: 'fomo', updatedAt: Date.now() };
  if (supply) data.supply = supply;
  if (data.price && data.supply) data.mcap = data.price * data.supply;
  fomoData.set(address, data);

  broadcast(`token_fomo:${address}`, {
    event: `token_fomo:${address}`,
    type: msg.topicType,
    address,
    data,
  });
}

function sendSubscriptions(address) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !authenticated) return;
  const topicId = `${address}:${FOMO_NETWORK_ID}`;
  for (const topicType of ['prices', 'token_details']) {
    ws.send(JSON.stringify({ type: 'subscribe', topicType, topicId }));
  }
}

function handleMessage(socket, raw) {
  if (socket !== ws) return;
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }

  switch (msg.type) {
    case 'challenge':
      ensureAccessToken()
        .then((token) => {
          if (ws === socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'challengeResponse', jwt: token }));
          }
        })
        .catch((err) => console.error('[fomo-ws] challenge auth failed:', err.message));
      break;
    case 'challengeAccepted':
      authenticated = true;
      console.log('[fomo-ws] authenticated');
      for (const address of subscribedTokens) sendSubscriptions(address);
      break;
    case 'subscribed':
      console.log(`[fomo-ws] subscribed ${msg.topicType} ${msg.topicId}`);
      break;
    case 'data':
      handleData(msg).catch((err) => console.error('[fomo-ws] data failed:', err.message));
      break;
    case 'error':
      console.error(`[fomo-ws] server error ${msg.code || ''}: ${msg.message || JSON.stringify(msg)}`);
      break;
    default:
      break;
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

// One-shot: plain GET to prod-api tells us whether the whole host rejects
// Railway's IP or only the WS upgrade path (helps choose proxy vs headers).
async function diagnoseHost() {
  if (diagDone) return;
  diagDone = true;
  try {
    const res = await fetch('https://prod-api.fomo.family/', {
      headers: { Origin: FOMO_ORIGIN, 'User-Agent': HEADERS['User-Agent'] },
    });
    console.error(`[fomo-ws] diag GET prod-api -> HTTP ${res.status}`);
  } catch (err) {
    console.error(`[fomo-ws] diag GET prod-api failed: ${err.message}`);
  }
}

async function connect() {
  if (ws) return;

  try {
    await ensureAccessToken();
  } catch (err) {
    console.error('[fomo-ws] auth failed:', err.message);
    scheduleReconnect(60_000);
    return;
  }

  const agent = proxyAgent();
  const socket = new WebSocket(FOMO_WS_URL, {
    origin: FOMO_ORIGIN,
    headers: HEADERS,
    ...(agent ? { agent } : {}),
  });
  ws = socket;
  authenticated = false;
  console.log(`[fomo-ws] connecting (attempt ${reconnectAttempts + 1}${envProxy()})`);

  socket.on('open', () => {
    reconnectAttempts = 0;
  });
  socket.on('message', (raw) => handleMessage(socket, raw));
  socket.on('error', (err) => {
    if (ws !== socket) return;
    console.error('[fomo-ws] socket error:', err.message);
  });
  // Non-101 handshake (e.g. 432 from fomo's WAF): log status/body/headers so
  // the reason is visible in Railway logs, then back off exponentially.
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
      console.error(
        `[fomo-ws] handshake rejected: HTTP ${res.statusCode} body=${JSON.stringify(body.slice(0, 300))} ` +
          `cf-ray=${res.headers['cf-ray'] || '-'} retry-after=${res.headers['retry-after'] || '-'}`
      );
      ws = null;
      authenticated = false;
      rotateProxy();
      diagnoseHost();
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
    const wasAuthed = authenticated;
    ws = null;
    authenticated = false;
    console.log(`[fomo-ws] closed (${code}${reason ? ' ' + reason.toString() : ''})`);
    if (!wasAuthed) rotateProxy(); // try another egress on pre-auth failures
    if (code === 1008) {
      invalidateToken();
      scheduleReconnect(15_000);
    } else {
      scheduleReconnect();
    }
  });
}

export function startFomoWs() {
  connect();
}

export function subscribeFomoToken(address) {
  const first = !subscribedTokens.has(address);
  subscribedTokens.add(address);
  if (first) resolveSupply(address); // warm the shared supply cache
  if (authenticated) sendSubscriptions(address);
}

export function getFomoData(address) {
  return fomoData.get(address) || null;
}
