import { create } from 'zustand';
import { getWsClient, onWsConnectionChange } from '@/api/ws-client';
import type { NotificationHistoryItem, TrenchesItem } from '@/api/types';
import type { MentionItem } from '@/api/market';

interface WsState {
  connected: boolean;
  serverFilters: unknown | null;
  trenches: Record<string, TrenchesItem[]>;
  tokenPrices: Record<string, any>;
  tokenMcaps: Record<string, any>;
  tokenCielos: Record<string, any>;
  tokenTweets: Record<string, MentionItem[]>;
  tokenTweetRemovals: Record<string, string[]>;
  solPrice: number | null;
  notifications: NotificationHistoryItem[];
  subscribeTrenches: (tab: string) => void;
  unsubscribeTrenches: (tab: string) => void;
  setTrenchesFilters: (filters: unknown) => void;
  subscribeTokenPrice: (chain: string, address: string) => void;
  unsubscribeTokenPrice: (chain: string, address: string) => void;
  subscribeTokenMcap: (address: string) => void;
  unsubscribeTokenMcap: (address: string) => void;
  subscribeTokenCielo: (address: string) => void;
  unsubscribeTokenCielo: (address: string) => void;
  subscribeTokenTweets: (address: string) => void;
  unsubscribeTokenTweets: (address: string) => void;
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
  serverFilters: null,
  trenches: { new_creation: [], completed: [] },
  tokenPrices: {},
  tokenMcaps: {},
  tokenCielos: {},
  tokenTweets: {},
  tokenTweetRemovals: {},
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

  subscribeTokenMcap: (address: string) => {
    const topic = `token_mcap:${address}`;
    client.subscribe(topic);
    const unsub = client.on(topic, (msg: any) => {
      if (msg.address === address) {
        set((state) => ({
          tokenMcaps: { ...state.tokenMcaps, [address]: msg.data },
        }));
      }
    });
    tokenCleanups.set(`mcap:${address}`, unsub);
  },

  unsubscribeTokenMcap: (address: string) => {
    const key = `mcap:${address}`;
    const unsub = tokenCleanups.get(key);
    if (unsub) { unsub(); tokenCleanups.delete(key); }
    client.unsubscribe(`token_mcap:${address}`);
  },

  subscribeTokenCielo: (address: string) => {
    const topic = `token_cielo:${address}`;
    client.subscribe(topic);
    const unsub = client.on(topic, (msg: any) => {
      if (msg.address === address) {
        set((state) => ({
          tokenCielos: { ...state.tokenCielos, [address]: msg.data },
        }));
      }
    });
    tokenCleanups.set(`cielo:${address}`, unsub);
  },

  unsubscribeTokenCielo: (address: string) => {
    const key = `cielo:${address}`;
    const unsub = tokenCleanups.get(key);
    if (unsub) { unsub(); tokenCleanups.delete(key); }
    client.unsubscribe(`token_cielo:${address}`);
  },

  subscribeTokenTweets: (address: string) => {
    const topic = `token_tweets:${address}`;
    const key = `tweets:${address}`;
    const prev = tokenCleanups.get(key);
    if (prev) { prev(); tokenCleanups.delete(key); }
    client.subscribe(topic);
    const unsub = client.on(topic, (msg: any) => {
      if (msg.address !== address) return;
      set((state) => {
        const cur = state.tokenTweets[address] || [];
        const removals = state.tokenTweetRemovals[address] || [];
        if (msg.type === 'snapshot') {
          const items: MentionItem[] = Array.isArray(msg.data) ? msg.data : [];
          return { tokenTweets: { ...state.tokenTweets, [address]: items } };
        }
        if (msg.type === 'tweet_delete') {
          const id = String(msg.data?.tweet_id ?? '');
          if (!id) return {};
          return {
            tokenTweets: {
              ...state.tokenTweets,
              [address]: cur.filter((t) => String(t.tweet_id ?? '') !== id),
            },
            tokenTweetRemovals: {
              ...state.tokenTweetRemovals,
              [address]: [...removals, id].slice(-50),
            },
          };
        }
        if (msg.type === 'tweet' && msg.data?.tweet_id) {
          const id = String(msg.data.tweet_id);
          if (removals.includes(id)) return {};
          if (cur.some((t) => String(t.tweet_id ?? '') === id)) return {};
          return {
            tokenTweets: {
              ...state.tokenTweets,
              [address]: [msg.data as MentionItem, ...cur].slice(0, 40),
            },
          };
        }
        return {};
      });
    });
    tokenCleanups.set(key, unsub);
  },

  unsubscribeTokenTweets: (address: string) => {
    const key = `tweets:${address}`;
    const unsub = tokenCleanups.get(key);
    if (unsub) { unsub(); tokenCleanups.delete(key); }
    client.unsubscribe(`token_tweets:${address}`);
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
