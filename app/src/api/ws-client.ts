import { AppState, AppStateStatus } from 'react-native';
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

// ─── Heartbeat ───
const HEARTBEAT_INTERVAL = 25_000; // 25s — must be < typical NAT timeout (30-60s)
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastPong = 0;

function startHeartbeat() {
  stopHeartbeat();
  lastPong = Date.now();
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // If no pong received in 2 heartbeat cycles, connection is dead
    if (Date.now() - lastPong > HEARTBEAT_INTERVAL * 2.5) {
      console.log('[ws] heartbeat timeout — reconnecting');
      ws.close();
      return;
    }
    ws.send(JSON.stringify({ action: 'ping' }));
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
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

function resubscribeAll() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  for (const topic of subscriptions) {
    ws.send(JSON.stringify({ action: 'subscribe', topic }));
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
    startHeartbeat();
    resubscribeAll();
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.event === 'pong') {
        lastPong = Date.now();
        return;
      }
      if (msg.event) emit(msg.event, msg);
    } catch { /* ignore */ }
  };

  ws.onclose = () => {
    stopHeartbeat();
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

// ─── AppState: reconnect when app returns to foreground ───
let appStateSub: { remove(): void } | null = null;

function handleAppStateChange(state: AppStateStatus) {
  if (state === 'active') {
    // App came to foreground — check if connection is dead
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.log('[ws] app foreground — reconnecting');
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      reconnectAttempts = 0; // reset backoff for quick reconnect
      connect();
    } else {
      // Connection exists — send a ping to verify it's alive
      lastPong = Date.now();
      ws.send(JSON.stringify({ action: 'ping' }));
    }
  }
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
      stopHeartbeat();
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
  // Listen for AppState changes to detect background→foreground transitions
  if (!appStateSub) {
    appStateSub = AppState.addEventListener('change', handleAppStateChange);
  }
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
