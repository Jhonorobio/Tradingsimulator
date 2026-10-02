import { api } from './client';
import type { Wallet } from './types';

export function getWallet() {
  return api.get<{ wallet: Wallet }>('/api/wallet');
}

