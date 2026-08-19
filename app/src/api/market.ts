import { api } from './client';
import type { GmgnStatus, TokenDetail, TrenchesResponse } from './types';

export interface TrenchesParams {
  chain?: string;
  types?: string[];
  filterPreset?: 'safe' | 'smart-money' | 'strict' | '';
  sortBy?: string;
  direction?: 'asc' | 'desc';
  limit?: number;
  minVolume24h?: number;
  maxVolume24h?: number;
  minNetBuy24h?: number;
  maxNetBuy24h?: number;
  minSwaps24h?: number;
  maxSwaps24h?: number;
  minBuys24h?: number;
  maxBuys24h?: number;
  minSells24h?: number;
  maxSells24h?: number;
  minVisitingCount?: number;
  maxVisitingCount?: number;
  minProgress?: number;
  maxProgress?: number;
  minMarketcap?: number;
  maxMarketcap?: number;
  minLiquidity?: number;
  maxLiquidity?: number;
  minCreated?: string;
  maxCreated?: string;
  minHolderCount?: number;
  maxHolderCount?: number;
  minTopHolderRate?: number;
  maxTopHolderRate?: number;
  minRugRatio?: number;
  maxRugRatio?: number;
  minBundlerRate?: number;
  maxBundlerRate?: number;
  minInsiderRatio?: number;
  maxInsiderRatio?: number;
  minEntrapmentRatio?: number;
  maxEntrapmentRatio?: number;
  minPrivateVaultHoldRate?: number;
  maxPrivateVaultHoldRate?: number;
  minTop70SniperHoldRate?: number;
  maxTop70SniperHoldRate?: number;
  minBotCount?: number;
  maxBotCount?: number;
  minBotDegenRate?: number;
  maxBotDegenRate?: number;
  minFreshWalletRate?: number;
  maxFreshWalletRate?: number;
  minTotalFee?: number;
  maxTotalFee?: number;
  minSmartDegen?: number;
  maxSmartDegen?: number;
  minRenowned?: number;
  maxRenowned?: number;
  minCreatorBalanceRate?: number;
  maxCreatorBalanceRate?: number;
  minCreatorCreatedCount?: number;
  maxCreatorCreatedCount?: number;
  minCreatorCreatedOpenCount?: number;
  maxCreatorCreatedOpenCount?: number;
  minCreatorCreatedOpenRatio?: number;
  maxCreatorCreatedOpenRatio?: number;
  minXFollowers?: number;
  maxXFollowers?: number;
  minTwitterRenameCount?: number;
  maxTwitterRenameCount?: number;
  minTgCallCount?: number;
  maxTgCallCount?: number;
}

export function getTrenches(params: TrenchesParams) {
  const qs = new URLSearchParams();
  if (params.chain) qs.set('chain', params.chain);
  if (params.types?.length) for (const t of params.types) qs.append('types', t);
  if (params.filterPreset) qs.set('filterPreset', params.filterPreset);
  if (params.sortBy) qs.set('sortBy', params.sortBy);
  if (params.direction) qs.set('direction', params.direction);
  if (params.limit) qs.set('limit', String(params.limit));
  (Object.keys(params) as (keyof TrenchesParams)[]).forEach((k) => {
    if (!['chain', 'types', 'filterPreset', 'sortBy', 'direction', 'limit'].includes(k)) {
      const v = params[k];
      if (v != null && v !== '') qs.set(k, String(v));
    }
  });
  return api.get<TrenchesResponse>(`/api/market/trenches?${qs.toString()}`);
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