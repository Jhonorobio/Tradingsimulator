import { wallets } from '../stores.js';

const DEFAULT_BUDGET_USD = 10000;
const DEFAULT_GAS_SOL = 0.001;

function ensureWallet(deviceId) {
  let wallet = wallets.get(deviceId);
  if (!wallet) {
    wallet = {
      device_id: deviceId,
      name: null,
      balance_usd: DEFAULT_BUDGET_USD,
      balance_sol: 0,
      gas_per_trade_sol: DEFAULT_GAS_SOL,
      created_at: new Date().toISOString(),
    };
    wallets.set(deviceId, wallet);
  }
  return wallet;
}

export function getWallet(deviceId) {
  return ensureWallet(deviceId);
}
