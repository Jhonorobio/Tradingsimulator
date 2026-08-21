import crypto from 'node:crypto';

const PROXY_URL = (process.env.GMGN_PROXY_URL || '').replace(/\/+$/, '');
const PROXY_KEY = process.env.GMGN_PROXY_KEY || '';
const TIME_OFFSET_SEC = Number(process.env.GMGN_TIME_OFFSET) || 0;
const API_HOST = 'https://openapi.gmgn.ai';
const USER_AGENT = 'gmgn-cli/1.5.2';

// Undici ProxyAgent — reuses connections for lower latency (~50-70% faster than raw tunnel).
let undiciDispatcher = null;

async function getDispatcher() {
  if (undiciDispatcher) return undiciDispatcher;
  const { ProxyAgent } = await import('undici');
  undiciDispatcher = new ProxyAgent(PROXY_URL, {
    connect: {
      timeout: 5_000,
      // Some proxies do MITM/SSL inspection with expired certs — skip validation.
      tls: { rejectUnauthorized: false },
    },
  });
  return undiciDispatcher;
}

// Global batch for the GMGN token info API. `token info` has weight 1
// (~20 req/s sustained); we cap at 18 requests per 1s window so bursts from
// the detail page, dashboard and position batches never hit the limit. All
// callers share this single queue.
const BATCH_SIZE = 18;
const WINDOW_MS = 1000;
const FLUSH_DEBOUNCE_MS = 100;

// Short dedupe so overlapping calls for the same token (detail mcap 1s + live
// 2s + portfolio 15s cache) reuse one GMGN request instead of burning extra
// slots from the 18/s budget.
const RESULT_TTL_MS = 800;
const inflight = new Map();
const resultCache = new Map();

let queue = [];
let draining = false;
let flushTimer = null;
let windowStart = 0;
let windowCount = 0;

function keyFor(chain, address) {
  return `${chain}:${address}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    drain();
  }, FLUSH_DEBOUNCE_MS);
}

/** Pushes a { chain, address } lookup into the shared GMGN-proxy batch queue. */
function enqueue(chain, address) {
  return new Promise((resolve, reject) => {
    queue.push({ chain, address, resolve, reject });
    scheduleFlush();
  });
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const now = Date.now();
      if (windowStart === 0) windowStart = now;
      if (windowCount >= BATCH_SIZE) {
        const wait = WINDOW_MS - (now - windowStart);
        if (wait > 0) await sleep(wait);
        windowStart = Date.now();
        windowCount = 0;
        continue;
      }
      const take = Math.min(BATCH_SIZE - windowCount, queue.length);
      const batch = queue.splice(0, take);
      windowCount += take;
      await Promise.allSettled(
        batch.map((item) =>
          rawTokenInfo(item.chain, item.address).then(item.resolve, item.reject)
        )
      );
    }
    windowStart = 0;
    windowCount = 0;
  } finally {
    draining = false;
  }
}

function pct(current, ref) {
  if (current == null || !ref || Number(ref) <= 0) return 0;
  return ((Number(current) - Number(ref)) / Number(ref)) * 100;
}

/**
 * Single HTTP call to GMGN token info. Uses Undici ProxyAgent when
 * GMGN_PROXY_URL is set, otherwise makes a direct fetch call.
 * @param {string} chain
 * @param {string} address
 */
async function rawTokenInfo(chain, address) {
  if (!address) return null;
  const apiKey = PROXY_KEY || process.env.GMGN_API_KEY || '';
  if (!apiKey) return null;

  try {
    const timestamp = Math.floor(Date.now() / 1000) - TIME_OFFSET_SEC;
    const client_id = crypto.randomUUID();
    const url = `${API_HOST}/v1/token/info?chain=${encodeURIComponent(chain)}&address=${encodeURIComponent(address)}&timestamp=${timestamp}&client_id=${client_id}`;
    const headers = {
      Accept: 'application/json',
      'X-APIKEY': apiKey,
      'User-Agent': USER_AGENT,
    };

    let res;
    if (PROXY_URL) {
      // HTTP proxy — use Undici ProxyAgent (faster, connection pooling)
      const dispatcher = await getDispatcher();
      const { request } = await import('undici');
      const undiciRes = await request(url, {
        dispatcher,
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      // Adapt undici response to match the fetch-like interface
      res = {
        status: undiciRes.statusCode,
        json: () => undiciRes.body.json(),
      };
    } else {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
    }

    if (res.status !== 200) return null;
    const json = await res.json().catch(() => null);
    if (json?.code !== 0 || !json?.data) return null;
    const d = json.data;
    const price = Number(d.price?.price);
    if (!Number.isFinite(price) || price <= 0) return null;
    const supply = Number(d.circulating_supply);
    const marketCap = Number.isFinite(supply) && supply > 0 ? price * supply : null;
    const ref = d.price ?? {};
    return {
      address,
      chain,
      source: 'gmgn',
      name: d.name ?? null,
      symbol: d.symbol ?? null,
      logo: d.logo ?? null,
      price,
      marketCap,
      supply: Number.isFinite(supply) && supply > 0 ? supply : null,
      liquidity: Number(d.liquidity) || 0,
      volume24h: Number(ref.volume_24h) || 0,
      holders: d.holder_count ?? null,
      dex: d.pool?.exchange ?? d.launchpad_platform ?? null,
      priceChange:
        ref.price_1m != null || ref.price_24h != null
          ? {
              m5: pct(price, ref.price_5m),
              h1: pct(price, ref.price_1h),
              h6: pct(price, ref.price_6h),
              h24: pct(price, ref.price_24h),
            }
          : null,
    };
  } catch {
    return null;
  }
}

/**
 * Fetches full token info from GMGN via the shared global batch queue.
 * Uses Undici ProxyAgent when GMGN_PROXY_URL is set, otherwise direct HTTPS.
 * GMGN does not return a market cap directly, so it is computed as
 * `price.price * circulating_supply`. Returns `null` on any failure so
 * callers can fall back to Dexscreener.
 *
 * Deduped: concurrent calls for the same token share a single in-flight
 * request, and results are reused for RESULT_TTL_MS (800ms), so the detail
 * screen's mcap (1s) + live (2s) polls for one token cost ~1 slot/s total.
 * @param {string} chain
 * @param {string} address
 */
export async function getProxyTokenInfo(chain, address) {
  const key = keyFor(chain, address);
  const cached = resultCache.get(key);
  if (cached && Date.now() - cached.savedAt < RESULT_TTL_MS) return cached.data;
  if (inflight.has(key)) return inflight.get(key);

  const task = enqueue(chain, address).then((data) => {
    resultCache.set(key, { data, savedAt: Date.now() });
    return data;
  });
  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

/**
 * Fetches just the market cap for a token from the GMGN proxy.
 * Returns `null` on any failure so callers can fall back to Dexscreener.
 * @param {string} chain
 * @param {string} address
 * @returns {Promise<number|null>}
 */
export async function getProxyMarketCap(chain, address) {
  const info = await getProxyTokenInfo(chain, address);
  return info?.marketCap ?? null;
}