import 'dotenv/config';
import crypto from 'node:crypto';

const API_HOST = 'https://openapi.gmgn.ai';

async function tryTimestamp(offset, apiKey, proxy) {
  const timestamp = Math.floor(Date.now() / 1000) - offset;
  const client_id = crypto.randomUUID();
  const url = `${API_HOST}/v1/trenches?chain=sol&timestamp=${timestamp}&client_id=${client_id}`;
  const body = JSON.stringify({ version: 'v2', new_creation: { limit: 1, filters: ['offchain', 'onchain'] } });
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'gmgn-cli/1.5.2',
    'X-APIKEY': apiKey,
    Accept: 'application/json',
  };

  try {
    const { ProxyAgent, request } = await import('undici');
    const dispatcher = proxy ? new ProxyAgent(proxy, { connect: { timeout: 10_000, tls: { rejectUnauthorized: false } } }) : undefined;
    const opts = { method: 'POST', body, headers, signal: AbortSignal.timeout(15_000) };
    if (dispatcher) opts.dispatcher = dispatcher;
    const res = await request(url, opts);
    const text = await res.body.text();
    let json;
    try { json = JSON.parse(text); } catch {}
    return { status: res.statusCode, code: json?.code, error: json?.error, message: json?.message };
  } catch (err) {
    return { status: 0, error: err.message };
  }
}

// Load proxy configs from store
const { proxyConfigs } = await import('../src/stores.js');
const all = proxyConfigs.getAll();
const entries = Object.entries(all).filter(([, v]) => v?.url && v?.apiKey);

if (entries.length === 0) {
  console.error('No proxy configured. Configure one via Settings → Proxies GMGN first.');
  process.exit(1);
}

const [tab, cfg] = entries[0];
console.log(`Using proxy from tab "${tab}": ${cfg.url}`);
console.log(`Local Unix time: ${Math.floor(Date.now() / 1000)}`);
console.log('');

// Negative offset = local clock is BEHIND GMGN (add time)
// Positive offset = local clock is AHEAD of GMGN (subtract time)
const offsets = [-10, -20, -25, -30, -35, -40, -50, -60, -80, 0, 20, 50, 80, 100, 120, 150];
console.log('Probing offsets (offset = seconds subtracted from local time)...');
console.log('Negative = local clock behind GMGN. Positive = local clock ahead of GMGN.');
console.log('');

for (const offset of offsets) {
  const result = await tryTimestamp(offset, cfg.apiKey, cfg.url);
  const ts = Math.floor(Date.now() / 1000) - offset;
  const ok = result.code === 0;
  const tag = ok ? 'OK ✓' : (result.error || `HTTP ${result.status}`);
  console.log(`offset=${String(offset).padStart(4)}s  ts=${ts}  → ${tag}`);
  if (ok) {
    console.log(`\n>>> WORKING OFFSET: ${offset}`);
    console.log(`>>> Update .env: GMGN_TIME_OFFSET=${offset}`);
    break;
  }
  await new Promise(r => setTimeout(r, 300));
}
