import crypto from 'node:crypto';
import { tunnelRequest } from '../services/proxy-tunnel.js';

const API_HOST = 'https://openapi.gmgn.ai';
const USER_AGENT = 'gmgn-cli/1.5.2';
const TIMEOUT_MS = 90_000;

const QUOTE_ADDRESS_TYPES = {
  sol: [4, 5, 3, 1, 13, 0],
  bsc: [6, 7, 1, 16, 8, 3, 9, 10, 2, 17, 18, 0],
  base: [11, 3, 12, 13, 0],
  eth: [20, 11, 8, 3, 12, 1, 0],
  robinhood: [11, 20, 24, 12, 0],
};

const PRESETS = {
  safe: { max_rug_ratio: 0.3, max_bundler_rate: 0.3, max_insider_ratio: 0.3 },
  'smart-money': { min_smart_degen_count: 1 },
  strict: {
    max_rug_ratio: 0.3,
    max_bundler_rate: 0.3,
    max_insider_ratio: 0.3,
    min_smart_degen_count: 1,
    min_volume_24h: 1000,
  },
};

// Client-side sort mirrors gmgn-cli's market.js so HTTP-direct results match
// what the spawn-based path would have returned.
const SORT_ASC_DEFAULTS = new Set(['rug_ratio']);
const STRING_NUMERIC_FIELDS = new Set(['usd_market_cap', 'liquidity', 'volume_1h', 'volume_24h']);

function sortCategory(items, sortBy, direction) {
  const dir = direction || (SORT_ASC_DEFAULTS.has(sortBy) ? 'asc' : 'desc');
  return [...items].sort((a, b) => {
    const av = STRING_NUMERIC_FIELDS.has(sortBy) ? parseFloat(String(a[sortBy] ?? 0)) : Number(a[sortBy] ?? 0);
    const bv = STRING_NUMERIC_FIELDS.has(sortBy) ? parseFloat(String(b[sortBy] ?? 0)) : Number(b[sortBy] ?? 0);
    return dir === 'asc' ? av - bv : bv - av;
  });
}

function sortResult(data, sortBy, direction) {
  if (!sortBy) return data;
  const result = {};
  for (const [key, val] of Object.entries(data)) {
    result[key] = Array.isArray(val) ? sortCategory(val, sortBy, direction) : val;
  }
  return result;
}

function parseDuration(value) {
  if (/^\d+(\.\d+)?[sm]$/.test(value)) return value;
  if (/^\d+(\.\d+)?$/.test(value)) return `${value}m`;
  return String(value);
}

/**
 * Parses the args produced by buildTrenchesArgs() into the raw filter payload
 * the /v1/trenches endpoint expects, replicating gmgn-cli's buildTrenchesBody
 * and its flag→filter mapping (preset first, explicit ranges override it).
 */
function buildBodyFromArgs(args) {
  let chain = 'sol';
  const types = [];
  const platforms = [];
  let limit = 80;
  let preset = null;
  const filters = {};

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === '--chain') { chain = value; continue; }
    if (flag === '--type') { types.push(value); continue; }
    if (flag === '--launchpad-platform') { platforms.push(value); continue; }
    if (flag === '--filter-preset') { preset = value; continue; }
    if (flag === '--limit') { limit = Number(value); continue; }
    if (flag === '--sort-by' || flag === '--direction') continue;
    if (flag.startsWith('--')) {
      const apiKey = flag.slice(2).replace(/-/g, '_');
      const v = apiKey.endsWith('_created') ? parseDuration(value) : Number(value);
      filters[apiKey] = v;
    }
  }

  const section = {
    filters: ['offchain', 'onchain'],
    launchpad_platform_v2: true,
    limit,
    ...(preset ? PRESETS[preset] : {}),
    ...filters,
  };
  if (platforms.length) section.launchpad_platform = platforms;
  const quote = QUOTE_ADDRESS_TYPES[chain] ?? [];
  if (quote.length) section.quote_address_type = quote;

  const body = { version: 'v2' };
  for (const type of types.length ? types : ['new_creation', 'near_completion', 'completed']) {
    body[type] = { ...section };
  }
  return body;
}

function formatLocalTimestamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const oh = p(Math.floor(Math.abs(offsetMinutes) / 60));
  const om = p(Math.abs(offsetMinutes) % 60);
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())} GMT${sign}${oh}:${om}`;
}

function buildErrorMessage({ method, path, status, apiCode, apiError, apiMessage, resetAtUnix }) {
  const parts = [`${method} ${path} failed: HTTP ${status}`];
  if (apiCode != null) parts.push(`code=${apiCode}`);
  if (apiError) parts.push(`error=${apiError}`);
  if (apiMessage) parts.push(`message=${apiMessage}`);
  if (status !== 429) return parts.join(' ');
  const resetText = resetAtUnix != null ? formatLocalTimestamp(new Date(resetAtUnix * 1000)) : 'an unknown time';
  if (apiError === 'RATE_LIMIT_EXCEEDED' || apiError === 'RATE_LIMIT_BANNED') {
    return `${parts.join(' ')}. Rate limit resets at ${resetText}. Stop sending requests before then; repeated requests can extend the ban by 5s up to 5 minutes.`;
  }
  return `${parts.join(' ')}. Received HTTP 429; retry after ${resetText}.`;
}

/**
 * Fetches the trenches views directly from GMGN OpenAPI over HTTPS. Optional
 * HTTP proxy (raw CONNECT tunnel — NOT https-proxy-agent, which silently falls
 * back to the local egress IP) + X-APIKEY. Without a proxy the request goes
 * directly from the server's own IP (still authenticated with the key).
 * @param {string[]} args - output of buildTrenchesArgs(params)
 * @param {{ proxy?: string, apiKey: string }} connection
 */
export async function fetchTrenchesHttp(args, connection) {
  const { proxy = '', apiKey } = connection;
  if (!apiKey) throw new Error('fetchTrenchesHttp requires apiKey');

  const body = buildBodyFromArgs(args);
  const timestamp = Math.floor(Date.now() / 1000) - (Number(process.env.GMGN_TIME_OFFSET) || 0);
  const client_id = crypto.randomUUID();
  const url = `${API_HOST}/v1/trenches?chain=${chainArg(args)}&timestamp=${timestamp}&client_id=${client_id}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    if (proxy) {
      res = await tunnelRequest(url, {
        proxy,
        method: 'POST',
        body: JSON.stringify(body),
        timeoutMs: TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          'X-APIKEY': apiKey,
          Accept: 'application/json',
        },
      });
    } else {
      res = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(body),
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          'X-APIKEY': apiKey,
          Accept: 'application/json',
        },
      });
    }
  } catch (err) {
    throw new Error(`POST /v1/trenches fetch failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const resetUnixRaw = res.headers?.get ? res.headers.get('x-ratelimit-reset') : res.headers?.['x-ratelimit-reset'];
  const resetUnix = parseInt(resetUnixRaw || '', 10);
  const resetAtUnix = Number.isFinite(resetUnix) && resetUnix > 0 ? resetUnix : undefined;

  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body → non-429 error below */
  }

  if (res.status === 429 || json?.code !== 0) {
    const e = new Error(
      buildErrorMessage({
        method: 'POST',
        path: '/v1/trenches',
        status: res.status,
        apiCode: json?.code,
        apiError: json?.error,
        apiMessage: json?.message,
        resetAtUnix,
      })
    );
    if (res.status === 429) e.status = 429;
    throw e;
  }

  const data = json?.data ?? {};
  const result = {
    new_creation: data.new_creation ?? [],
    near_completion: data.near_completion ?? data.pump ?? [],
    completed: data.completed ?? [],
  };
  return sortResult(result, extractSort(args), extractDirection(args));
}

function extractSort(args) {
  const i = args.indexOf('--sort-by');
  return i === -1 ? null : args[i + 1];
}
function extractDirection(args) {
  const i = args.indexOf('--direction');
  return i === -1 ? null : args[i + 1];
}
function chainArg(args) {
  const i = args.indexOf('--chain');
  return i === -1 ? 'sol' : args[i + 1];
}