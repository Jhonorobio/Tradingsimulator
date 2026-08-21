import { fetchTrenches } from '../cli/args.js';
import { trenchesFilters } from '../stores.js';
import { buildParamsFromConfig, TRENCH_TABS } from './trenches-filters.js';
import { proxyEgressIp } from './proxy-tunnel.js';

// Rate-limit: GMGN allows 1 req/s per API key with 20 weight max.
// Trenches route has weight 20 per request → max 1 req/s per key.
// Each proxy has its own key, so each worker can do 1 req/s independently.
const MIN_INTERVAL_MS = 1050;

/**
 * Background refresher for the Trenches views. Runs one dedicated worker per
 * tab (new_creation / near_completion / completed). Each worker fetches that
 * tab's params on its own adaptive loop: it measures the actual GMGN response
 * time and sleeps only as long as needed to stay within the rate limit.
 *
 * Each tab can be pinned to its own proxy+key with TRENCHES_PINS (JSON, keyed
 * by tab). With separate proxies per tab, each tab has its own 20-token/s
 * bucket — they never compete for rate-limit capacity.
 *
 * At startup we resolve each proxy's real egress IP and de-duplicate: only
 * genuinely distinct IPs get a parallel worker. If all configured proxies
 * share one egress IP, we fall back to one safe worker that round-robins
 * across tabs.
 */
export async function startTrenchesRefresher(_intervalSeconds, { onError = () => {} } = {}) {
  const pins = parsePins();
  const positionalProxies = (process.env.TRENCHES_PROXIES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const positionalKeys = (process.env.TRENCHES_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const allProxyUrls = [...new Set([...Object.values(pins).map((c) => c.proxy), ...positionalProxies])];
  const distinct = allProxyUrls.length ? await resolveDistinctProxies(allProxyUrls) : [];
  const WORKERS = Math.max(distinct.length, 1);

  const connectionFor = (tab) => connectionForTab(tab, pins, positionalProxies, positionalKeys);
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const rebuildQueue = () => {
    const all = trenchesFilters.getAll();
    const configs = Object.values(all).map((entry) => entry?.filters ?? null).filter(Boolean);
    // Only refresh user-saved filter configs per tab (no default/null view)

    const seen = new Set();
    const queue = [];
    for (const config of configs) {
      for (const tab of TRENCH_TABS) {
        const params = buildParamsFromConfig(config, tab);
        const key = JSON.stringify({ t: tab, p: params });
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push({ tab, params });
      }
    }
    return queue;
  };

  // When we have as many distinct IPs as tabs → dedicated worker per tab.
  // Each worker only processes its own tab's params combos.
  if (WORKERS >= TRENCH_TABS.length) {
    for (const tab of TRENCH_TABS) {
      const connection = connectionFor(tab);
      setTimeout(() => tabWorker(tab, connection, rebuildQueue, delay, onError), 0);
    }
  } else {
    // Fewer IPs than tabs → single worker round-robins across all tabs.
    // Still adapts to response time per call.
    setTimeout(() => sharedWorker(rebuildQueue, connectionFor, delay, onError), 0);
  }

  return {
    workers: WORKERS,
    egressIps: distinct.map((d) => d.ip),
    pins: Object.keys(pins),
    mode: WORKERS >= TRENCH_TABS.length ? 'dedicated' : 'shared',
  };
}

/**
 * Dedicated worker for a single tab. Fetches that tab's params combo in
 * round-robin, tracking response time and adapting the sleep to stay within
 * the rate limit without wasting time.
 */
async function tabWorker(tab, connection, rebuildQueue, delay, onError) {
  let cursor = 0;

  while (true) {
    const queue = rebuildQueue().filter((item) => item.tab === tab);
    if (!queue.length) { await delay(1000); continue; }

    const item = queue[cursor % queue.length];
    cursor += 1;

    const start = Date.now();
    try {
      await fetchTrenches(item.params, { ...(connection || {}), force: true });
    } catch (err) {
      onError(err);
      // If rate-limited, wait until reset time before retrying
      if (err.status === 429 && err.resetAtUnix) {
        const waitMs = Math.max(0, err.resetAtUnix * 1000 - Date.now()) + 1000;
        console.log(`[${tab}] Rate limited, waiting ${Math.round(waitMs / 1000)}s until reset`);
        await delay(waitMs);
      }
    }
    const elapsed = Date.now() - start;

    // Adaptive sleep: if the call took less than MIN_INTERVAL_MS, wait the
    // remainder. If it took longer (slow network / timeout), fire immediately.
    const sleepMs = Math.max(0, MIN_INTERVAL_MS - elapsed);
    await delay(sleepMs);
  }
}

/**
 * Shared worker when fewer distinct IPs than tabs. Round-robins across ALL
 * tabs, still adapting to response time per call.
 */
async function sharedWorker(rebuildQueue, connectionFor, delay, onError) {
  let cursor = 0;

  while (true) {
    const queue = rebuildQueue();
    if (!queue.length) { await delay(1000); continue; }

    const item = queue[cursor % queue.length];
    cursor += 1;

    const connection = connectionFor(item.tab);
    const start = Date.now();
    try {
      await fetchTrenches(item.params, { ...(connection || {}), force: true });
    } catch (err) {
      onError(err);
      // If rate-limited, wait until reset time before retrying
      if (err.status === 429 && err.resetAtUnix) {
        const waitMs = Math.max(0, err.resetAtUnix * 1000 - Date.now()) + 1000;
        console.log(`[shared] Rate limited on ${item.tab}, waiting ${Math.round(waitMs / 1000)}s until reset`);
        await delay(waitMs);
      }
    }
    const elapsed = Date.now() - start;

    const sleepMs = Math.max(0, MIN_INTERVAL_MS - elapsed);
    await delay(sleepMs);
  }
}

/** Parses TRENCHES_PINS (JSON keyed by tab) into { tab: { proxy, apiKey } }. */
function parsePins() {
  const raw = process.env.TRENCHES_PINS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    const out = {};
    for (const tab of TRENCH_TABS) {
      const c = parsed?.[tab];
      if (!c || typeof c !== 'object') continue;
      const proxy = String(c.proxy ?? c.url ?? '').trim();
      if (!proxy) continue;
      const apiKey = String(c.apiKey ?? c.key ?? '').trim() || process.env.GMGN_API_KEY || '';
      if (apiKey) out[tab] = { proxy, apiKey };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Resolves the connection (proxy + apiKey) a trenches tab should use.
 * Order: explicit TRENCHES_PINS entry → positional TRENCHES_PROXIES/KEYS list
 * → null (meaning direct HTTPS with GMGN_API_KEY / gmgn-cli from the server IP).
 */
export function connectionForTab(tab, pins = parsePins(), positionalProxies = [], positionalKeys = []) {
  if (pins[tab]) return pins[tab];
  if (positionalProxies.length) {
    const idx = TRENCH_TABS.indexOf(tab);
    const proxy = idx >= 0 ? positionalProxies[idx % positionalProxies.length] : positionalProxies[0];
    const apiKey = positionalKeys.length
      ? positionalKeys[idx % positionalKeys.length]
      : process.env.GMGN_API_KEY;
    return { proxy, apiKey };
  }
  return null;
}

/**
 * Resolves the real egress IP of each proxy (via a raw CONNECT tunnel — the
 * only method these proxies route correctly) and de-duplicates, so a pool is
 * only sized by genuinely independent IPs. Returns one entry per distinct IP.
 */
async function resolveDistinctProxies(urls) {
  const results = await Promise.allSettled(
    urls.map(async (url) => ({ url, ip: await proxyEgressIp(url) }))
  );
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const entry = r.status === 'fulfilled' ? r.value : { url: '', ip: null };
    if (!entry.ip || seen.has(entry.ip)) continue;
    seen.add(entry.ip);
    out.push(entry);
  }
  return out;
}