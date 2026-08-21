#!/usr/bin/env node
/**
 * Proxy benchmark: A (raw tunnel) vs C (Undici) vs D (Got+Agent) vs E (https+Agent)
 *
 * Usage:
 *   node scripts/benchmark-proxy.js [--requests N] [--concurrency N] [--proxy URL] [--insecure]
 */

import { config } from 'dotenv';
import crypto from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
function flag(name) { return args.includes(`--${name}`); }

const TOTAL_REQUESTS = Number(arg('requests', '30'));
const CONCURRENCY = Number(arg('concurrency', '5'));
const PROXY_URL = (arg('proxy', process.env.GMGN_PROXY_URL || '')).replace(/\/+$/, '');
const PROXY_KEY = process.env.GMGN_PROXY_KEY || process.env.GMGN_API_KEY || '';
const TIME_OFFSET = Number(process.env.GMGN_TIME_OFFSET) || 0;
const INSECURE = flag('insecure');
const API_HOST = 'openapi.gmgn.ai';
const DEFAULT_TOKEN = { chain: 'solana', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' };

if (!PROXY_URL) { console.error('ERROR: GMGN_PROXY_URL not set (use --proxy URL)'); process.exit(1); }
if (!PROXY_KEY) { console.error('ERROR: GMGN_PROXY_KEY / GMGN_API_KEY not set'); process.exit(1); }

function buildUrl() {
  const ts = Math.floor(Date.now() / 1000) - TIME_OFFSET;
  const cid = crypto.randomUUID();
  return `https://${API_HOST}/v1/token/info?chain=${encodeURIComponent(DEFAULT_TOKEN.chain)}&address=${encodeURIComponent(DEFAULT_TOKEN.address)}&timestamp=${ts}&client_id=${cid}`;
}

function buildHeaders() {
  return {
    Accept: 'application/json',
    'X-APIKEY': PROXY_KEY,
    'User-Agent': 'gmgn-cli/1.5.2',
  };
}

// ═══════════════════════════════════════════════════════════════════
// Shared: raw tunnel infrastructure
// ═══════════════════════════════════════════════════════════════════
function parseProxy(proxyUrl) {
  const stripped = String(proxyUrl).replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  const m = /^([^:/]+)(?::(\d+))?$/.exec(stripped);
  if (!m) throw new Error(`Invalid proxy URL: ${proxyUrl}`);
  return { host: m[1], port: m[2] ? Number(m[2]) : 8080 };
}

function openHttpConnectTunnel(proxy, targetHost, targetPort, timeoutMs) {
  const { host, port } = parseProxy(proxy);
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('proxy CONNECT timed out')); });
    socket.on('error', (err) => reject(new Error(`proxy connect failed: ${err.message}`)));
    socket.on('connect', () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });
    socket.on('close', () => reject(new Error('proxy CONNECT closed before response')));
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf(Buffer.from('\r\n\r\n'));
      if (idx === -1) return;
      const head = buf.slice(0, idx).toString();
      socket.removeAllListeners('data');
      socket.setTimeout(0).removeAllListeners('close');
      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        socket.destroy();
        return reject(new Error(`proxy CONNECT rejected: ${head.split('\r\n')[0]}`));
      }
      const tlsSocket = tls.connect({ socket, servername: targetHost, rejectUnauthorized: !INSECURE });
      tlsSocket.on('error', (err) => reject(new Error(`tls handshake failed: ${err.message}`)));
      tlsSocket.on('secureConnect', () => { tlsSocket.setTimeout(0); resolve(tlsSocket); });
    });
  });
}

function decodeChunked(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const crlf = buf.indexOf(Buffer.from('\r\n'), pos);
    if (crlf === -1) break;
    const sizeHex = buf.slice(pos, crlf).toString().trim();
    if (!sizeHex) break;
    const size = parseInt(sizeHex, 16);
    if (!Number.isFinite(size) || size === 0) break;
    pos = crlf + 2;
    out.push(buf.subarray(pos, pos + size));
    pos += size + 2;
  }
  return Buffer.concat(out);
}

function decodeBody(buf, resHeaders) {
  if (String(resHeaders['transfer-encoding']).toLowerCase().includes('chunked')) buf = decodeChunked(buf);
  const enc = String(resHeaders['content-encoding'] || '').toLowerCase().trim();
  if (enc === 'gzip') buf = zlib.gunzipSync(buf);
  else if (enc === 'deflate') buf = zlib.inflateSync(buf);
  else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
  return buf;
}

// ═══════════════════════════════════════════════════════════════════
// Strategy A: Raw tunnel, Connection: close (current behavior)
// ═══════════════════════════════════════════════════════════════════
function buildStrategyA() {
  return async () => {
    const url = buildUrl();
    const headers = buildHeaders();
    const u = new URL(url);
    const tlsSocket = await openHttpConnectTunnel(PROXY_URL, u.hostname, u.port || 443, 10_000);
    const path = u.pathname + u.search;
    const headLines = [`GET ${path} HTTP/1.1`, `Host: ${u.hostname}`, 'Connection: close'];
    for (const [k, v] of Object.entries(headers)) headLines.push(`${k}: ${v}`);
    const req = headLines.join('\r\n') + '\r\n\r\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { tlsSocket.destroy(); reject(new Error('timeout')); }, 10_000);
      let raw = Buffer.alloc(0);
      tlsSocket.on('error', (err) => { clearTimeout(timer); reject(err); });
      tlsSocket.on('data', (chunk) => { raw = Buffer.concat([raw, chunk]); });
      tlsSocket.on('end', () => {
        clearTimeout(timer);
        try {
          const idx = raw.indexOf(Buffer.from('\r\n\r\n'));
          const head = raw.slice(0, idx).toString();
          let bodyBuf = raw.slice(idx + 4);
          const statusLine = head.split('\r\n')[0];
          const status = Number(/HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine)?.[1]) || 0;
          const resHeaders = {};
          for (const line of head.split('\r\n').slice(1)) {
            const c = line.indexOf(':');
            if (c === -1) continue;
            resHeaders[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
          }
          bodyBuf = decodeBody(bodyBuf, resHeaders);
          resolve({ status });
        } catch (err) { reject(err); }
      });
      tlsSocket.write(req);
    });
  };
}

// ═══════════════════════════════════════════════════════════════════
// Strategy C: Undici ProxyAgent
// ═══════════════════════════════════════════════════════════════════
let undiciDispatcher = null;

async function getUndiciDispatcher() {
  if (undiciDispatcher) return undiciDispatcher;
  const { ProxyAgent } = await import('undici');
  const connectOpts = { timeout: 10_000 };
  if (INSECURE) connectOpts.connect = { tls: { rejectUnauthorized: false } };
  undiciDispatcher = new ProxyAgent(PROXY_URL, { connect: connectOpts });
  return undiciDispatcher;
}

function buildStrategyC() {
  return async () => {
    const { request } = await import('undici');
    const url = buildUrl();
    const headers = buildHeaders();
    const dispatcher = await getUndiciDispatcher();
    const { statusCode } = await request(url, {
      dispatcher,
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    return { status: statusCode };
  };
}

// ═══════════════════════════════════════════════════════════════════
// Strategy D: Got + HttpsProxyAgent
// ═══════════════════════════════════════════════════════════════════
let gotAgent = null;

async function getGotAgent() {
  if (gotAgent) return gotAgent;
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  gotAgent = new HttpsProxyAgent(PROXY_URL, {
    rejectUnauthorized: !INSECURE,
    timeout: 10_000,
  });
  return gotAgent;
}

function buildStrategyD() {
  return async () => {
    const got = (await import('got')).default;
    const agent = await getGotAgent();
    const url = buildUrl();
    const headers = buildHeaders();
    const response = await got(url, {
      agent: { https: agent },
      headers,
      timeout: { request: 10_000 },
      throwHttpErrors: false,
    });
    return { status: response.statusCode };
  };
}

// ═══════════════════════════════════════════════════════════════════
// Strategy E: https.request + HttpsProxyAgent
// ═══════════════════════════════════════════════════════════════════
let httpsAgent = null;

async function getHttpsAgent() {
  if (httpsAgent) return httpsAgent;
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  httpsAgent = new HttpsProxyAgent(PROXY_URL, {
    rejectUnauthorized: !INSECURE,
    timeout: 10_000,
  });
  return httpsAgent;
}

function buildStrategyE() {
  return async () => {
    const agent = await getHttpsAgent();
    const url = buildUrl();
    const headers = buildHeaders();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 10_000);
      const req = https.request(url, { agent, headers, method: 'GET' }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode });
        });
      });
      req.on('error', (err) => { clearTimeout(timer); reject(err); });
      req.setTimeout(10_000, () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
  };
}

// ═══════════════════════════════════════════════════════════════════
// Validation: verify egress IP
// ═══════════════════════════════════════════════════════════════════
async function getLocalIp() {
  try {
    const { request } = await import('undici');
    const { body } = await request('https://api64.ipify.org?format=json', { signal: AbortSignal.timeout(3000) });
    const json = await body.json();
    return json?.ip || null;
  } catch { return null; }
}

async function getProxyEgressIp() {
  try {
    const { request } = await import('undici');
    const dispatcher = await getUndiciDispatcher();
    const { body } = await request('https://api64.ipify.org?format=json', {
      dispatcher,
      signal: AbortSignal.timeout(3000),
      headers: { Accept: 'application/json' },
    });
    const json = await body.json();
    return json?.ip || null;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// Benchmark runner
// ═══════════════════════════════════════════════════════════════════
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

async function runBatch(name, fn, total, concurrency) {
  const latencies = [];
  const errors = [];
  let running = 0;
  let completed = 0;

  return new Promise((resolve) => {
    function next() {
      while (running < concurrency && completed < total) {
        running++;
        const start = performance.now();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('request timeout')), 15_000)
        );
        Promise.race([fn(), timeoutPromise])
          .then(() => {
            const elapsed = performance.now() - start;
            latencies.push(elapsed);
            completed++;
            running--;
            if (completed % 10 === 0 || completed === total) {
              process.stdout.write(`\r  ${name}: ${completed}/${total} done, last ${elapsed.toFixed(0)}ms`);
            }
            next();
          })
          .catch((err) => {
            errors.push(err.message || String(err));
            completed++;
            running--;
            next();
          });
      }
      if (completed >= total && running === 0) {
        console.log('');
        resolve({ stats: stats(latencies), errors, latencies });
      }
    }
    next();
  });
}

// ═══════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  GMGN Proxy Benchmark');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Proxy:       ${PROXY_URL}${INSECURE ? ' (insecure/tls-skip)' : ''}`);
  console.log(`  Token:       ${DEFAULT_TOKEN.chain}:${DEFAULT_TOKEN.address}`);
  console.log(`  Requests:    ${TOTAL_REQUESTS}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log('');

  // Validate egress IP
  console.log('─── Egress IP Validation ───────────────────────────────');
  const localIp = await getLocalIp().catch(() => null);
  const proxyIp = await getProxyEgressIp().catch(() => null);
  console.log(`  Local IP (no proxy): ${localIp || 'unknown'}`);
  console.log(`  Proxy egress IP:     ${proxyIp || 'unknown (failed)'}`);
  if (localIp && proxyIp && localIp === proxyIp) {
    console.log('  WARNING: proxy egress matches local IP — proxy may not be routing!');
  } else if (localIp && proxyIp) {
    console.log('  OK: Proxy routing confirmed (IPs differ)');
  }
  console.log('');

  // Warm up
  console.log('─── Warmup ─────────────────────────────────────────────');
  const strategies = [
    ['A (raw tunnel)', buildStrategyA()],
    ['C (undici)', buildStrategyC()],
    ['D (got+agent)', buildStrategyD()],
    ['E (https+agent)', buildStrategyE()],
  ];
  for (const [label, fn] of strategies) {
    try { await fn(); process.stdout.write(`  ${label}: ok  `); } catch (e) { process.stdout.write(`  ${label}: FAIL (${e.message})  `); }
  }
  console.log('\n');

  // Run benchmarks
  const results = {};
  const scenarios = [
    { label: '1 req', total: 1, concurrency: 1 },
    { label: 'seq x10', total: 10, concurrency: 1 },
    { label: `conc x${TOTAL_REQUESTS}`, total: TOTAL_REQUESTS, concurrency: CONCURRENCY },
  ];

  for (const scenario of scenarios) {
    console.log(`─── Benchmark: ${scenario.label} ─────────────────`);
    results[scenario.label] = {};
    for (const [label, buildFn] of [
      ['A', buildStrategyA],
      ['C', buildStrategyC],
      ['D', buildStrategyD],
      ['E', buildStrategyE],
    ]) {
      results[scenario.label][label] = await runBatch(label, buildFn(), scenario.total, scenario.concurrency);
    }
  }

  // Print results
  function printResult(label, result) {
    const s = result.stats;
    const errStr = result.errors.length ? `  errors=${result.errors.length}` : '';
    console.log(`  ${label.padEnd(15)} mean=${String(s.mean.toFixed(0)).padStart(5)}ms  p50=${String(s.p50.toFixed(0)).padStart(5)}ms  p95=${String(s.p95.toFixed(0)).padStart(5)}ms  min=${String(s.min.toFixed(0)).padStart(5)}ms  max=${String(s.max.toFixed(0)).padStart(5)}ms${errStr}`);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════════════════════');
  for (const scenario of scenarios) {
    console.log('');
    console.log(`  ${scenario.label}:`);
    const r = results[scenario.label];
    for (const key of ['A', 'C', 'D', 'E']) {
      printResult(key, r[key]);
    }
  }

  // Summary
  console.log('');
  console.log('─── Summary ─────────────────────────────────────────────');
  const names = { A: 'raw-tunnel', C: 'undici', D: 'got+agent', E: 'https+agent' };
  for (const scenario of scenarios) {
    const r = results[scenario.label];
    const vals = { A: r.A.stats.mean, C: r.C.stats.mean, D: r.D.stats.mean, E: r.E.stats.mean };
    const sorted = Object.entries(vals).sort((a, b) => a[1] - b[1]);
    const fastest = sorted[0];
    const slowest = sorted[sorted.length - 1];
    const speedup = ((slowest[1] - fastest[1]) / slowest[1] * 100).toFixed(0);
    const ranking = sorted.map(([k, v]) => `${names[k]}=${v.toFixed(0)}ms`).join('  ');
    console.log(`  ${scenario.label.padEnd(10)} fastest=${names[fastest[0]]} (${fastest[1].toFixed(0)}ms)  diff=${speedup}%  [${ranking}]`);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch((err) => { console.error(err); process.exit(1); });
