import { JsonStore, JsonArrayStore } from './json-store.js';

export const wallets = new JsonStore('wallets');
export const positions = new JsonStore('positions');
export const orders = new JsonStore('orders');
export const pushSubscriptions = new JsonArrayStore('push_subscriptions');
export const notifiedTokens = new JsonStore('notified_tokens');
export const notificationHistory = new JsonArrayStore('notification_history');
export const winners = new JsonArrayStore('winners');
export const trenchesFilters = new JsonStore('trenches_filters');
export const photonFilters = new JsonStore('photon_filters');
// Addresses already recorded in history from the Photon memescope feed
// (one history entry per token, like trenches/x_tracker).
export const photonSeen = new JsonStore('photon_seen');
export const proxyConfigs = new JsonStore('proxy_configs');
export const notificationConfig = new JsonStore('notification_config');
// Background X-Tracker watchlist: every token seen in trenches, kept alive even
// after it disappears from the list. Stopped when mcap < 10k, no pairs for 3
// consecutive checks or older than MAX_AGE_MS.
export const tokenWatchlist = new JsonStore('token_watchlist');
