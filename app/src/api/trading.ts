import { api } from './client';
import type { Order, PortfolioResponse, TradeResult, Wallet } from './types';

export function getWallet() {
  return api.get<{ wallet: Wallet; sol_price: number }>('/api/wallet');
}

export function getPortfolio() {
  return api.get<PortfolioResponse>('/api/portfolio');
}

export function getOrders(limit = 100) {
  return api.get<{ orders: Order[] }>(`/api/orders?limit=${limit}`);
}

export function resetWallet(budget: number, gasSol?: number) {
  return api.post<{ wallet: Wallet; sol_price: number }>('/api/wallet/reset', { budget, gas_sol: gasSol });
}

export function convertWallet(direction: 'usd_to_sol' | 'sol_to_usd', amount: number) {
  return api.post<{ wallet: Wallet; sol_price: number }>('/api/wallet/convert', { direction, amount });
}

export function buy(tokenAddress: string, usd: number, chain = 'sol', gasSol?: number) {
  return api.post<TradeResult>('/api/trade/buy', { token_address: tokenAddress, usd, chain, gas_sol: gasSol });
}

export function sell(tokenAddress: string, chain = 'sol', quantity?: number, gasSol?: number) {
  return api.post<TradeResult>('/api/trade/sell', {
    token_address: tokenAddress,
    chain,
    quantity: quantity ?? undefined,
    gas_sol: gasSol,
  });
}