import { fetchTrenches } from '../cli/args.js';
import { trenchesFilters, proxyConfigs } from '../stores.js';
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
  const connectionFor = (tab) => connectionForTab(tab);
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const rebuildQueue = () => {
    const all = trenchesFilters.getAll();
    const configs = Object.values(all).map((entry) => entry?.filters ?? null).filter(Boolean);
    const seen = new Set();
    const queue = [];
    for (const config of configs) {
      for (const tab of TRENCH_TABS) {
        // Skip tabs without a configured proxy
        if (!connectionFor(tab)) continue;
        const params = buildParamsFromConfig(config, tab);
        const key = JSON.stringify({ t: tab, p: params });
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push({ tab, params });
      }
    }
    return queue;
  };

  // Resolve distinct proxy IPs from the store
  const allProxyUrls = [];
  for (const tab of TRENCH_TABS) {
    const conn = connectionFor(tab);
    if (conn?.proxy) allProxyUrls.push(conn.proxy);
  }
  const uniqueUrls = [...new Set(allProxyUrls)];
  const distinct = uniqueUrls.length ? await resolveDistinctProxies(uniqueUrls) : [];
  const WORKERS = Math.max(distinct.length, 1);

  // Each proxy has its own API key → independent rate limit buckets.
  // Always run dedicated workers per tab (one request per tab every ~1s).
  for (const tab of TRENCH_TABS) {
    const connection = connectionFor(tab);
    if (!connection) continue;
    setTimeout(() => tabWorker(tab, connection, rebuildQueue, delay, onError), 0);
  }

  return {
    workers: WORKERS,
    egressIps: distinct.map((d) => d.ip),
    pinnedTabs: TRENCH_TABS.filter((tab) => connectionFor(tab)?.proxy),
    skippedTabs: TRENCH_TABS.filter((tab) => !connectionFor(tab)?.proxy),
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
    if (!connection) {
      // No proxy configured for this tab — skip it
      await delay(MIN_INTERVAL_MS);
      continue;
    }
    const start = Date.now();
    try {
      await fetchTrenches(item.params, { ...connection, force: true });
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

/**
 * Resolves the connection (proxy + apiKey) a trenches tab should use.
 * Reads exclusively from the proxyConfigs store (configured from the app).
 * Returns null when no proxy is configured for the tab.
 */
export function connectionForTab(tab) {
  const stored = proxyConfigs.get(tab);
  if (stored?.url && stored?.apiKey) return { proxy: stored.url, apiKey: stored.apiKey };
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