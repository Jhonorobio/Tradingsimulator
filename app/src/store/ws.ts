import { create } from 'zustand';
import { getWsClient, onWsConnectionChange } from '@/api/ws-client';
import type { NotificationHistoryItem, TrenchesItem } from '@/api/types';

interface WsState {
  connected: boolean;
  trenches: Record<string, TrenchesItem[]>;
  tokenPrices: Record<string, any>;
  solPrice: number | null;
  notifications: NotificationHistoryItem[];
  subscribeTrenches: (tab: string) => void;
  unsubscribeTrenches: (tab: string) => void;
  setTrenchesFilters: (filters: unknown) => void;
  subscribeTokenPrice: (chain: string, address: string) => void;
  unsubscribeTokenPrice: (chain: string, address: string) => void;
  subscribeSolPrice: () => void;
  unsubscribeSolPrice: () => void;
  subscribeNotifications: (deviceId: string) => void;
  unsubscribeNotifications: (deviceId: string) => void;
}

const client = getWsClient();
const trenchesCleanups = new Map<string, () => void>();
const tokenCleanups = new Map<string, () => void>();
const notificationCleanups = new Map<string, () => void>();
let solPriceCleanup: (() => void) | null = null;

export const useWs = create<WsState>((set, get) => ({
  connected: false,
  trenches: { new_creation: [], completed: [], new_creation_robinhood: [], completed_robinhood: [] },
  tokenPrices: {},
  solPrice: null,
  notifications: [],

  subscribeTrenches: (tab: string) => {
    const topic = `trenches:${tab}`;
    // Clean up previous listener if still registered (e.g. screen remounted)
    const prev = trenchesCleanups.get(tab);
    if (prev) { prev(); trenchesCleanups.delete(tab); }
    client.subscribe(topic);
    const unsub = client.on('trenches_updated', (msg: any) => {
      if (msg.tab !== tab) return;
      set((state) => ({
        trenches: { ...state.trenches, [tab]: msg.data ?? [] },
      }));
    });
    trenchesCleanups.set(tab, unsub);
  },

  unsubscribeTrenches: (tab: string) => {
    const unsub = trenchesCleanups.get(tab);
    if (unsub) { unsub(); trenchesCleanups.delete(tab); }
    client.unsubscribe(`trenches:${tab}`);
  },

  setTrenchesFilters: (filters: unknown) => {
    client.send({ action: 'set_trenches_filters', filters });
  },

  subscribeTokenPrice: (chain: string, address: string) => {
    const key = `${chain}:${address}`;
    const topic = `token:${key}`;
    const prev = tokenCleanups.get(key);
    if (prev) { prev(); tokenCleanups.delete(key); }
    client.subscribe(topic);
    const unsub = client.on('token_price', (msg: any) => {
      if (msg.chain === chain && msg.address === address) {
        set((state) => ({
          tokenPrices: { ...state.tokenPrices, [key]: msg.data },
        }));
      }
    });
    tokenCleanups.set(key, unsub);
  },

  unsubscribeTokenPrice: (chain: string, address: string) => {
    const key = `${chain}:${address}`;
    const unsub = tokenCleanups.get(key);
    if (unsub) { unsub(); tokenCleanups.delete(key); }
    client.unsubscribe(`token:${key}`);
  },

  subscribeSolPrice: () => {
    if (solPriceCleanup) { solPriceCleanup(); solPriceCleanup = null; }
    client.subscribe('sol_price');
    solPriceCleanup = client.on('sol_price', (msg: any) => {
      set({ solPrice: msg.data?.price ?? null });
    });
  },

  unsubscribeSolPrice: () => {
    if (solPriceCleanup) { solPriceCleanup(); solPriceCleanup = null; }
    client.unsubscribe('sol_price');
  },

  subscribeNotifications: (deviceId: string) => {
    const topic = `notifications:${deviceId}`;
    const prev = notificationCleanups.get(deviceId);
    if (prev) { prev(); notificationCleanups.delete(deviceId); }
    client.subscribe(topic);
    const unsub = client.on('notification_new', (msg: any) => {
      if (msg.data) {
        set((state) => ({
          notifications: [msg.data, ...state.notifications].slice(0, 200),
        }));
      }
    });
    notificationCleanups.set(deviceId, unsub);
  },

  unsubscribeNotifications: (deviceId: string) => {
    const unsub = notificationCleanups.get(deviceId);
    if (unsub) { unsub(); notificationCleanups.delete(deviceId); }
    client.unsubscribe(`notifications:${deviceId}`);
  },
}));

// Track connection state
onWsConnectionChange((isConnected) => {
  useWs.setState({ connected: isConnected });
});
