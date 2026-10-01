import { broadcast } from './ws-server.js';
import { getTokenInfo as getDexTokenInfo } from './dexscreener.js';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const CHROME_HEADERS = {
  'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Upgrade-Insecure-Requests': '1',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-User': '?1',
  'Sec-Fetch-Dest': 'document',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'en-US,en;q=0.9',
  'Priority': 'u=0, i',
  'Origin': 'https://gmgn.ai',
};

let impersMod = null;
async function loadImpers() {
  if (impersMod) return impersMod;
  if (!process.env.IMPER_CACHE_DIR && fs.existsSync('/data')) {
    process.env.IMPER_CACHE_DIR = '/data/impers-cache';
  }
  const entry = require.resolve('impers');
  const wsPath = path.join(path.dirname(entry), 'websocket', 'websocket.js');
  if (!fs.existsSync(wsPath) || !fs.readFileSync(wsPath, 'utf8').includes('PATCHED-IMPERS-WS')) {
    throw new Error('impers websocket.js is not patched — run `node scripts/patch-impers-ws.js` (postinstall)');
  }
  impersMod = await import('impers');
  console.log('[gmgn-ws] impers loaded');
  return impersMod;
}

const GMGN_WS_URL = process.env.GMGN_WS_URL || 'wss://ws.gmgn.ai/v2/ws?device_id=45d79a65-5b4e-4d82-a0cf-dfb040754aa2&tab_id=muomurumgr4q&fp_did=be0259deabc5c063263d586f837a88ff&client_id=gmgn_web_20260930-5055-09b0c81&from_app=gmgn&app_ver=20260930-5055-09b0c81&tz_name=America_Bogota&tz_offset=-18000&app_lang=es&os=web&worker=0&uuid=07cdba9e65ac5b95&reconnect=0';

let ws = null;
let reconnectTimer = null;
const subscribedTokens = new Set();
const tokenData = new Map();
const supplyCache = new Map(); // address -> supply (resolved once per token)

async function resolveSupply(address) {
  if (supplyCache.has(address)) return supplyCache.get(address);
  try {
    const dex = await getDexTokenInfo(address);
    const price = Number(dex?.price);
    const mc = Number(dex?.fdv ?? dex?.marketCap);
    const supply = price > 0 && mc > 0 ? mc / price : null;
    console.log(`[gmgn-ws] resolveSupply ${address} -> ${supply ?? 'null'} (dexscreener)`);
    if (supply) {
      supplyCache.set(address, supply);
      const d = tokenData.get(address) || {};
      const updated = { ...d, supply, updatedAt: Date.now() };
      if (updated.price) updated.mcap = updated.price * supply;
      tokenData.set(address, updated);
      if (updated.mcap) {
        broadcast(`token_mcap:${address}`, {
          event: `token_mcap:${address}`,
          type: 'supply',
          address,
          data: updated,
        });
      }
    }
    return supply;
  } catch (err) {
    console.error(`[gmgn-ws] resolveSupply failed ${address}:`, err.message);
    return null;
  }
}

function handleMessage(raw) {
  try {
    const msg = JSON.parse(raw.toString());
    if (msg.channel === 'ack' || !msg.data) return;

    for (const item of msg.data) {
      if (msg.channel === 'token_stat' && item.a) {
        const address = item.a;
        const existing = tokenData.get(address) || {};
        let data = {
          ...existing,
          price: item.p ? Number(item.p) : existing.price,
          volume1h: item.v1h ? Number(item.v1h) : existing.volume1h,
          buys1h: item.b1h,
          sells1h: item.s1h,
          updatedAt: Date.now(),
        };
        if (!data.supply) {
          const s = supplyCache.get(address);
          if (s) data = { ...data, supply: s };
        }
        if (data.price && data.supply) {
          data = { ...data, mcap: data.price * data.supply };
        }
        tokenData.set(address, data);
        broadcast(`token_mcap:${address}`, {
          event: `token_mcap:${address}`,
          type: 'token_stat',
          address,
          data,
        });
      }

      if (msg.channel === 'kline' && item.a) {
        const address = item.a;
        const existing = tokenData.get(address) || {};
        const kline = {
          open: item.o,
          high: item.h,
          low: item.l,
          close: item.c,
          volume: item.v,
          timestamp: item.t,
        };
        let data = { ...existing, kline, updatedAt: Date.now() };
        if (!data.supply) {
          const s = supplyCache.get(address);
          if (s) data = { ...data, supply: s };
        }
        const price = Number(kline.close);
        if (price && data.supply) {
          data = { ...data, price: data.price ?? price, mcap: price * data.supply };
        }
        tokenData.set(address, data);
        if (data.mcap) {
          broadcast(`token_mcap:${address}`, {
            event: `token_mcap:${address}`,
            type: 'kline',
            address,
            data,
          });
        }
      }

      if (msg.channel === 'token_page' && item.ta) {
        const address = item.ta;
        const existing = tokenData.get(address) || {};
        const updates = {};
        if (item.r_t10) updates.top10Ratio = Number(item.r_t10);
        if (item.r_bd) updates.bundleRatio = Number(item.r_bd);
        if (item.r_kol) updates.kolRatio = Number(item.r_kol);
        if (item.r_fw) updates.freshWalletRatio = Number(item.r_fw);
        if (item.r_sdh) updates.smartDegenRatio = Number(item.r_sdh);
        if (item.r_i) updates.insiderRatio = Number(item.r_i);
        if (item.r_e) updates.exchangeRatio = Number(item.r_e);
        if (item.r_b) updates.botRatio = Number(item.r_b);
        if (item.v_c) updates.volumeCount = item.v_c;
        if (item.t === 'total_fee') {
          updates.fees = {
            pf: item.pf,
            tf: item.tf,
            trf: item.trf,
            tof: item.tof,
          };
        }
        if (Object.keys(updates).length) {
          tokenData.set(address, { ...existing, ...updates, updatedAt: Date.now() });
          broadcast(`token_mcap:${address}`, {
            event: `token_mcap:${address}`,
            type: 'token_page',
            address,
            data: tokenData.get(address),
          });
        }
      }

      if (msg.channel === 'token_general_stat_num' && item.a) {
        const address = item.a;
        const existing = tokenData.get(address) || {};
        tokenData.set(address, {
          ...existing,
          holderCount: item.v,
          updatedAt: Date.now(),
        });
        broadcast(`token_mcap:${address}`, {
          event: `token_mcap:${address}`,
          type: 'token_holders',
          address,
          data: tokenData.get(address),
        });
      }
    }
  } catch {}
}

async function pump(socket) {
  try {
    for await (const msg of socket) {
      if (ws !== socket) return;
      handleMessage(msg?.data ?? msg);
    }
    if (ws === socket) {
      console.log('[gmgn-ws] closed by server');
      ws = null;
      scheduleReconnect();
    }
  } catch (err) {
    if (ws === socket) {
      console.error('[gmgn-ws] stream error:', err.message);
      ws = null;
      try { await socket.close(); } catch {}
      scheduleReconnect();
    }
  }
}

async function connect() {
  if (ws) return;

  try {
    const imp = await loadImpers();
    const socket = await imp.wsConnect(GMGN_WS_URL, {
      impersonate: 'chrome131',
      headers: CHROME_HEADERS,
    });
    ws = socket;
    console.log('[gmgn-ws] connected');
    for (const address of subscribedTokens) {
      subscribeToken(address);
    }
    pump(socket);
  } catch (err) {
    console.error('[gmgn-ws] connect failed:', err.message);
    ws = null;
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5000);
}

function subscribeToken(address) {
  const first = !subscribedTokens.has(address);
  subscribedTokens.add(address);
  if (first) resolveSupply(address);
  if (!ws) return;

  const channels = [
    { channel: 'token_stat', data: [{ chain: 'sol', addresses: address }] },
    { channel: 'kline', data: [{ chain: 'sol', addresses: address, interval: '15s' }] },
    { channel: 'token_page', data: [{ chain: 'sol', token_address: address }] },
    { channel: 'token_general_stat_num', data: [{ chain: 'sol', addresses: address }] },
  ];

  const socket = ws;
  (async () => {
    for (const { channel, data } of channels) {
      await socket.sendStr(JSON.stringify({ action: 'subscribe', channel, f: 'w', id: `gmgn_${channel}_${address}`, data }));
    }
    console.log(`[gmgn-ws] subscribed ${address}`);
  })().catch((err) => {
    console.error(`[gmgn-ws] subscribe send failed:`, err.message);
  });
}

export function startGmgnWs() {
  connect();
}

export function subscribeTokenRealtime(address) {
  subscribeToken(address);
}

export function getTokenRealtimeData(address) {
  return tokenData.get(address) || null;
}
