import { db } from '../db.js';

const rows = (stmt, ...params) => stmt.all(...params);
const get = (stmt, ...params) => stmt.get(...params);

const stmts = {
  getWallet: db.prepare('SELECT * FROM wallets WHERE device_id = ?'),
  upsertWallet: db.prepare(`
    INSERT INTO wallets (device_id, name, balance_usd, balance_sol, gas_per_trade_sol)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET name = excluded.name
  `),
  setBalances: db.prepare('UPDATE wallets SET balance_usd = ?, balance_sol = ? WHERE device_id = ?'),
  setGasSol: db.prepare('UPDATE wallets SET gas_per_trade_sol = ? WHERE device_id = ?'),
  getPosition: db.prepare('SELECT * FROM positions WHERE device_id = ? AND token_address = ?'),
  upsertPosition: db.prepare(`
    INSERT INTO positions (device_id, token_address, chain, symbol, name, logo, quantity, avg_price_usdc, entry_market_cap, cost_usdc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, token_address) DO UPDATE SET
      chain = excluded.chain,
      symbol = excluded.symbol,
      name = excluded.name,
      logo = excluded.logo,
      quantity = excluded.quantity,
      avg_price_usdc = excluded.avg_price_usdc,
      entry_market_cap = excluded.entry_market_cap,
      cost_usdc = excluded.cost_usdc,
      updated_at = datetime('now')
  `),
  removePosition: db.prepare('DELETE FROM positions WHERE device_id = ? AND token_address = ?'),
  addOrder: db.prepare(`
    INSERT INTO orders (device_id, side, token_address, chain, symbol, name, logo, quantity, price_usdc, total_usdc, gas_usdc, cost_usdc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  positions: db.prepare('SELECT * FROM positions WHERE device_id = ? ORDER BY cost_usdc DESC'),
  orders: db.prepare('SELECT * FROM orders WHERE device_id = ? ORDER BY id DESC LIMIT ?'),
  allOrders: db.prepare('SELECT * FROM orders WHERE device_id = ? ORDER BY id DESC'),
  sellOrders: db.prepare("SELECT * FROM orders WHERE device_id = ? AND side = 'sell'"),
  buyOrders: db.prepare("SELECT * FROM orders WHERE device_id = ? AND side = 'buy'"),
  countOrders: db.prepare('SELECT COUNT(*) AS n FROM orders WHERE device_id = ?'),
};

const DEFAULT_BUDGET_USD = 10000;
const DEFAULT_GAS_SOL = 0.001;

function ensureWallet(deviceId, { solPrice } = {}) {
  let wallet = get(stmts.getWallet, deviceId);
  if (!wallet) {
    const sol = solPrice > 0 ? DEFAULT_BUDGET_USD / solPrice : 0;
    stmts.upsertWallet.run(deviceId, null, 0, sol, DEFAULT_GAS_SOL);
    wallet = get(stmts.getWallet, deviceId);
  }
  return wallet;
}

/**
 * Simulated buy: spend `sol` (SOL budget, minus gas) at the given market cap.
 * `quantity` is the fraction of the token's market cap owned
 * (quantity = spendUsd / entryMarketCap); value = quantity * currentMarketCap.
 * `solPrice` is the current SOL/USD rate used to compute the USD spend.
 * Returns the order and updated position.
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

  const existing = get(stmts.getPosition, deviceId, token.address);
  const newCost = spendUsd;
  if (existing) {
    const totalQty = existing.quantity + quantity;
    const totalCost = existing.cost_usdc + newCost;
    const avgEntryMc = totalQty > 0 ? totalCost / totalQty : marketCap;
    stmts.upsertPosition.run(
      deviceId, token.address, token.chain, token.symbol, token.name, token.logo,
      totalQty, avgEntryMc, avgEntryMc, totalCost
    );
  } else {
    stmts.upsertPosition.run(
      deviceId, token.address, token.chain, token.symbol, token.name, token.logo,
      quantity, marketCap, marketCap, newCost
    );
  }

  stmts.setBalances.run(wallet.balance_usd, wallet.balance_sol - sol, deviceId);
  const info = stmts.addOrder.run(
    deviceId, 'buy', token.address, token.chain, token.symbol, token.name, token.logo,
    quantity, marketCap, spendUsd, gasFee * solPrice, null
  );

  return {
    id: info.lastInsertRowid,
    side: 'buy',
    token,
    quantity,
    market_cap: marketCap,
    total_usdc: spendUsd,
    gas_sol: gasFee,
    gas_usdc: gasFee * solPrice,
    balance_usd: wallet.balance_usd,
    balance_sol: wallet.balance_sol - sol,
  };
}

/**
 * Simulated sell: sell `quantity` (share of market cap) or all if null.
 * Proceeds land in the SOL budget. Value = quantity * currentMarketCap.
 */
export function sell(deviceId, token, { marketCap, quantity, gasSol, solPrice }) {
  const wallet = ensureWallet(deviceId);
  const position = get(stmts.getPosition, deviceId, token.address);
  if (!position || position.quantity <= 0) throw new Error('No position to sell');

  const qty = quantity == null ? position.quantity : Math.min(quantity, position.quantity);
  if (qty <= 0) throw new Error('Invalid quantity');

  const gasFee = gasSol ?? wallet.gas_per_trade_sol;
  const proceedsUsd = qty * marketCap;
  const proceedsSol = solPrice > 0 ? proceedsUsd / solPrice : proceedsUsd;
  if (proceedsSol - gasFee < 0) throw new Error('Proceeds are lower than the gas fee');

  const remaining = position.quantity - qty;
  if (remaining < 1e-12) {
    stmts.removePosition.run(deviceId, token.address);
  } else {
    stmts.upsertPosition.run(
      deviceId, token.address, position.chain, position.symbol, position.name, position.logo,
      remaining, position.avg_price_usdc, position.entry_market_cap, position.cost_usdc * (remaining / position.quantity)
    );
  }

  const newSolBalance = wallet.balance_sol + proceedsSol - gasFee;
  stmts.setBalances.run(wallet.balance_usd, newSolBalance, deviceId);
  const costBasis = qty * position.avg_price_usdc;
  const info = stmts.addOrder.run(
    deviceId, 'sell', token.address, token.chain, token.symbol, token.name, token.logo,
    qty, marketCap, proceedsUsd, gasFee * solPrice, costBasis
  );

  return {
    id: info.lastInsertRowid,
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
 * Convert between the USD budget and the SOL budget at `solPrice`.
 * direction: 'usd_to_sol' | 'sol_to_usd'.
 */
export function convert(deviceId, { direction, amount, solPrice }) {
  const wallet = ensureWallet(deviceId);
  const amt = Number(amount);
  if (!amt || amt <= 0) throw new Error('Invalid amount');
  if (!solPrice || solPrice <= 0) throw new Error('Could not resolve SOL price');

  if (direction === 'usd_to_sol') {
    if (amt > wallet.balance_usd) throw new Error('Insufficient USD balance');
    const sol = amt / solPrice;
    stmts.setBalances.run(wallet.balance_usd - amt, wallet.balance_sol + sol, deviceId);
  } else if (direction === 'sol_to_usd') {
    if (amt > wallet.balance_sol) throw new Error('Insufficient SOL balance');
    const usd = amt * solPrice;
    stmts.setBalances.run(wallet.balance_usd + usd, wallet.balance_sol - amt, deviceId);
  } else {
    throw new Error("direction must be 'usd_to_sol' or 'sol_to_usd'");
  }

  return get(stmts.getWallet, deviceId);
}

export function getWallet(deviceId, { solPrice } = {}) {
  return ensureWallet(deviceId, { solPrice });
}

export function updateGas(deviceId, gasSol) {
  const wallet = ensureWallet(deviceId);
  stmts.setGasSol.run(gasSol, deviceId);
  return get(stmts.getWallet, deviceId);
}

export function resetWallet(deviceId, { budget, gasSol, solPrice }) {
  const wallet = ensureWallet(deviceId, { solPrice });
  const budgetUsd = budget ?? DEFAULT_BUDGET_USD;
  const sol = solPrice > 0 ? budgetUsd / solPrice : 0;
  stmts.setBalances.run(0, sol, deviceId);
  if (gasSol != null) stmts.setGasSol.run(gasSol, deviceId);
  return get(stmts.getWallet, deviceId);
}

export function getPositions(deviceId) {
  return rows(stmts.positions, deviceId);
}

export function getOrders(deviceId, limit = 50) {
  return rows(stmts.orders, deviceId, limit);
}

export function getStats(deviceId) {
  const sells = rows(stmts.sellOrders, deviceId);
  const buys = rows(stmts.buyOrders, deviceId);
  const { n } = get(stmts.countOrders, deviceId) ?? { n: 0 };

  const realized = sells.reduce((sum, o) => sum + (o.total_usdc - (o.cost_usdc || 0) - o.gas_usdc), 0);
  const wins = sells.filter((o) => o.total_usdc - (o.cost_usdc || 0) - o.gas_usdc > 0).length;

  return {
    total_trades: n,
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