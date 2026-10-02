import { create } from 'zustand';
import { getWsClient, onWsConnectionChange } from '@/api/ws-client';
import type { NotificationHistoryItem, TrenchesItem } from '@/api/types';

interface WsState {
  connected: boolean;
  trenches: Record<string, TrenchesItem[]>;
  notifications: NotificationHistoryItem[];
  subscribeTrenches: (tab: string) => void;
  unsubscribeTrenches: (tab: string) => void;
  setTrenchesFilters: (filters: unknown) => void;
  subscribeNotifications: (deviceId: string) => void;
  unsubscribeNotifications: (deviceId: string) => void;
}

const client = getWsClient();
const trenchesCleanups = new Map<string, () => void>();
const notificationCleanups = new Map<string, () => void>();

export const useWs = create<WsState>((set) => ({
  connected: false,
  trenches: { new_creation: [], completed: [] },
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

  subscribeNotifications: (deviceId: string) => {
    // Global subscription (called once from the root layout): drop any
    // previous device listener first, then keep this one for the whole
    // session — the client re-sends it automatically on every reconnect.
    for (const [key, fn] of notificationCleanups) {
      fn();
      notificationCleanups.delete(key);
      client.unsubscribe(`notifications:${key}`);
    }
    const topic = `notifications:${deviceId}`;
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
