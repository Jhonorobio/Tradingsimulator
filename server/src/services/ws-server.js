import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { getCurrentData } from './trenches-store.js';
import { trenchesFilters, proxyConfigs } from '../stores.js';
import { buildParamsFromConfig, TRENCH_TABS } from './trenches-filters.js';
import { fetchTrenches } from '../cli/args.js';

/**
 * WebSocket server for real-time data push to connected clients.
 *
 * Protocol:
 *   Client → Server:
 *     { action: "subscribe",   topic: "trenches:new_creation" }
 *     { action: "unsubscribe", topic: "trenches:new_creation" }
 *     { action: "set_trenches_filters", deviceId: "...", filters: {...} }
 *     { action: "ping" }
 *
 *   Server → Client:
 *     { event: "trenches_updated", tab: "new_creation", data: [...] }
 *     { event: "token_price", chain: "sol", address: "...", data: {...} }
 *     { event: "portfolio", data: { equity, positions, ... } }
 *     { event: "sol_price", data: { price: 150.5 } }
 *     { event: "pong" }
 *
 * Topics:
 *   trenches:new_creation | trenches:near_completion | trenches:completed
 *   token:{chain}:{address}
 *   portfolio:{deviceId}
 *   sol_price
 */

let wss = null;
const clients = new Set(); // Set of { ws, subscriptions: Set<string> }

export function initWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    const client = { ws, subscriptions: new Set() };
    clients.add(client);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        handleMessage(client, msg);
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      clients.delete(client);
    });

    ws.on('error', () => {
      clients.delete(client);
    });

    // Send initial connection ack
    ws.send(JSON.stringify({ event: 'connected', clients: clients.size }));
  });

  return wss;
}

function handleMessage(client, msg) {
  if (msg.action === 'subscribe' && typeof msg.topic === 'string') {
    client.subscriptions.add(msg.topic);
    // Push current data immediately when subscribing to a trenches topic
    if (msg.topic.startsWith('trenches:')) {
      const tab = msg.topic.replace('trenches:', '');
      const data = getCurrentData(tab);
      if (data.length > 0) {
        sendTo(client, { event: 'trenches_updated', tab, data });
      }
    }
  } else if (msg.action === 'unsubscribe' && typeof msg.topic === 'string') {
    client.subscriptions.delete(msg.topic);
  } else if (msg.action === 'set_trenches_filters') {
    handleSetTrenchesFilters(client, msg);
  } else if (msg.action === 'ping') {
    client.ws.send(JSON.stringify({ event: 'pong' }));
  }
}

/**
 * Handle set_trenches_filters from a WS client.
 * Saves filters, then fetches all tabs with the new config and pushes results.
 */
async function handleSetTrenchesFilters(client, msg) {
  const deviceId = msg.deviceId;
  const rawFilters = msg.filters;
  if (!deviceId || rawFilters == null) {
    sendTo(client, { event: 'error', message: 'deviceId and filters are required' });
    return;
  }

  // Save filters to store
  trenchesFilters.set(deviceId, { filters: rawFilters, updated_at: new Date().toISOString() });

  // Fetch each tab that has a configured proxy and push results
  for (const tab of TRENCH_TABS) {
    const stored = proxyConfigs.get(tab);
    if (!stored?.url || !stored?.apiKey) continue;
    const connection = { proxy: stored.url, apiKey: stored.apiKey };
    const params = buildParamsFromConfig(rawFilters, tab);
    try {
      const result = await fetchTrenches(params, { ...connection, tab, source: 'ws', force: true });
      const tabData = result[tab] || [];
      if (tabData.length > 0) {
        sendTo(client, { event: 'trenches_updated', tab, data: tabData });
      }
    } catch (err) {
      // Tab fetch failed — skip, refresher will retry
      console.error(`[ws] set_trenches_filters fetch ${tab} failed:`, err.message);
    }
  }
}

/**
 * Send a message to a single client.
 */
export function sendTo(client, payload) {
  if (client.ws.readyState === 1) {
    client.ws.send(JSON.stringify(payload));
  }
}

/**
 * Broadcast a message to all clients subscribed to a topic.
 * @param {string} topic - The topic to broadcast on
 * @param {object} payload - The data to send (will be wrapped in { event, ...payload })
 */
export function broadcast(topic, payload) {
  if (!wss) return;
  const msg = JSON.stringify({ topic, ...payload });
  for (const client of clients) {
    if (client.subscriptions.has(topic) && client.ws.readyState === 1) {
      client.ws.send(msg);
    }
  }
}

/**
 * Get all active subscriptions across all clients.
 */
export function getSubscriptions() {
  const topics = new Set();
  for (const client of clients) {
    for (const topic of client.subscriptions) {
      topics.add(topic);
    }
  }
  return topics;
}

/**
 * Get the number of connected clients.
 */
export function clientCount() {
  return clients.size;
}

/**
 * Get subscription stats for debugging.
 */
export function subscriptionStats() {
  const topics = new Map();
  for (const client of clients) {
    for (const topic of client.subscriptions) {
      topics.set(topic, (topics.get(topic) || 0) + 1);
    }
  }
  return Object.fromEntries(topics);
}
