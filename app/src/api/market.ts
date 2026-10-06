import { api } from './client';
import type { GmgnStatus, ProxyConfig, ProxyStatus, ProxyTestResult, TrenchesResponse } from './types';

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

// ── Photon memescape: independent screener filters per column ──
export type PhotonCol = 'col1' | 'col3'; // col2 (Graduating) removed 2026-09-27
export interface PhotonRange {
  min?: string;
  max?: string;
}
/** Field key (age, holders, volume, …) → { min?, max? } — see FILTER_FIELDS in the server. */
export type PhotonColFilters = Record<string, PhotonRange>;
export type PhotonFilters = Record<PhotonCol, PhotonColFilters>;

export function getPhotonFilters() {
  return api.get<{ filters: PhotonFilters }>('/api/market/memescope-filters');
}

export function savePhotonFilters(filters: PhotonFilters) {
  return api.put<{ ok: boolean; filters: PhotonFilters }>('/api/market/memescope-filters', { filters });
}

export interface XTrackerToken {
  address: string;
  chain: string;
  symbol: string | null;
  name: string | null;
  logo: string | null;
  status: 'active' | 'stopped';
  stop_reason: string | null;
  categories: string[];
  first_seen: string;
  last_seen: string;
  stopped_at: string | null;
  mcap: number | null;
  liquidity: number | null;
  volume24h: number | null;
  checks: number;
  last_dex_check: string | null;
  age_seconds: number | null;
}

export interface XTrackerTokensResponse {
  tokens: XTrackerToken[];
  summary: {
    active: number;
    stopped: number;
    photon: number;
    trenches: number;
  };
  total: number;
}

/** Background watchlist: every token that showed up in trenches or photon. */
export function getXTrackerTokens(opts: {
  status?: 'active' | 'stopped' | 'all';
  q?: string;
  limit?: number;
} = {}) {
  const qs = new URLSearchParams();
  if (opts.status) qs.set('status', opts.status);
  if (opts.q) qs.set('q', opts.q);
  if (opts.limit) qs.set('limit', String(opts.limit));
  const suffix = qs.toString();
  return api.get<XTrackerTokensResponse>(`/api/market/xtracker/tokens${suffix ? `?${suffix}` : ''}`);
}

export interface PhotonAudit {
  mint_authority?: boolean;
  freeze_authority?: boolean;
  top_holders_perc?: number | string;
  lp_burned_perc?: number | string;
}

export interface PhotonSocials {
  twitter?: string | null;
  website?: string | null;
  telegram?: string | null;
}

/**
 * Attributes of one token in the Photon memescape screener.
 * Photon sends some numerics as strings ("0.0") — coerce at render time.
 */
export interface PhotonToken {
  address?: string;
  tokenAddress?: string;
  symbol?: string;
  name?: string;
  imgUrl?: string | null;
  fdv?: number | string | null;
  volume?: number | string | null;
  buys_count?: number | string | null;
  sells_count?: number | string | null;
  holders_count?: number | string | null;
  created_timestamp?: number | string | null;
  pooled_sol?: number | string | null;
  cur_liq?: { usd?: number | string; quote?: number | string } | null;
  snipers_count?: number | string | null;
  dev_holding_perc?: number | string | null;
  dev_sold?: boolean | null;
  ath?: number | string | null;
  fromPump?: boolean;
  platform?: number | string | null;
  audit?: PhotonAudit;
  socials?: PhotonSocials;
}

export type MemescopeColKey = 'col1' | 'col2' | 'col3';

export interface MemescopeResponse {
  columns: Record<MemescopeColKey, { data: { attributes: PhotonToken }[] }>;
  titles: Partial<Record<MemescopeColKey, string>>;
  cached?: boolean;
  ageMs?: number;
  savedAt?: number;
  error?: string | null;
}

/**
 * Photon memescape (graduated/graduating screener). The server polls upstream
 * every 1.3s (rate-limit safe) and serves from cache; the app gets pushes.
 */
export function getMemescope() {
  return api.get<MemescopeResponse>('/api/market/memescope');
}

// ── FOMO (fomo.family) graduated-tokens feed (Solana) ──

export interface FomoToken {
  address: string;
  networkId: number | null;
  symbol: string | null;
  name: string | null;
  image: string | null;
  launchpad: string | null;
  /** unix seconds */
  createdAt: number | null;
  mcap: number | null;
  price: number | null;
  vol24: number | null;
  /** FRACTION (0.25 = +25%) — FOMO's own UI renders change24 * 100. */
  change24: number | null;
  holders: number | null;
  updatedAt: number;
  /**
   * KOL holders (Trenchers Pulse → GMGN fallback). Attached by the server when
   * the kolMin filter is used; WS pushes carry it only once a record was
   * enriched.
   */
  kolCount?: number | null;
}

export interface FomoAuthStatus {
  hasRefreshToken: boolean;
  hasCachedToken: boolean;
  tokenExpiresAt: number | null;
  tokenExpiresInSeconds: number | null;
}

/** Egress for the FOMO WS — Cloudflare 432s datacenter IPs, so prod uses a proxy. */
export interface FomoProxyInfo {
  /** '' = direct connection. */
  url: string;
  enabled: boolean;
  /** Transport of the current attempt (may differ from `enabled` while falling back). */
  transport: 'proxy' | 'direct';
}

export interface FomoStatus {
  running: boolean;
  connected: boolean;
  subscribed: boolean;
  live: boolean;
  count: number;
  snapshots: number;
  authFailures: number;
  lastMsgAgeMs: number | null;
  lastError: string | null;
  proxy?: FomoProxyInfo;
  auth: FomoAuthStatus;
}

export interface FomoGraduatedResponse {
  tokens: FomoToken[];
  /** How many tokens match the filters (before `limit`). */
  total: number;
  savedAt: number;
  status: FomoStatus;
}

/** Empty string = no bound on that axis (server treats invalid values the same). */
export interface FomoFilters {
  ageMaxMin: string;
  mcapMin: string;
  mcapMax: string;
  /** Minimum KOL count (Trenchers Pulse); '' = off (no Pulse lookups). */
  kolMin: string;
}

/** WS push payload on topic `fomo` (event `fomo_updated`), batched ~1/s. */
export interface FomoPushData {
  tokens: FomoToken[];
  savedAt: number;
  /** Upstream authoritative rebuild — replace the local map instead of merging. */
  snapshot?: boolean;
}

export function getFomoGraduated(filters: FomoFilters, limit?: number) {
  const qs = new URLSearchParams();
  const age = filters.ageMaxMin?.trim();
  const lo = filters.mcapMin?.trim();
  const hi = filters.mcapMax?.trim();
  const kol = filters.kolMin?.trim();
  if (age) qs.set('ageMaxMin', age);
  if (lo) qs.set('mcapMin', lo);
  if (hi) qs.set('mcapMax', hi);
  if (kol) qs.set('kolMin', kol);
  if (limit) qs.set('limit', String(limit));
  const suffix = qs.toString();
  return api.get<FomoGraduatedResponse>(`/api/market/fomo/graduated${suffix ? `?${suffix}` : ''}`);
}

export function getFomoStatus() {
  return api.get<FomoStatus>('/api/market/fomo/status');
}

/** Persist the FOMO WS egress proxy on the server (empty = direct). Reconnects. */
export function setFomoProxy(proxy: string) {
  return api.put<{ ok: boolean; proxy: FomoProxyInfo }>('/api/market/fomo/proxy', { proxy });
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

export function saveProxy(tab: string, url: string, apiKey: string, enabled?: boolean) {
  return api.put<{ ok: boolean }>('/api/market/proxies', { tab, url, apiKey, enabled });
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