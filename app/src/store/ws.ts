import { create } from 'zustand';
import { getWsClient, onWsConnectionChange } from '@/api/ws-client';
import type { NotificationHistoryItem, TrenchesItem } from '@/api/types';
import type { XTrackerToken } from '@/api/market';

export interface TrackerSummary {
  active: number;
  stopped: number;
  photon: number;
  trenches: number;
}

interface WsState {
  connected: boolean;
  trenches: Record<string, TrenchesItem[]>;
  notifications: NotificationHistoryItem[];
  tracker: Record<string, XTrackerToken>;
  trackerSummary: TrackerSummary | null;
  subscribeTrenches: (tab: string) => void;
  unsubscribeTrenches: (tab: string) => void;
  setTrenchesFilters: (filters: unknown) => void;
  subscribeNotifications: (deviceId: string) => void;
  unsubscribeNotifications: (deviceId: string) => void;
  subscribeTracker: () => void;
  unsubscribeTracker: () => void;
}

const client = getWsClient();
const trenchesCleanups = new Map<string, () => void>();
const notificationCleanups = new Map<string, () => void>();
let trackerCleanup: (() => void) | null = null;

export const useWs = create<WsState>((set) => ({
  connected: false,
  trenches: { new_creation: [], completed: [] },
  notifications: [],
  tracker: {},
  trackerSummary: null,

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

  subscribeTracker: () => {
    // Global subscription (called from the TrackingPanel): one listener,
    // re-sent automatically by the client on every reconnect.
    if (trackerCleanup) return;
    client.subscribe('tracker');
    trackerCleanup = client.on('tracker', (msg: any) => {
      const data = msg.data;
      if (!data) return;
      set((state) => ({
        tracker: data.updates ? { ...state.tracker, ...data.updates } : state.tracker,
        trackerSummary: data.summary ?? state.trackerSummary,
      }));
    });
  },

  unsubscribeTracker: () => {
    if (trackerCleanup) { trackerCleanup(); trackerCleanup = null; }
    client.unsubscribe('tracker');
  },
}));

// Track connection state
onWsConnectionChange((isConnected) => {
  useWs.setState({ connected: isConnected });
});
