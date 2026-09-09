/**
 * Quick test: BSC completed with max_created=90m, min_bot_degen_rate=0.3
 * Usage: node scripts/test-bsc-completed.js <API_KEY> [PROXY_URL]
 */
import crypto from 'node:crypto';

const apiKey = process.argv[2];
const proxy = process.argv[3] || '';

if (!apiKey) {
  console.error('Usage: node scripts/test-bsc-completed.js <API_KEY> [PROXY_URL]');
  process.exit(1);
}

const body = {
  version: 'v2',
  completed: {
    filters: ['offchain', 'onchain'],
    launchpad_platform_v2: true,
    limit: 50,
    max_created: '90m',
    min_bot_degen_rate: 0.3,
    launchpad_platform: [
      'fourmeme', 'fourmeme_agent', 'bn_fourmeme', 'four_xmode_agent',
      'cubepeg', 'likwid', 'goplus_creator', 'goplus_skills', 'openfour',
      'flap', 'flap_stocks', 'flap_aioracle', 'clanker', 'lunafun',
    ],
    quote_address_type: [6, 7, 1, 16, 8, 3, 9, 10, 2, 17, 18, 0],
  },
};

const timestamp = Math.floor(Date.now() / 1000);
const client_id = crypto.randomUUID();
const url = `https://openapi.gmgn.ai/v1/trenches?chain=bsc&timestamp=${timestamp}&client_id=${client_id}`;

console.log('Testing BSC completed: max_created=90m, min_bot_degen_rate=0.3');
console.log('URL:', url);
console.log('Body:', JSON.stringify(body, null, 2));

let res;
if (proxy) {
  const { ProxyAgent, request } = await import('undici');
  const dispatcher = new ProxyAgent(proxy, { connect: { timeout: 10000, tls: { rejectUnauthorized: false } } });
  res = await request(url, {
    dispatcher,
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'gmgn-cli/1.5.2',
      'X-APIKEY': apiKey,
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.body.text();
  console.log('\nStatus:', res.statusCode);
  try {
    const json = JSON.parse(text);
    const items = json?.data?.completed ?? [];
    console.log('Results:', items.length, 'tokens');
    if (items.length > 0) {
      for (const t of items.slice(0, 5)) {
        console.log(`  - ${t.symbol || t.name} | MCap: $${t.usd_market_cap} | Bot%: ${t.bot_degen_rate}`);
      }
    }
  } catch {
    console.log('Response:', text.slice(0, 500));
  }
} else {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'gmgn-cli/1.5.2',
        'X-APIKEY': apiKey,
        'Accept': 'application/json',
      },
    });
    const json = await res.json();
    const items = json?.data?.completed ?? [];
    console.log('\nStatus:', res.status);
    console.log('Results:', items.length, 'tokens');
    if (items.length > 0) {
      for (const t of items.slice(0, 5)) {
        console.log(`  - ${t.symbol || t.name} | MCap: $${t.usd_market_cap} | Bot%: ${t.bot_degen_rate}`);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
