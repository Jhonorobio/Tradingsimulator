// Shared API types mirroring the server responses.

export interface Wallet {
  device_id: string;
  name: string | null;
  balance_usd: number;
  balance_sol: number;
  gas_per_trade_sol: number;
  created_at: string;
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
  bundler_rate?: number;
  bundler_trader_amount_rate?: number;
  fresh_wallet_rate?: number;
  bot_degen_rate?: number;
  bot_degen_count?: number;
  insider_ratio?: number;
  entrapment_ratio?: number;
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
  fetched_at: string;
}

export interface NotificationFilterRange {
  min?: number | string;
  max?: number | string;
}

export type NotificationFilterFields = 'smart_degen_count' | 'renowned_count' | 'bot_degen_count' | 'bot_degen_rate' | 'fresh_wallet_rate' | 'rug_ratio' | 'bundler_trader_amount_rate' | 'entrapment_ratio' | 'volume_24h' | 'usd_market_cap';

export type NotificationCategoryFilters = Partial<Record<NotificationFilterFields, NotificationFilterRange>>;

export interface TrackerTweetFlags {
  new_creation: boolean;
  completed: boolean;
  photon_new: boolean;
  photon_graduated: boolean;
}

export interface NotificationConfig {
  push_token: string | null;
  categories: {
    new_creation: boolean;
    completed: boolean;
    x_tracker: boolean;
    photon_new: boolean;
    photon_graduated: boolean;
  };
  filters?: Record<string, NotificationCategoryFilters>;
  /** Per-category toggles for tracked-token tweet notifications. */
  tracker_tweets?: {
    /** Tweets from the followed accounts (@AutorunAlert, @bitecong). */
    watchlist: TrackerTweetFlags;
    /** Every other tweet about a tracked token. */
    others: TrackerTweetFlags;
  };
  /** Push once per token while 24h volume ≈ 0.9x–2.3x of market cap. */
  vol_mcap_alerts?: boolean;
  /** Minimum market cap (USD) for that alert; null/absent = condition off. */
  vol_mcap_min_mcap?: number | null;
  /** Require ≥1 KOL holder (GMGN renowned_count) for that alert. */
  vol_mcap_kol?: boolean;
}

export interface GmgnStatus {
  ok: boolean;
  message: string;
}

export interface NotificationHistoryItem {
  id: number;
  device_id: string;
  address: string;
  chain: string;
  symbol: string | null;
  name: string | null;
  category: string;
  column?: 'new' | 'graduated' | null;
  mcap: number | null;
  liq: number | null;
  vol24h: number | null;
  logo: string | null;
  smart_degen_count: number | null;
  renowned_count: number | null;
  fresh_wallet_rate: number | null;
  bot_degen_count: number | null;
  bot_degen_rate: number | null;
  rug_ratio: number | null;
  bundler_rate: number | null;
  bundler_trader_amount_rate: number | null;
  entrapment_ratio: number | null;
  bundle_holders_count?: number | null;
  buys_count?: number | null;
  tp_holders_count?: number | null;
  top_holders_rate?: number | null;
  holders_count?: number | null;
  snapshots: TokenSnapshot[] | null;
  entered_at: string | null;
  notified_at: string;
  filter_matched_at: string | null;
  tweet_id?: string | null;
  tweet_author?: string | null;
  tweet_followers?: number | null;
  tweet_text?: string | null;
  tweet_url?: string | null;
  tweet_count?: number | null;
  /** Times this token's card was notified by a Tracker tweet (last 5, ascending). */
  tweet_notified_at?: string[];
}

export interface TokenSnapshot {
  t: string;
  usd_market_cap: number | null;
  market_cap: number | null;
  liquidity: number | null;
  volume_24h: number | null;
  smart_degen_count: number | null;
  renowned_count: number | null;
  fresh_wallet_rate: number | null;
  bot_degen_count: number | null;
  bot_degen_rate: number | null;
  bundler_rate: number | null;
  bundler_trader_amount_rate: number | null;
  entrapment_ratio: number | null;
  bundle_holders_count?: number | null;
  buys_count?: number | null;
  tp_holders_count?: number | null;
  top_holders_rate?: number | null;
  holders_count?: number | null;
}

export interface ProxyConfig {
  url: string;
  apiKey: string;
  enabled?: boolean;
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