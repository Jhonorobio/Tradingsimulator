import { startGmgnWs, subscribeTokenRealtime, getTokenRealtimeData } from './src/services/gmgn-ws.js';

const TOKEN = process.argv[2] || '4vEX32B4LLr2hL4tzdgz724rSYXGccAGT8MRSUaNpump';

startGmgnWs();
setTimeout(() => subscribeTokenRealtime(TOKEN), 1500);

setTimeout(() => {
  const data = getTokenRealtimeData(TOKEN);
  console.log('realtime data:', JSON.stringify(data, null, 2));
  console.log(data && data.price ? 'SMOKE OK' : 'SMOKE FAIL (no price received)');
  process.exit(data && data.price ? 0 : 1);
}, 15000);
