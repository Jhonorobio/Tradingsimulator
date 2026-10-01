import { broadcast } from './ws-server.js';

let CurlWebSocket = null;
async function loadGmgnBinding() {
  if (CurlWebSocket) return CurlWebSocket;
  try {
    const mod = await import('curl-cffi-node');
    CurlWebSocket = mod.CurlWebSocket;
    return CurlWebSocket;
  } catch (err) {
    console.error('[gmgn-ws] curl-cffi-node load failed:', err.message);
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const attempts = [
      '@curl-cffi-node/linux-x64-gnu',
      '@curl-cffi-node/linux-arm64-gnu',
      './curl-cffi-node.linux-x64-gnu.node',
    ];
    for (const a of attempts) {
      try {
        require.resolve(a);
        console.error('[gmgn-ws] resolved:', a);
      } catch (e) {
        console.error('[gmgn-ws] cannot resolve:', a, '-', e.code || e.message);
      }
    }
    throw err;
  }
}

const GMGN_WS_URL = process.env.GMGN_WS_URL || 'wss://ws.gmgn.ai/v2/ws?device_id=45d79a65-5b4e-4d82-a0cf-dfb040754aa2&tab_id=muomurumgr4q&fp_did=be0259deabc5c063263d586f837a88ff&client_id=gmgn_web_20260930-5055-09b0c81&from_app=gmgn&app_ver=20260930-5055-09b0c81&tz_name=America_Bogota&tz_offset=-18000&app_lang=es&os=web&worker=0&uuid=07cdba9e65ac5b95&reconnect=0';

let ws = null;
let reconnectTimer = null;
const subscribedTokens = new Set();
const tokenData = new Map();

async function connect() {
  if (ws) return;

  try {
    const WS = await loadGmgnBinding();
    ws = new WS(GMGN_WS_URL, {
      impersonate: 'chrome131',
      verify: false,
      headers: { 'Origin': 'https://gmgn.ai' },
    });

    ws.on('open', () => {
      console.log('[gmgn-ws] connected');
      for (const address of subscribedTokens) {
        subscribeToken(address);
      }
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.channel === 'ack' || !msg.data) return;

        for (const item of msg.data) {
          if (msg.channel === 'token_stat' && item.a) {
            const address = item.a;
            const existing = tokenData.get(address) || {};
            tokenData.set(address, {
              ...existing,
              price: item.p ? Number(item.p) : existing.price,
              volume1h: item.v1h ? Number(item.v1h) : existing.volume1h,
              buys1h: item.b1h,
              sells1h: item.s1h,
              updatedAt: Date.now(),
            });
            broadcast(`token_mcap:${address}`, {
              event: `token_mcap:${address}`,
              type: 'token_stat',
              address,
              data: tokenData.get(address),
            });
          }

          if (msg.channel === 'kline' && item.a) {
            const address = item.a;
            const existing = tokenData.get(address) || {};
            tokenData.set(address, {
              ...existing,
              kline: {
                open: item.o,
                high: item.h,
                low: item.l,
                close: item.c,
                volume: item.v,
                timestamp: item.t,
              },
              updatedAt: Date.now(),
            });
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
    });

    ws.on('error', (err) => {
      console.error('[gmgn-ws] error:', err.message);
      ws = null;
      scheduleReconnect();
    });

    ws.on('close', () => {
      console.log('[gmgn-ws] closed');
      ws = null;
      scheduleReconnect();
    });

    ws.connect().catch((err) => {
      console.error('[gmgn-ws] connect failed:', err.message);
      ws = null;
      scheduleReconnect();
    });
  } catch (err) {
    console.error('[gmgn-ws] connect error:', err.message);
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
  if (!ws || subscribedTokens.has(address)) return;
  subscribedTokens.add(address);

  const channels = [
    { channel: 'token_stat', data: [{ chain: 'sol', addresses: address }] },
    { channel: 'kline', data: [{ chain: 'sol', addresses: address, interval: '15s' }] },
    { channel: 'token_page', data: [{ chain: 'sol', token_address: address }] },
    { channel: 'token_general_stat_num', data: [{ chain: 'sol', addresses: address }] },
  ];

  for (const { channel, data } of channels) {
    ws.send(JSON.stringify({ action: 'subscribe', channel, f: 'w', id: `gmgn_${channel}_${address}`, data }));
  }
  console.log(`[gmgn-ws] subscribed ${address}`);
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
