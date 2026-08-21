import { wallets, positions, orders } from '../stores.js';

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

function getDevicePositions(deviceId) {
  return positions.get(deviceId) || [];
}

function saveDevicePositions(deviceId, list) {
  positions.set(deviceId, list);
}

function getDeviceOrders(deviceId) {
  return orders.get(deviceId) || [];
}

function saveDeviceOrders(deviceId, list) {
  orders.set(deviceId, list);
}

function nextOrderId(deviceId) {
  const list = getDeviceOrders(deviceId);
  return list.reduce((max, o) => Math.max(max, o.id || 0), 0) + 1;
}

/**
 * Simulated buy: spend `sol` (SOL budget, minus gas) at the given market cap.
 */
export function buy(deviceId, token, { marketCap, sol, gasSol, solPrice }) {
  const wallet = ensureWallet(deviceId);
  const gasFee = gasSol ?? wallet.gas_per_trade_sol;

  const spendSol = sol - gasFee;
  if (spendSol <= 0) throw new Error('Amount must cover the gas fee');
  if (spendSol > wallet.balance_sol) throw new Error('Insufficient SOL balance');

  const spendUsd = solPrice > 0 ? spendSol * solPrice : spendSol;
  if (!marketCap || marketCap <= 0) throw new Error('Invalid market cap');
  const quantity = spendUsd / marketCap;

  const devPositions = getDevicePositions(deviceId);
  const existingIdx = devPositions.findIndex((p) => p.token_address === token.address);

  if (existingIdx >= 0) {
    const existing = devPositions[existingIdx];
    const totalQty = existing.quantity + quantity;
    const totalCost = existing.cost_usdc + spendUsd;
    const avgEntryMc = totalQty > 0 ? totalCost / totalQty : marketCap;
    devPositions[existingIdx] = {
      ...existing,
      quantity: totalQty,
      avg_price_usdc: avgEntryMc,
      entry_market_cap: avgEntryMc,
      cost_usdc: totalCost,
      updated_at: new Date().toISOString(),
    };
  } else {
    devPositions.push({
      id: nextOrderId(deviceId),
      device_id: deviceId,
      token_address: token.address,
      chain: token.chain,
      symbol: token.symbol,
      name: token.name,
      logo: token.logo,
      quantity,
      avg_price_usdc: marketCap,
      entry_market_cap: marketCap,
      cost_usdc: spendUsd,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
  saveDevicePositions(deviceId, devPositions);

  wallet.balance_sol -= sol;
  saveWallet(deviceId, wallet);

  const orderId = nextOrderId(deviceId);
  const order = {
    id: orderId,
    device_id: deviceId,
    side: 'buy',
    token_address: token.address,
    chain: token.chain,
    symbol: token.symbol,
    name: token.name,
    logo: token.logo,
    quantity,
    price_usdc: marketCap,
    total_usdc: spendUsd,
    gas_usdc: gasFee * solPrice,
    cost_usdc: null,
    created_at: new Date().toISOString(),
  };
  const devOrders = getDeviceOrders(deviceId);
  devOrders.push(order);
  saveDeviceOrders(deviceId, devOrders);

  return {
    id: orderId,
    side: 'buy',
    token,
    quantity,
    market_cap: marketCap,
    total_usdc: spendUsd,
    gas_sol: gasFee,
    gas_usdc: gasFee * solPrice,
    balance_usd: wallet.balance_usd,
    balance_sol: wallet.balance_sol,
  };
}

/**
 * Simulated sell: sell `quantity` or all if null.
 */
export function sell(deviceId, token, { marketCap, quantity, gasSol, solPrice }) {
  const wallet = ensureWallet(deviceId);
  const devPositions = getDevicePositions(deviceId);
  const posIdx = devPositions.findIndex((p) => p.token_address === token.address);
  if (posIdx < 0 || devPositions[posIdx].quantity <= 0) throw new Error('No position to sell');

  const position = devPositions[posIdx];
  const qty = quantity == null ? position.quantity : Math.min(quantity, position.quantity);
  if (qty <= 0) throw new Error('Invalid quantity');

  const gasFee = gasSol ?? wallet.gas_per_trade_sol;
  const proceedsUsd = qty * marketCap;
  const proceedsSol = solPrice > 0 ? proceedsUsd / solPrice : proceedsUsd;
  if (proceedsSol - gasFee < 0) throw new Error('Proceeds are lower than the gas fee');

  const remaining = position.quantity - qty;
  if (remaining < 1e-12) {
    devPositions.splice(posIdx, 1);
  } else {
    devPositions[posIdx] = {
      ...position,
      quantity: remaining,
      cost_usdc: position.cost_usdc * (remaining / position.quantity),
      updated_at: new Date().toISOString(),
    };
  }
  saveDevicePositions(deviceId, devPositions);

  const newSolBalance = wallet.balance_sol + proceedsSol - gasFee;
  wallet.balance_sol = newSolBalance;
  saveWallet(deviceId, wallet);

  const costBasis = qty * position.avg_price_usdc;
  const orderId = nextOrderId(deviceId);
  const order = {
    id: orderId,
    device_id: deviceId,
    side: 'sell',
    token_address: token.address,
    chain: token.chain,
    symbol: token.symbol,
    name: token.name,
    logo: token.logo,
    quantity: qty,
    price_usdc: marketCap,
    total_usdc: proceedsUsd,
    gas_usdc: gasFee * solPrice,
    cost_usdc: costBasis,
    created_at: new Date().toISOString(),
  };
  const devOrders = getDeviceOrders(deviceId);
  devOrders.push(order);
  saveDeviceOrders(deviceId, devOrders);

  return {
    id: orderId,
    side: 'sell',
    token,
    quantity: qty,
    market_cap: marketCap,
    total_usdc: proceedsUsd,
    total_sol: proceedsSol,
    gas_sol: gasFee,
    gas_usdc: gasFee * solPrice,
    cost_usdc: costBasis,
    pnl_usdc: proceedsUsd - costBasis - gasFee * solPrice,
    balance_usd: wallet.balance_usd,
    balance_sol: newSolBalance,
    position_remaining: remaining,
  };
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

export function updateGas(deviceId, gasSol) {
  const wallet = ensureWallet(deviceId);
  wallet.gas_per_trade_sol = gasSol;
  saveWallet(deviceId, wallet);
  return wallet;
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

export function getPositions(deviceId) {
  return getDevicePositions(deviceId).sort((a, b) => (b.cost_usdc || 0) - (a.cost_usdc || 0));
}

export function getOrders(deviceId, limit = 50) {
  return getDeviceOrders(deviceId).sort((a, b) => b.id - a.id).slice(0, limit);
}

export function getStats(deviceId) {
  const allOrders = getDeviceOrders(deviceId);
  const sells = allOrders.filter((o) => o.side === 'sell');
  const buys = allOrders.filter((o) => o.side === 'buy');

  const realized = sells.reduce((sum, o) => sum + (o.total_usdc - (o.cost_usdc || 0) - o.gas_usdc), 0);
  const wins = sells.filter((o) => o.total_usdc - (o.cost_usdc || 0) - o.gas_usdc > 0).length;

  return {
    total_trades: allOrders.length,
    total_buys: buys.length,
    total_sells: sells.length,
    realized_pnl: realized,
    win_rate: sells.length ? (wins / sells.length) * 100 : 0,
    avg_win: (() => {
      const w = sells.filter((o) => o.total_usdc - (o.cost_usdc || 0) - o.gas_usdc > 0);
      return w.length ? w.reduce((s, o) => s + (o.total_usdc - (o.cost_usdc || 0) - o.gas_usdc), 0) / w.length : 0;
    })(),
    avg_loss: (() => {
      const l = sells.filter((o) => o.total_usdc - (o.cost_usdc || 0) - o.gas_usdc < 0);
      return l.length ? l.reduce((s, o) => s + (o.total_usdc - (o.cost_usdc || 0) - o.gas_usdc), 0) / l.length : 0;
    })(),
    gas_spent: buys.reduce((s, o) => s + o.gas_usdc, 0) + sells.reduce((s, o) => s + o.gas_usdc, 0),
  };
}
