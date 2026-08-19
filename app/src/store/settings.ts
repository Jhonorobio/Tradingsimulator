import { create } from 'zustand';
import { getDeviceId, getServerUrl, setServerUrl } from '@/api/client';

interface SettingsState {
  ready: boolean;
  deviceId: string;
  serverUrl: string;
  pushToken: string | null;
  load: () => Promise<void>;
  setUrl: (url: string) => Promise<void>;
  setPushToken: (token: string | null) => void;
}

export const useSettings = create<SettingsState>((set) => ({
  ready: false,
  deviceId: '',
  serverUrl: 'http://localhost:4000',
  pushToken: null,
  load: async () => {
    const [deviceId, serverUrl] = await Promise.all([getDeviceId(), getServerUrl()]);
    set({ deviceId, serverUrl, ready: true });
  },
  setUrl: async (url) => {
    await setServerUrl(url);
    set({ serverUrl: url.replace(/\/+$/, '') });
  },
  setPushToken: (pushToken) => set({ pushToken }),
}));