import { api } from './client';
import type { Order, PortfolioResponse, TradeResult, Wallet } from './types';

export function getWallet() {
  return api.get<{ wallet: Wallet }>('/api/wallet');
}

export function getPortfolio() {
  return api.get<PortfolioResponse>('/api/portfolio');
}

export function getOrders(limit = 100) {
  return api.get<{ orders: Order[] }>(`/api/orders?limit=${limit}`);
}

export function resetWallet(budget: number, gas?: number) {
  return api.post<{ wallet: Wallet }>('/api/wallet/reset', { budget, gas });
}

export function buy(tokenAddress: string, usdc: number, chain = 'sol', gas?: number) {
  return api.post<TradeResult>('/api/trade/buy', { token_address: tokenAddress, usdc, chain, gas });
}

export function sell(tokenAddress: string, chain = 'sol', quantity?: number, gas?: number) {
  return api.post<TradeResult>('/api/trade/sell', {
    token_address: tokenAddress,
    chain,
    quantity: quantity ?? undefined,
    gas,
  });
}