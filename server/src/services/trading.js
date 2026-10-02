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

function saveWallet(deviceId, wallet) {
  wallets.set(deviceId, wallet);
}

/**
 * Convert between USD and SOL budget.
 */
export function convert(deviceId, { direction, amount, solPrice }) {
  const wallet = ensureWallet(deviceId);
  const amt = Number(amount);
  if (!amt || amt <= 0) throw new Error('Invalid amount');
  if (!solPrice || solPrice <= 0) throw new Error('Could not resolve SOL price');

  if (direction === 'usd_to_sol') {
    if (amt > wallet.balance_usd) throw new Error('Insufficient USD balance');
    wallet.balance_usd -= amt;
    wallet.balance_sol += amt / solPrice;
  } else if (direction === 'sol_to_usd') {
    if (amt > wallet.balance_sol) throw new Error('Insufficient SOL balance');
    wallet.balance_usd += amt * solPrice;
    wallet.balance_sol -= amt;
  } else {
    throw new Error("direction must be 'usd_to_sol' or 'sol_to_usd'");
  }

  saveWallet(deviceId, wallet);
  return wallet;
}

export function getWallet(deviceId, { solPrice } = {}) {
  return ensureWallet(deviceId, { solPrice });
}

export function resetWallet(deviceId, { budget, gasSol, solPrice }) {
  const wallet = ensureWallet(deviceId, { solPrice });
  const budgetUsd = budget ?? DEFAULT_BUDGET_USD;
  const sol = solPrice > 0 ? budgetUsd / solPrice : 0;
  wallet.balance_usd = 0;
  wallet.balance_sol = sol;
  if (gasSol != null) wallet.gas_per_trade_sol = gasSol;
  saveWallet(deviceId, wallet);
  return wallet;
}
