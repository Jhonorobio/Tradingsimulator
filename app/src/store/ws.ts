import { create } from 'zustand';
import { getWsClient, onWsConnectionChange } from '@/api/ws-client';
import type { TrenchesItem } from '@/api/types';

interface WsState {
  connected: boolean;
  trenches: Record<string, TrenchesItem[]>;
  tokenPrices: Record<string, any>;
  solPrice: number | null;
  subscribeTrenches: (tab: string) => void;
  unsubscribeTrenches: (tab: string) => void;
  subscribeTokenPrice: (chain: string, address: string) => void;
  unsubscribeTokenPrice: (chain: string, address: string) => void;
  subscribeSolPrice: () => void;
  unsubscribeSolPrice: () => void;
}

const client = getWsClient();
const activeTrenchesSubs = new Set<string>();
const activeTokenSubs = new Set<string>();
let solPriceSubscribed = false;

export const useWs = create<WsState>((set, get) => ({
  connected: false,
  trenches: { new_creation: [], near_completion: [], completed: [] },
  tokenPrices: {},
  solPrice: null,

  subscribeTrenches: (tab: string) => {
    const topic = `trenches:${tab}`;
    if (activeTrenchesSubs.has(tab)) return;
    activeTrenchesSubs.add(tab);
    client.subscribe(topic);
    client.on('trenches', (msg: any) => {
      if (msg.tab === tab) {
        set((state) => ({
          trenches: { ...state.trenches, [tab]: msg.data ?? [] },
        }));
      }
    });
  },

  unsubscribeTrenches: (tab: string) => {
    activeTrenchesSubs.delete(tab);
    client.unsubscribe(`trenches:${tab}`);
  },

  subscribeTokenPrice: (chain: string, address: string) => {
    const key = `${chain}:${address}`;
    const topic = `token:${key}`;
    if (activeTokenSubs.has(key)) return;
    activeTokenSubs.add(key);
    client.subscribe(topic);
    client.on('token_price', (msg: any) => {
      if (msg.chain === chain && msg.address === address) {
        set((state) => ({
          tokenPrices: { ...state.tokenPrices, [key]: msg.data },
        }));
      }
    });
  },

  unsubscribeTokenPrice: (chain: string, address: string) => {
    const key = `${chain}:${address}`;
    activeTokenSubs.delete(key);
    client.unsubscribe(`token:${key}`);
  },

  subscribeSolPrice: () => {
    if (solPriceSubscribed) return;
    solPriceSubscribed = true;
    client.subscribe('sol_price');
    client.on('sol_price', (msg: any) => {
      set({ solPrice: msg.data?.price ?? null });
    });
  },

  unsubscribeSolPrice: () => {
    solPriceSubscribed = false;
    client.unsubscribe('sol_price');
  },
}));

// Track connection state
onWsConnectionChange((isConnected) => {
  useWs.setState({ connected: isConnected });
});
