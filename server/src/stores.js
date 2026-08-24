import { JsonStore, JsonArrayStore } from './json-store.js';

export const wallets = new JsonStore('wallets');
export const positions = new JsonStore('positions');
export const orders = new JsonStore('orders');
export const pushSubscriptions = new JsonArrayStore('push_subscriptions');
export const notifiedTokens = new JsonStore('notified_tokens');
export const trenchesFilters = new JsonStore('trenches_filters');
export const proxyConfigs = new JsonStore('proxy_configs');
export const notificationConfig = new JsonStore('notification_config');
