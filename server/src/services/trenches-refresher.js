import { fetchTrenches } from '../cli/args.js';
import { db } from '../db.js';
import { buildParamsFromConfig, TRENCH_TABS } from './trenches-filters.js';
import { HttpsProxyAgent } from 'https-proxy-agent';

/**
 * Background refresher for the Trenches views. Runs WORKERS parallel workers
 * that pull every category in rotation.
 *
 * Each category can be pinned to its own proxy+key with TRENCHES_PINS (JSON,
 * keyed by tab: new_creation / near_completion / completed). Pinned categories
 * are fetched DIRECTLY from the GMGN OpenAPI (https-proxy-agent + X-APIKEY —
 * the same connection method the dashboard/token detail uses). Unpinned tabs
 * fall back to the positional TRENCHES_PROXIES/TRENCHES_KEYS lists, or to
 * gmgn-cli when nothing is configured.
 *
 * At startup we resolve each proxy's real egress IP and de-duplicate: only
 * truly distinct IPs get a parallel worker. If all configured proxies share a
 * single egress IP (e.g. one corporate gateway), we safely run ONE worker so
 * the shared IP is never rate-limited, while still honoring each tab's own pin.
 */
export async function startTrenchesRefresher(intervalSeconds, { onError = () => {} } = {}) {
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

  // One worker per genuinely independent egress IP; single-IP setups collapse
  // to one safe worker.
  const WORKERS = Math.max(distinct.length, 1);
  const restMs = Math.max(0.1, (Number(intervalSeconds) || (WORKERS > 1 ? 0.5 : 2)) * 1000);

  const connectionFor = (tab) => {
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
  };

  const rebuild = () => {
    const rows = db.prepare('SELECT filters FROM trenches_filters').all();
    const configs = rows.map((r) => {
      try {
        return JSON.parse(r.filters);
      } catch {
        return null;
      }
    });
    // default (no filters saved) view is always refreshed too
    configs.push(null);

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

  let cursor = 0;
  const next = () => {
    const queue = rebuild();
    if (!queue.length) return null;
    const item = queue[cursor % queue.length];
    cursor += 1;
    return item;
  };

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const worker = async () => {
    while (true) {
      const item = next();
      if (item) {
        const connection = connectionFor(item.tab);
        try {
          await fetchTrenches(item.params, { force: true, ...(connection || {}) });
        } catch (err) {
          onError(err);
        }
      }
      await delay(restMs);
    }
  };

  for (let i = 0; i < WORKERS; i++) {
    setTimeout(() => worker(), i * 50); // slight stagger so workers cover different tabs first
  }

  return {
    workers: WORKERS,
    egressIps: distinct.map((d) => d.ip),
    restMs,
    pins: Object.keys(pins),
  };
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
 * Resolves the real egress IP of each proxy and de-duplicates, so a pool is
 * only sized by genuinely independent IPs. Returns one entry per distinct IP.
 */
async function resolveDistinctProxies(urls) {
  const agents = new Map();
  const ipOf = async (url) => {
    const agent = agents.get(url) ?? new HttpsProxyAgent(url);
    agents.set(url, agent);
    try {
      const res = await fetch('https://api64.ipify.org?format=json', {
        agent,
        signal: AbortSignal.timeout(10_000),
      });
      const json = await res.json();
      return typeof json?.ip === 'string' ? json.ip : null;
    } catch {
      return null;
    }
  };

  const results = await Promise.allSettled(urls.map(async (url) => ({ url, ip: await ipOf(url) })));
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