import { db } from '../db.js';

const rows = (stmt, ...params) => stmt.all(...params);
const get = (stmt, ...params) => stmt.get(...params);

const stmts = {
  getWallet: db.prepare('SELECT * FROM wallets WHERE device_id = ?'),
  upsertWallet: db.prepare(`
    INSERT INTO wallets (device_id, name, balance_usdc, gas_per_trade)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET name = excluded.name
  `),
  setBalance: db.prepare('UPDATE wallets SET balance_usdc = ? WHERE device_id = ?'),
  setGas: db.prepare('UPDATE wallets SET gas_per_trade = ? WHERE device_id = ?'),
  getPosition: db.prepare('SELECT * FROM positions WHERE device_id = ? AND token_address = ?'),
  upsertPosition: db.prepare(`
    INSERT INTO positions (device_id, token_address, chain, symbol, name, logo, quantity, avg_price_usdc, cost_usdc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, token_address) DO UPDATE SET
      chain = excluded.chain,
      symbol = excluded.symbol,
      name = excluded.name,
      logo = excluded.logo,
      quantity = excluded.quantity,
      avg_price_usdc = excluded.avg_price_usdc,
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

function ensureWallet(deviceId, { budget, gas } = {}) {
  let wallet = get(stmts.getWallet, deviceId);
  if (!wallet) {
    stmts.upsertWallet.run(deviceId, null, budget ?? 10000, gas ?? 0.25);
    wallet = get(stmts.getWallet, deviceId);
  }
  return wallet;
}

/**
 * Simulated buy: spend `usdc` (minus gas) at the given price.
 * Returns the order and updated position.
 */
export function buy(deviceId, token, { price, usdc, gas }) {
  const wallet = ensureWallet(deviceId, {});
  const gasFee = gas ?? wallet.gas_per_trade;

  const spend = usdc - gasFee;
  if (spend <= 0) throw new Error('Amount must cover the gas fee');
  if (spend > wallet.balance_usdc) throw new Error('Insufficient simulated balance');

  const quantity = price > 0 ? spend / price : 0;
  if (quantity <= 0) throw new Error('Invalid price');

  const existing = get(stmts.getPosition, deviceId, token.address);
  const newCost = spend;
  if (existing) {
    const totalQty = existing.quantity + quantity;
    const totalCost = existing.cost_usdc + newCost;
    const avgPrice = totalQty > 0 ? totalCost / totalQty : price;
    stmts.upsertPosition.run(
      deviceId, token.address, token.chain, token.symbol, token.name, token.logo,
      totalQty, avgPrice, totalCost
    );
  } else {
    stmts.upsertPosition.run(
      deviceId, token.address, token.chain, token.symbol, token.name, token.logo,
      quantity, price, newCost
    );
  }

  stmts.setBalance.run(wallet.balance_usdc - spend - gasFee, deviceId);
  const info = stmts.addOrder.run(
    deviceId, 'buy', token.address, token.chain, token.symbol, token.name, token.logo,
    quantity, price, spend, gasFee, null
  );

  return {
    id: info.lastInsertRowid,
    side: 'buy',
    token,
    quantity,
    price,
    total_usdc: spend,
    gas_usdc: gasFee,
    balance_usdc: wallet.balance_usdc - spend - gasFee,
  };
}

/**
 * Simulated sell: sell `quantity` (or all if null) of a held position.
 */
export function sell(deviceId, token, { quantity, price, gas }) {
  const wallet = ensureWallet(deviceId, {});
  const position = get(stmts.getPosition, deviceId, token.address);
  if (!position || position.quantity <= 0) throw new Error('No position to sell');

  const qty = quantity == null ? position.quantity : Math.min(quantity, position.quantity);
  if (qty <= 0) throw new Error('Invalid quantity');

  const gasFee = gas ?? wallet.gas_per_trade;
  const proceeds = qty * price;
  if (proceeds - gasFee < 0) throw new Error('Proceeds are lower than the gas fee');

  const remaining = position.quantity - qty;
  if (remaining < 1e-12) {
    stmts.removePosition.run(deviceId, token.address);
  } else {
    stmts.upsertPosition.run(
      deviceId, token.address, position.chain, position.symbol, position.name, position.logo,
      remaining, position.avg_price_usdc, position.cost_usdc * (remaining / position.quantity)
    );
  }

  const newBalance = wallet.balance_usdc + proceeds - gasFee;
  stmts.setBalance.run(newBalance, deviceId);
  const costBasis = qty * position.avg_price_usdc;
  const info = stmts.addOrder.run(
    deviceId, 'sell', token.address, token.chain, token.symbol, token.name, token.logo,
    qty, price, proceeds, gasFee, costBasis
  );

  return {
    id: info.lastInsertRowid,
    side: 'sell',
    token,
    quantity: qty,
    price,
    total_usdc: proceeds,
    gas_usdc: gasFee,
    cost_usdc: costBasis,
    pnl_usdc: proceeds - costBasis - gasFee,
    balance_usdc: newBalance,
    position_remaining: remaining,
  };
}

export function getWallet(deviceId) {
  return ensureWallet(deviceId, {});
}

export function updateGas(deviceId, gas) {
  const wallet = ensureWallet(deviceId, {});
  stmts.setGas.run(gas, deviceId);
  return get(stmts.getWallet, deviceId);
}

export function resetWallet(deviceId, { budget, gas }) {
  const wallet = ensureWallet(deviceId, {});
  stmts.setBalance.run(budget ?? 10000, deviceId);
  if (gas != null) stmts.setGas.run(gas, deviceId);
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