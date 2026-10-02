import { api } from './client';
import type { Wallet } from './types';

export function getWallet() {
  return api.get<{ wallet: Wallet; sol_price: number }>('/api/wallet');
}

export function resetWallet(budget: number, gasSol?: number) {
  return api.post<{ wallet: Wallet; sol_price: number }>('/api/wallet/reset', { budget, gas_sol: gasSol });
}

export function convertWallet(direction: 'usd_to_sol' | 'sol_to_usd', amount: number) {
  return api.post<{ wallet: Wallet; sol_price: number }>('/api/wallet/convert', { direction, amount });
}
