import crypto from 'node:crypto';
import { proxyEgressIp } from './proxy-tunnel.js';
import { gmgnTimestamp } from './gmgn-clock.js';

const API_HOST = 'https://openapi.gmgn.ai';

// In-memory cache of last health check results per tab.
const statusCache = new Map();

/**
 * Tests a proxy by resolving its egress IP and making a lightweight GMGN
 * trenches request (limit=1) to verify the API key + proxy work together.
 * @param {string} proxyUrl
 * @param {string} apiKey
 * @returns {Promise<{ ok: boolean, egressIp: string|null, latencyMs: number, error?: string }>}
 */
export async function testProxy(proxyUrl, apiKey) {
  if (!proxyUrl || !apiKey) {
    return { ok: false, egressIp: null, latencyMs: 0, error: 'URL and API key are required' };
  }

  const start = Date.now();

  // 1. Resolve egress IP
  let egressIp = null;
  try {
    egressIp = await proxyEgressIp(proxyUrl, 10_000);
  } catch {
    // proxyEgressIp already returns null on failure
  }
  if (!egressIp) {
    return { ok: false, egressIp: null, latencyMs: Date.now() - start, error: 'Proxy unreachable' };
  }

  // 2. Make a real GMGN request through the proxy
  try {
    const { ProxyAgent, request } = await import('undici');
    const dispatcher = new ProxyAgent(proxyUrl, {
      connect: { timeout: 10_000, tls: { rejectUnauthorized: false } },
    });

    const timestamp = gmgnTimestamp();
    const client_id = crypto.randomUUID();
    const url = `${API_HOST}/v1/trenches?chain=sol&timestamp=${timestamp}&client_id=${client_id}`;
    const body = JSON.stringify({
      version: 'v2',
      new_creation: { limit: 1, filters: ['offchain', 'onchain'] },
    });

    const res = await request(url, {
      dispatcher,
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'gmgn-cli/1.5.2',
        'X-APIKEY': apiKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });

    const text = await res.body.text();
    let json;
    try { json = JSON.parse(text); } catch {}

    const latencyMs = Date.now() - start;

    if (res.statusCode === 200 && json?.code === 0) {
      return { ok: true, egressIp, latencyMs };
    }

    const errMsg = json?.error || json?.message || `HTTP ${res.statusCode}`;
    return { ok: false, egressIp, latencyMs, error: errMsg };
  } catch (err) {
    return { ok: false, egressIp, latencyMs: Date.now() - start, error: err.message };
  }
}

/**
 * Returns the cached status for a tab, or a default "not checked" entry.
 */
export function getTabStatus(tab) {
  return statusCache.get(tab) || { tab, url: '', egressIp: null, working: false, lastCheck: null, error: null };
}

/**
 * Returns the cached status for all tabs.
 */
export function getAllStatus() {
  const tabs = ['new_creation', 'completed', 'new_creation_robinhood', 'completed_robinhood'];
  return tabs.map((tab) => getTabStatus(tab));
}

/**
 * Updates the cached status for a tab.
 */
export function setTabStatus(tab, status) {
  statusCache.set(tab, { ...status, tab, lastCheck: new Date().toISOString() });
}

/**
 * Runs health checks on all configured proxies from proxyConfigs store.
 * @param {import('../stores.js').proxyConfigs} proxyConfigsStore
 */
export async function checkAllProxies(proxyConfigsStore) {
  const tabs = ['new_creation', 'completed', 'new_creation_robinhood', 'completed_robinhood', 'token_info'];
  const results = [];
  for (const tab of tabs) {
    const config = proxyConfigsStore.get(tab);
    if (!config?.url || !config?.apiKey) {
      setTabStatus(tab, {
        tab,
        url: config?.url || '',
        egressIp: null,
        working: false,
        error: 'Not configured',
      });
      results.push(getTabStatus(tab));
      continue;
    }
    const result = await testProxy(config.url, config.apiKey);
    setTabStatus(tab, {
      tab,
      url: config.url,
      egressIp: result.egressIp,
      working: result.ok,
      error: result.error || null,
    });
    results.push(getTabStatus(tab));
  }
  return results;
}
