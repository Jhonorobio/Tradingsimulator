import { create } from 'zustand';
import { getDeviceId, getServerUrl, setServerUrl } from '@/api/client';
import { getProxiesStatus } from '@/api/market';
import type { ProxyStatus } from '@/api/types';

interface SettingsState {
  ready: boolean;
  deviceId: string;
  serverUrl: string;
  pushToken: string | null;
  proxyStatuses: ProxyStatus[];
  load: () => Promise<void>;
  setUrl: (url: string) => Promise<void>;
  setPushToken: (token: string | null) => void;
  loadProxyStatuses: () => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  ready: false,
  deviceId: '',
  serverUrl: 'http://localhost:4000',
  pushToken: null,
  proxyStatuses: [],
  load: async () => {
    const [deviceId, serverUrl] = await Promise.all([getDeviceId(), getServerUrl()]);
    set({ deviceId, serverUrl, ready: true });
  },
  setUrl: async (url) => {
    await setServerUrl(url);
    set({ serverUrl: url.replace(/\/+$/, '') });
  },
  setPushToken: (pushToken) => set({ pushToken }),
  loadProxyStatuses: async () => {
    try {
      const res = await getProxiesStatus();
      set({ proxyStatuses: res.statuses });
    } catch {
      // server may be unreachable; keep previous statuses
    }
  },
}));