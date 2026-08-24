import { WebSocketServer } from 'ws';
import { createServer } from 'http';

/**
 * WebSocket server for real-time data push to connected clients.
 *
 * Protocol:
 *   Client → Server:
 *     { action: "subscribe",   topic: "trenches:new_creation" }
 *     { action: "unsubscribe", topic: "trenches:new_creation" }
 *     { action: "ping" }
 *
 *   Server → Client:
 *     { event: "trenches",  tab: "new_creation", data: [...] }
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
  } else if (msg.action === 'unsubscribe' && typeof msg.topic === 'string') {
    client.subscriptions.delete(msg.topic);
  } else if (msg.action === 'ping') {
    client.ws.send(JSON.stringify({ event: 'pong' }));
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
