// Shared API types mirroring the server responses.

export interface Wallet {
  device_id: string;
  name: string | null;
  balance_usd: number;
  balance_sol: number;
  gas_per_trade_sol: number;
  created_at: string;
}

export interface Position {
  id: number;
  device_id: string;
  token_address: string;
  chain: string;
  symbol: string | null;
  name: string | null;
  logo: string | null;
  quantity: number;
  avg_price_usdc: number;
  entry_market_cap: number;
  cost_usdc: number;
  market_cap: number | null;
  value: number;
  pnl: number;
  pnl_percent: number;
}

export interface Order {
  id: number;
  side: 'buy' | 'sell';
  token_address: string;
  chain: string;
  symbol: string | null;
  name: string | null;
  logo: string | null;
  quantity: number;
  price_usdc: number;
  total_usdc: number;
  gas_usdc: number;
  cost_usdc: number | null;
  created_at: string;
}

export interface Stats {
  total_trades: number;
  total_buys: number;
  total_sells: number;
  realized_pnl: number;
  win_rate: number;
  avg_win: number;
  avg_loss: number;
  gas_spent: number;
}

export interface PortfolioSummary {
  balance_usd: number;
  balance_sol: number;
  sol_value_usd: number;
  invested: number;
  total_value: number;
  unrealized_pnl: number;
  total_equity: number;
}

export interface PortfolioResponse {
  wallet: Wallet;
  sol_price: number;
  stats: Stats;
  positions: Position[];
  summary: PortfolioSummary;
}

export interface TrenchesItem {
  address: string;
  symbol: string;
  name: string;
  logo?: string | null;
  chain?: string;
  launchpad_platform?: string;
  exchange?: string;
  progress?: number;
  usd_market_cap?: number;
  market_cap?: number;
  liquidity?: number;
  total_supply?: number;
  created_timestamp?: number;
  open_timestamp?: number;
  volume_24h?: number;
  volume_1h?: number;
  swaps_24h?: number;
  swaps_1h?: number;
  buys_24h?: number;
  sells_24h?: number;
  net_buy_24h?: number;
  holder_count?: number;
  renounced_mint?: number;
  renounced_freeze_account?: number;
  burn_status?: string;
  rug_ratio?: number;
  top_10_holder_rate?: number;
  rat_trader_amount_rate?: number;
  bundler_trader_amount_rate?: number;
  is_wash_trading?: boolean;
  sniper_count?: number;
  open_source?: string;
  owner_renounced?: string;
  is_honeypot?: string | number;
  buy_tax?: number;
  dev_team_hold_rate?: number;
  creator_token_status?: string;
  creator_balance_rate?: number;
  smart_degen_count?: number;
  renowned_count?: number;
  twitter?: string;
  telegram?: string;
  website?: string;
  has_at_least_one_social?: boolean;
  x_user_follower?: number;
  cto_flag?: number;
  dexscr_ad?: number;
  dexscr_update_link?: number;
  price?: number;
  price_change_percent?: number;
}

export interface TrenchesResponse {
  new_creation: TrenchesItem[];
  completed: TrenchesItem[];
  new_creation_robinhood: TrenchesItem[];
  completed_robinhood: TrenchesItem[];
  fetched_at: string;
}

export interface TokenDetail {
  chain: string;
  address: string;
  name: string | null;
  symbol: string | null;
  logo: string | null;
  price: number | null;
  marketCap: number | null;
  supply: number | null;
  liquidity: number;
  volume24h: number;
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  } | null;
  holders: number | null;
  dex: string | null;
  dexPairs: number;
  sources: { dex: boolean; gmgn: boolean; trenches: boolean };
}

export interface TradeResult {
  id: number;
  side: 'buy' | 'sell';
  token: { address: string; chain: string; symbol: string | null; name: string | null; logo: string | null };
  quantity: number;
  market_cap: number;
  total_usdc: number;
  gas_sol: number;
  gas_usdc: number;
  cost_usdc?: number;
  total_sol?: number;
  pnl_usdc?: number;
  balance_usd: number;
  balance_sol: number;
  price_source: string;
}

export interface NotificationConfig {
  push_token: string | null;
  categories: {
    new_creation: boolean;
    completed: boolean;
    new_creation_robinhood: boolean;
    completed_robinhood: boolean;
  };
}

export interface GmgnStatus {
  ok: boolean;
  message: string;
}

export interface ProxyConfig {
  url: string;
  apiKey: string;
}

export interface ProxyStatus {
  tab: string;
  url: string;
  egressIp: string | null;
  working: boolean;
  lastCheck: string | null;
  error: string | null;
}

export interface ProxyTestResult {
  ok: boolean;
  egressIp: string | null;
  latencyMs: number;
  error?: string;
}