import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDeviceId, getServerUrl, setServerUrl, getPersistedPushToken, setPersistedPushToken } from '@/api/client';
import { getProxiesStatus } from '@/api/market';
import type { ProxyStatus } from '@/api/types';

const COLORS_KEY = 'trading-sim/metric-color-ranges';

export type MetricColor = string;

export interface ColorRange {
  max: number | null;
  color: MetricColor;
}

export type MetricKey = 'mcap' | 'volume' | 'fresh' | 'kol' | 'smart' | 'bot' | 'rug' | 'phish';

export type ColorRanges = Record<MetricKey, ColorRange[]>;

export const COLOR_OPTIONS: { label: string; value: MetricColor }[] = [
  { label: 'Blanco', value: '#ffffff' },
  { label: 'Verde', value: '#22c55e' },
  { label: 'Rojo', value: '#ef4444' },
  { label: 'Dorado', value: '#eab308' },
  { label: 'Naranja', value: '#f97316' },
  { label: 'Azul', value: '#38bdf8' },
];

export const METRIC_LABELS: Record<MetricKey, { name: string; unit: string }> = {
  mcap: { name: 'Capitalización de Mercado', unit: 'MC' },
  volume: { name: 'Volumen', unit: 'V' },
  fresh: { name: 'Fresh Wallet', unit: 'Fresh' },
  kol: { name: 'KOL', unit: 'KOL' },
  smart: { name: 'Smart Wallet', unit: 'Smart' },
  bot: { name: 'Bot', unit: 'Bot' },
  rug: { name: 'Rug Ratio', unit: 'Rug' },
  phish: { name: 'Phishing', unit: 'Phish' },
};

export const DEFAULT_RANGES: ColorRanges = {
  mcap: [
    { max: 10000, color: '#ffffff' },
    { max: 30000, color: '#22c55e' },
    { max: 150000, color: '#38bdf8' },
    { max: null, color: '#f97316' },
  ],
  volume: [
    { max: 10000, color: '#ffffff' },
    { max: 30000, color: '#22c55e' },
    { max: 150000, color: '#38bdf8' },
    { max: null, color: '#f97316' },
  ],
  fresh: [
    { max: 10, color: '#ef4444' },
    { max: 20, color: '#ffffff' },
    { max: null, color: '#22c55e' },
  ],
  kol: [
    { max: 1, color: '#ef4444' },
    { max: 3, color: '#ffffff' },
    { max: null, color: '#22c55e' },
  ],
  smart: [
    { max: 1, color: '#ef4444' },
    { max: 5, color: '#ffffff' },
    { max: null, color: '#22c55e' },
  ],
  bot: [
    { max: 10, color: '#22c55e' },
    { max: 20, color: '#ffffff' },
    { max: null, color: '#ef4444' },
  ],
  rug: [
    { max: 10, color: '#22c55e' },
    { max: 20, color: '#ffffff' },
    { max: null, color: '#ef4444' },
  ],
  phish: [
    { max: 5, color: '#22c55e' },
    { max: 15, color: '#ffffff' },
    { max: null, color: '#ef4444' },
  ],
};

export function getColorForValue(ranges: ColorRange[], value: number | null | undefined): string {
  if (value == null || isNaN(value)) return '#ffffff';
  for (const r of ranges) {
    if (r.max === null || value <= r.max) return r.color;
  }
  return ranges[ranges.length - 1]?.color ?? '#ffffff';
}

interface SettingsState {
  ready: boolean;
  deviceId: string;
  serverUrl: string;
  pushToken: string | null;
  proxyStatuses: ProxyStatus[];
  colorRanges: ColorRanges;
  load: () => Promise<void>;
  setUrl: (url: string) => Promise<void>;
  setPushToken: (token: string | null) => void;
  loadProxyStatuses: () => Promise<void>;
  setColorRange: (metric: MetricKey, index: number, field: 'max' | 'color', value: number | null | string) => void;
  addColorRange: (metric: MetricKey) => void;
  removeColorRange: (metric: MetricKey, index: number) => void;
}

async function loadRanges(): Promise<ColorRanges> {
  try {
    const raw = await AsyncStorage.getItem(COLORS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const result: any = { ...DEFAULT_RANGES };
      for (const key of Object.keys(DEFAULT_RANGES)) {
        if (Array.isArray(parsed[key])) result[key] = parsed[key];
      }
      return result;
    }
  } catch {}
  return DEFAULT_RANGES;
}

export const useSettings = create<SettingsState>((set, get) => ({
  ready: false,
  deviceId: '',
  serverUrl: 'http://localhost:4000',
  pushToken: null,
  proxyStatuses: [],
  colorRanges: DEFAULT_RANGES,
  load: async () => {
    const [deviceId, serverUrl, persistedToken, colorRanges] = await Promise.all([
      getDeviceId(),
      getServerUrl(),
      getPersistedPushToken(),
      loadRanges(),
    ]);
    set({ deviceId, serverUrl, pushToken: persistedToken, colorRanges, ready: true });
  },
  setUrl: async (url) => {
    await setServerUrl(url);
    set({ serverUrl: url.replace(/\/+$/, '') });
  },
  setPushToken: (pushToken) => {
    set({ pushToken });
    setPersistedPushToken(pushToken).catch(() => {});
  },
  loadProxyStatuses: async () => {
    try {
      const res = await getProxiesStatus();
      set({ proxyStatuses: res.statuses });
    } catch {}
  },
  setColorRange: (metric, index, field, value) => {
    const ranges = { ...get().colorRanges };
    const list = [...ranges[metric]];
    list[index] = { ...list[index], [field]: value };
    ranges[metric] = list;
    set({ colorRanges: ranges });
    AsyncStorage.setItem(COLORS_KEY, JSON.stringify(ranges)).catch(() => {});
  },
  addColorRange: (metric) => {
    const ranges = { ...get().colorRanges };
    const list = [...ranges[metric]];
    const lastMax = list.length > 0 ? list[list.length - 1].max : 0;
    list.push({ max: lastMax ? lastMax * 3 : 10000, color: '#ffffff' });
    ranges[metric] = list;
    set({ colorRanges: ranges });
    AsyncStorage.setItem(COLORS_KEY, JSON.stringify(ranges)).catch(() => {});
  },
  removeColorRange: (metric, index) => {
    const ranges = { ...get().colorRanges };
    const list = [...ranges[metric]];
    if (list.length <= 1) return;
    list.splice(index, 1);
    ranges[metric] = list;
    set({ colorRanges: ranges });
    AsyncStorage.setItem(COLORS_KEY, JSON.stringify(ranges)).catch(() => {});
  },
}));
