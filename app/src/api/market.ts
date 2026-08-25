import { api } from './client';
import type { GmgnStatus, ProxyConfig, ProxyStatus, ProxyTestResult, TokenDetail, TrenchesResponse } from './types';

/** The server owns the GMGN filter config; the app only asks for a tab. */
export function getTrenches(tab: string) {
  return api.get<TrenchesResponse>(`/api/market/trenches?tab=${encodeURIComponent(tab)}`);
}

export function getSavedTrenchesFilters() {
  return api.get<{ filters: unknown }>('/api/market/trenches/filters');
}

export function saveTrenchesFilters(filters: unknown) {
  return api.put<{ ok: boolean }>('/api/market/trenches/filters', { filters });
}

export function getTokenDetail(chain: string, address: string) {
  return api.get<TokenDetail>(`/api/market/token/${chain}/${address}`);
}

export function getLiveTokenPrice(chain: string, address: string) {
  return api.get<{
    price: number | null;
    marketCap: number | null;
    supply: number | null;
    liquidity: number | null;
    priceChange24h: number | null;
  }>(`/api/market/token/${chain}/${address}/live`);
}

export function getTokenMarketCap(chain: string, address: string) {
  return api.get<{ marketCap: number | null; source: 'gmgn' | 'dexscreener' }>(
    `/api/market/token/${chain}/${address}/mcap`
  );
}

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export function getSolPrice() {
  return api.get<{ sol_price: number | null; source: string | null }>('/api/market/sol-price');
}

export function getPrices(addresses: string[] = []) {
  const qs = new URLSearchParams({ addresses: addresses.join(',') });
  return api.get<{ prices: Record<string, number | null> }>(`/api/market/prices?${qs.toString()}`);
}

export function getGmgnStatus() {
  return api.get<GmgnStatus>('/api/market/status');
}

export function searchToken(query: string, chain?: string) {
  const qs = new URLSearchParams({ query });
  if (chain) qs.set('chain', chain);
  return api.get<{ coins: any[]; wallets: any[] }>(`/api/market/search?${qs.toString()}`);
}

export function getProxies() {
  return api.get<Record<string, ProxyConfig>>('/api/market/proxies');
}

export function saveProxy(tab: string, url: string, apiKey: string) {
  return api.put<{ ok: boolean }>('/api/market/proxies', { tab, url, apiKey });
}

export function testProxy(url: string, apiKey: string) {
  return api.post<ProxyTestResult>('/api/market/proxies/test', { url, apiKey });
}

export interface BatchTestResult {
  proxy: string;
  ok: boolean;
  egressIp: string | null;
  latencyMs: number;
  error?: string;
}

/** Streams GMGN test results via NDJSON — onLine fires per proxy tested. */
export function batchTestProxiesStream(
  proxies: string[],
  apiKey: string,
  onLine: (result: BatchTestResult) => void,
) {
  return api.postStream('/api/market/proxies/batch-test', { proxies, apiKey }, onLine);
}

export interface LatencyTestResult {
  proxy: string;
  ok: boolean;
  latencyMs: number;
  httpStatus: number | null;
  error?: string;
}

export function latencyTestProxies(proxies: string[]) {
  return api.post<{ results: LatencyTestResult[] }>('/api/market/proxies/latency-test', { proxies });
}

export interface TcpTestResult {
  proxy: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export function tcpTestProxies(proxies: string[]) {
  return api.post<{ results: TcpTestResult[] }>('/api/market/proxies/tcp-test', { proxies });
}

export function getProxiesStatus() {
  return api.get<{ statuses: ProxyStatus[] }>('/api/market/proxies/status');
}