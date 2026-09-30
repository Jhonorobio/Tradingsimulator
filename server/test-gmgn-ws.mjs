import { CurlWebSocket } from 'curl-cffi-node';

const TOKEN = '3euDZvSc2aB3pJeFzF8vQBrt5Y8wNmhzn92Yb2RavugK';
const WS_URL = 'wss://ws.gmgn.ai/v2/ws?device_id=45d79a65-5b4e-4d82-a0cf-dfb040754aa2&tab_id=muomurumgr4q&fp_did=be0259deabc5c063263d586f837a88ff&client_id=gmgn_web_20260930-5055-09b0c81&from_app=gmgn&app_ver=20260930-5055-09b0c81&tz_name=America_Bogota&tz_offset=-18000&app_lang=es&os=web&worker=0&uuid=07cdba9e65ac5b95&reconnect=0';

const ws = new CurlWebSocket(WS_URL, {
  impersonate: 'chrome131',
  verify: false,
  headers: { 'Origin': 'https://gmgn.ai' },
});

const channels = [
  { channel: 'token_stat', data: [{ chain: 'sol', addresses: TOKEN }] },
  { channel: 'kline', data: [{ chain: 'sol', addresses: TOKEN, interval: '15s' }] },
  { channel: 'token_page', data: [{ chain: 'sol', token_address: TOKEN }] },
  { channel: 'token_holding', data: [{ chain: 'sol', token_address: TOKEN }] },
  { channel: 'token_activity', data: [{ chain: 'sol', addresses: TOKEN }] },
  { channel: 'token_general_stat_num', data: [{ chain: 'sol', addresses: TOKEN }] },
  { channel: 'twitter_monitor_token', data: [{ chain: 'sol', addresses: TOKEN }] },
];

ws.on('open', async () => {
  console.log('CONNECTED');
  for (const { channel, data } of channels) {
    ws.send(JSON.stringify({ action: 'subscribe', channel, f: 'w', id: `gmgn_${channel}`, data }));
    console.log('SUBSCRIBED:', channel);
  }
  console.log('\n--- Listening for 30s ---\n');
  setTimeout(() => { ws.close(); process.exit(0); }, 30000);
});

ws.on('message', (data) => {
  const s = data.toString();
  try {
    const msg = JSON.parse(s);
    if (msg.channel === 'ack') return;
    if (!msg.data) return;

    for (const item of msg.data) {
      const ts = new Date().toISOString().slice(11, 19);
      switch (msg.channel) {
        case 'token_stat':
          console.log(`[${ts}] STAT p=${item.p} v1h=${item.v1h} b1h=${item.b1h} s1h=${item.s1h}`);
          break;
        case 'kline':
          console.log(`[${ts}] KLINE o=${item.o} h=${item.h} l=${item.l} c=${item.c} v=${item.v}`);
          break;
        case 'token_page':
          console.log(`[${ts}] PAGE t=${item.t} v_c=${item.v_c} r_t10=${item.r_t10} r_bd=${item.r_bd} r_kol=${item.r_kol}`);
          break;
        case 'token_holding':
          console.log(`[${ts}] HOLDING wa=${item.wa?.slice(0,8)} b=${item.b} aca=${item.aca} acc=${item.acc}`);
          break;
        case 'token_activity':
          console.log(`[${ts}] ACTIVITY e=${item.e} m=${item.m?.slice(0,8)} ba=${item.ba} au=${item.au} pu=${item.pu}`);
          break;
        case 'token_general_stat_num':
          console.log(`[${ts}] HOLDERS t=${item.t} v=${item.v}`);
          break;
        case 'twitter_monitor_token':
          console.log(`[${ts}] TWEET @${item.u?.s} f=${item.u?.f} tw=${item.tw} t=${item.c?.t?.slice(0,60)}`);
          break;
      }
    }
  } catch {}
});

ws.on('error', (e) => { console.error('ERR:', e.message); process.exit(1); });
ws.on('close', () => { console.log('CLOSED'); });

await ws.connect();
