import { wallets } from '../stores.js';

const DEFAULT_BUDGET_USD = 10000;
const DEFAULT_GAS_SOL = 0.001;

function ensureWallet(deviceId, { solPrice } = {}) {
  let wallet = wallets.get(deviceId);
  if (!wallet) {
    const sol = solPrice > 0 ? DEFAULT_BUDGET_USD / solPrice : 0;
    wallet = {
      device_id: deviceId,
      name: null,
      balance_usd: 0,
      balance_sol: sol,
      gas_per_trade_sol: DEFAULT_GAS_SOL,
      created_at: new Date().toISOString(),
    };
    wallets.set(deviceId, wallet);
  }
  return wallet;
}

export function getWallet(deviceId, { solPrice } = {}) {
  return ensureWallet(deviceId, { solPrice });
}
