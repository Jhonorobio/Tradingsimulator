import { getServerUrl, getDeviceId } from './client';

type MessageHandler = (data: any) => void;

interface WsClient {
  subscribe: (topic: string) => void;
  unsubscribe: (topic: string) => void;
  on: (event: string, handler: MessageHandler) => () => void;
  send: (msg: object) => void;
  disconnect: () => void;
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 10000;
const subscriptions = new Set<string>();
const listeners = new Map<string, Set<MessageHandler>>();
const connectionListeners = new Set<(connected: boolean) => void>();
let connected = false;

function getWsUrl(): string {
  // Convert http(s) → ws(s)
  // This is async in theory but getServerUrl returns a cached value
  return ''; // placeholder, resolved in connect()
}

async function buildWsUrl(): Promise<string> {
  const httpUrl = await getServerUrl();
  const wsUrl = httpUrl.replace(/^https/, 'wss').replace(/^http/, 'ws');
  return `${wsUrl}/ws`;
}

function emit(event: string, data: any) {
  const handlers = listeners.get(event);
  if (handlers) {
    for (const h of handlers) {
      try { h(data); } catch { /* ignore */ }
    }
  }
  // Also emit to wildcard '*' listeners
  const wildcardHandlers = listeners.get('*');
  if (wildcardHandlers) {
    for (const h of wildcardHandlers) {
      try { h(data); } catch { /* ignore */ }
    }
  }
}

function setConnected(val: boolean) {
  connected = val;
  for (const h of connectionListeners) {
    try { h(val); } catch { /* ignore */ }
  }
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const url = await buildWsUrl();
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    connected = true;
    reconnectAttempts = 0;
    setConnected(true);
    // Re-subscribe to all topics
    for (const topic of subscriptions) {
      ws!.send(JSON.stringify({ action: 'subscribe', topic }));
    }
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.event) emit(msg.event, msg);
    } catch { /* ignore */ }
  };

  ws.onclose = () => {
    setConnected(false);
    scheduleReconnect();
  };

  ws.onerror = () => {
    setConnected(false);
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

export function getWsClient(): WsClient {
  return {
    subscribe(topic: string) {
      subscriptions.add(topic);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'subscribe', topic }));
      }
    },
    unsubscribe(topic: string) {
      subscriptions.delete(topic);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'unsubscribe', topic }));
      }
    },
    on(event: string, handler: MessageHandler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => {
        listeners.get(event)?.delete(handler);
      };
    },
    send(msg: object) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    disconnect() {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) { ws.close(); ws = null; }
      setConnected(false);
    },
  };
}

/**
 * Connect to the WebSocket server. Call once at app startup.
 */
export function initWs() {
  connect();
}

/**
 * Check if WebSocket is connected.
 */
export function isWsConnected() {
  return connected;
}

/**
 * Listen for connection state changes.
 */
export function onWsConnectionChange(handler: (connected: boolean) => void) {
  connectionListeners.add(handler);
  return () => { connectionListeners.delete(handler); };
}
