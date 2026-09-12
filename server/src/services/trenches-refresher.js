import { fetchTrenches } from '../cli/args.js';
import { trenchesFilters, proxyConfigs } from '../stores.js';
import { buildParamsFromConfig, TRENCH_TABS } from './trenches-filters.js';
import { proxyEgressIp } from './proxy-tunnel.js';

// Rate-limit: GMGN allows 1 req/s per API key with 20 weight max.
// Trenches route has weight 20 per request → max 1 req/s per key.
// Each proxy has its own key, so each worker can do 1 req/s independently.
const MIN_INTERVAL_MS = 1050;

// Set of tabs that have a running worker
const runningWorkers = new Set();

// Shared helpers
let _onError = () => {};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Rebuilds the fetch queue from the global filter config.
 * Each tab appears once with its params. Tabs without a proxy are skipped.
 */
function rebuildQueue() {
  const entry = trenchesFilters.get('global');
  const config = entry?.filters ?? null;
  const seen = new Set();
  const queue = [];
  if (config) {
    for (const tab of TRENCH_TABS) {
      if (!connectionForTab(tab)) continue;
      const params = buildParamsFromConfig(config, tab);
      const key = JSON.stringify({ t: tab, p: params });
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ tab, params });
    }
  }
  return queue;
}

/**
 * Spawn workers for all tabs that have a proxy configured and don't already
 * have a running worker. Works immediately — no need to wait for
 * startTrenchesRefresher() to finish calibration.
 */
export function ensureWorkers() {
  for (const tab of TRENCH_TABS) {
    if (runningWorkers.has(tab)) continue;
    const connection = connectionForTab(tab);
    if (!connection) continue;
    runningWorkers.add(tab);
    console.log(`[refresher] Spawning worker for ${tab}`);
    setTimeout(() => tabWorker(tab, connection), 0);
  }
}

/**
 * Background refresher for the Trenches views. Runs one dedicated worker per
 * tab (new_creation / completed). Each worker fetches that
 * tab's params on its own adaptive loop: it measures the actual GMGN response
 * time and sleeps only as long as needed to stay within the rate limit.
 *
 * Dynamically detects new tabs every 5 seconds and spawns workers for them.
 */
export async function startTrenchesRefresher(_intervalSeconds, opts = {}) {
  _onError = opts.onError || (() => {});

  // Initial spawn
  ensureWorkers();

  // Re-check for new tabs every 5 seconds
  const checkInterval = setInterval(ensureWorkers, 5000);

  // Resolve distinct proxy IPs for info
  const allProxyUrls = [];
  for (const tab of TRENCH_TABS) {
    const conn = connectionForTab(tab);
    if (conn?.proxy) allProxyUrls.push(conn.proxy);
  }
  const uniqueUrls = [...new Set(allProxyUrls)];
  const distinct = uniqueUrls.length ? await resolveDistinctProxies(uniqueUrls) : [];
  const WORKERS = Math.max(distinct.length, 1);

  return {
    workers: WORKERS,
    egressIps: distinct.map((d) => d.ip),
    pinnedTabs: TRENCH_TABS.filter((tab) => connectionForTab(tab)?.proxy),
    skippedTabs: TRENCH_TABS.filter((tab) => !connectionForTab(tab)?.proxy),
    mode: WORKERS >= TRENCH_TABS.length ? 'dedicated' : 'shared',
    stop: () => clearInterval(checkInterval),
  };
}

/**
 * Dedicated worker for a single tab. Fetches that tab's params combo in
 * round-robin, tracking response time and adapting the sleep to stay within
 * the rate limit without wasting time.
 *
 * The entire loop body is wrapped in try/catch so that any thrown error
 * (including from rebuildQueue) kills the worker gracefully, allowing the
 * 5s watchdog interval to respawn it.
 */
async function tabWorker(tab, connection) {
  let cursor = 0;
  let consecutiveErrors = 0;

  while (true) {
    try {
      const queue = rebuildQueue().filter((item) => item.tab === tab);
      if (!queue.length) { await delay(1000); continue; }

      const item = queue[cursor % queue.length];
      cursor += 1;

      const start = Date.now();
      try {
        await fetchTrenches(item.params, { ...(connection || {}), tab: item.tab, force: true });
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors++;
        _onError(err);
        // If rate-limited, wait until reset time before retrying
        if (err.status === 429 && err.resetAtUnix) {
          const waitMs = Math.max(0, err.resetAtUnix * 1000 - Date.now()) + 1000;
          console.log(`[${tab}] Rate limited, waiting ${Math.round(waitMs / 1000)}s until reset`);
          await delay(waitMs);
        } else if (consecutiveErrors % 10 === 1) {
          // Log persistent errors every 10th failure to avoid log spam
          console.log(`[${tab}] Fetch failed ${consecutiveErrors} times: ${err.message?.slice(0, 120)}`);
        }
      }
      const elapsed = Date.now() - start;

      // Adaptive sleep: if the call took less than MIN_INTERVAL_MS, wait the
      // remainder. If it took longer (slow network / timeout), fire immediately.
      const sleepMs = Math.max(0, MIN_INTERVAL_MS - elapsed);
      await delay(sleepMs);
    } catch (fatalErr) {
      // rebuildQueue or other code threw — worker is dead, log and exit
      // so the 5s watchdog can respawn it via runningWorkers check.
      runningWorkers.delete(tab);
      console.error(`[${tab}] Worker crashed (will respawn in 5s):`, fatalErr.message);
      return;
    }
  }
}

/**
 * Shared worker when fewer distinct IPs than tabs. Round-robins across ALL
 * tabs, still adapting to response time per call.
 */
async function sharedWorker() {
  let cursor = 0;

  while (true) {
    const queue = rebuildQueue();
    if (!queue.length) { await delay(1000); continue; }

    const item = queue[cursor % queue.length];
    cursor += 1;

    const connection = connectionForTab(item.tab);
    if (!connection) {
      // No proxy configured for this tab — skip it
      await delay(MIN_INTERVAL_MS);
      continue;
    }
    const start = Date.now();
    try {
      await fetchTrenches(item.params, { ...connection, tab: item.tab, force: true });
    } catch (err) {
      _onError(err);
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
  if (!stored?.apiKey) return null;
  // new_creation (sol): directo sin proxy (solo necesita API key)
  if (tab === 'new_creation') return { proxy: '', apiKey: stored.apiKey };
  //Robinhood tabs, BSC tabs + completed: requieren proxy configurado
  if (stored?.url) return { proxy: stored.url, apiKey: stored.apiKey };
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
