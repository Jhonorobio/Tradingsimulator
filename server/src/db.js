import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'trading.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS wallets (
    device_id      TEXT PRIMARY KEY,
    name           TEXT,
    balance_usdc   REAL NOT NULL DEFAULT 10000,
    gas_per_trade  REAL NOT NULL DEFAULT 0.25,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS positions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id     TEXT NOT NULL,
    token_address TEXT NOT NULL,
    chain         TEXT NOT NULL DEFAULT 'sol',
    symbol        TEXT,
    name          TEXT,
    logo          TEXT,
    quantity      REAL NOT NULL,
    avg_price_usdc REAL NOT NULL,
    cost_usdc     REAL NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (device_id, token_address)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id     TEXT NOT NULL,
    side          TEXT NOT NULL CHECK (side IN ('buy','sell')),
    token_address TEXT NOT NULL,
    chain         TEXT NOT NULL DEFAULT 'sol',
    symbol        TEXT,
    name          TEXT,
    logo          TEXT,
    quantity      REAL NOT NULL,
    price_usdc    REAL NOT NULL,
    total_usdc    REAL NOT NULL,
    gas_usdc      REAL NOT NULL,
    cost_usdc     REAL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id      TEXT NOT NULL,
    push_token     TEXT NOT NULL,
    enabled        INTEGER NOT NULL DEFAULT 1,
    chain          TEXT NOT NULL DEFAULT 'sol',
    types          TEXT NOT NULL DEFAULT '["new_creation"]',
    filter_preset  TEXT,
    min_smart_degen INTEGER,
    min_volume_24h REAL,
    max_rug_ratio  REAL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notified_tokens (
    subscription_id INTEGER NOT NULL,
    token_address   TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (subscription_id, token_address)
  );
`);