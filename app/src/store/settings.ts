import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDeviceId, getServerUrl, setServerUrl, getPersistedPushToken, setPersistedPushToken } from '@/api/client';
import { getProxiesStatus } from '@/api/market';
import type { ProxyStatus } from '@/api/types';

const COLORS_KEY = 'trading-sim/metric-color-ranges-v2';

export type MetricColor = string;

export interface ColorRange {
  max: number | null;
  color: MetricColor;
}

export type MetricKey = 'mcap' | 'volume' | 'fresh' | 'kol' | 'smart' | 'bot' | 'rug' | 'phish';

export type ColorRanges = Record<MetricKey, ColorRange[]>;

export type ChainKey = 'solana' | 'robinhood' | 'bsc';

export type ColorRangesByChain = Record<ChainKey, ColorRanges>;

export const CHAIN_OPTIONS: { key: ChainKey; label: string }[] = [
  { key: 'solana', label: 'Solana' },
  { key: 'robinhood', label: 'Robinhood' },
  { key: 'bsc', label: 'BSC' },
];

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

const SINGLE_CHAIN_DEFAULTS: ColorRanges = {
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
    { max: 20, color: '#eab308' },
    { max: 50, color: '#ffffff' },
    { max: null, color: '#22c55e' },
  ],
  kol: [
    { max: 1, color: '#ef4444' },
    { max: 3, color: '#eab308' },
    { max: 10, color: '#ffffff' },
    { max: null, color: '#22c55e' },
  ],
  smart: [
    { max: 1, color: '#ef4444' },
    { max: 3, color: '#eab308' },
    { max: 10, color: '#ffffff' },
    { max: null, color: '#22c55e' },
  ],
  bot: [
    { max: 10, color: '#22c55e' },
    { max: 20, color: '#eab308' },
    { max: 50, color: '#ffffff' },
    { max: null, color: '#ef4444' },
  ],
  rug: [
    { max: 5, color: '#22c55e' },
    { max: 15, color: '#eab308' },
    { max: 30, color: '#ffffff' },
    { max: null, color: '#ef4444' },
  ],
  phish: [
    { max: 5, color: '#22c55e' },
    { max: 15, color: '#eab308' },
    { max: 30, color: '#ffffff' },
    { max: null, color: '#ef4444' },
  ],
};

export const DEFAULT_RANGES_BY_CHAIN: ColorRangesByChain = {
  solana: SINGLE_CHAIN_DEFAULTS,
  robinhood: SINGLE_CHAIN_DEFAULTS,
  bsc: SINGLE_CHAIN_DEFAULTS,
};

export const DEFAULT_RANGES = SINGLE_CHAIN_DEFAULTS;

export function getColorForValue(ranges: ColorRange[], value: number | null | undefined): string {
  if (value == null || isNaN(value)) return '#ffffff';
  for (const r of ranges) {
    if (r.max === null || value <= r.max) return r.color;
  }
  return ranges[ranges.length - 1]?.color ?? '#ffffff';
}

function formatRangeLabel(r: ColorRange, index: number, total: number): string {
  if (r.max === null) return `${formatNum(r.max ?? 0)}+`;
  const prev = index > 0 ? 0 : 0;
  return `${formatNum(prev)} - ${formatNum(r.max)}`;
}

function formatNum(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(0)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

interface SettingsState {
  ready: boolean;
  deviceId: string;
  serverUrl: string;
  pushToken: string | null;
  proxyStatuses: ProxyStatus[];
  colorRangesByChain: ColorRangesByChain;
  load: () => Promise<void>;
  setUrl: (url: string) => Promise<void>;
  setPushToken: (token: string | null) => void;
  loadProxyStatuses: () => Promise<void>;
  setColorRange: (chain: ChainKey, metric: MetricKey, index: number, field: 'max' | 'color', value: number | null | string) => void;
  resetMetricRanges: (chain: ChainKey, metric: MetricKey) => void;
}

async function loadRangesByChain(): Promise<ColorRangesByChain> {
  try {
    const raw = await AsyncStorage.getItem(COLORS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const result: any = { ...DEFAULT_RANGES_BY_CHAIN };
      for (const chain of Object.keys(DEFAULT_RANGES_BY_CHAIN) as ChainKey[]) {
        if (parsed[chain]) {
          const chainRanges = { ...SINGLE_CHAIN_DEFAULTS };
          for (const key of Object.keys(SINGLE_CHAIN_DEFAULTS) as MetricKey[]) {
            if (Array.isArray(parsed[chain][key])) chainRanges[key] = parsed[chain][key];
          }
          result[chain] = chainRanges;
        }
      }
      return result;
    }
  } catch {}
  return DEFAULT_RANGES_BY_CHAIN;
}

function persist(ranges: ColorRangesByChain) {
  AsyncStorage.setItem(COLORS_KEY, JSON.stringify(ranges)).catch(() => {});
}

export const useSettings = create<SettingsState>((set, get) => ({
  ready: false,
  deviceId: '',
  serverUrl: 'http://localhost:4000',
  pushToken: null,
  proxyStatuses: [],
  colorRangesByChain: DEFAULT_RANGES_BY_CHAIN,
  load: async () => {
    const [deviceId, serverUrl, persistedToken, colorRangesByChain] = await Promise.all([
      getDeviceId(),
      getServerUrl(),
      getPersistedPushToken(),
      loadRangesByChain(),
    ]);
    set({ deviceId, serverUrl, pushToken: persistedToken, colorRangesByChain, ready: true });
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
  setColorRange: (chain, metric, index, field, value) => {
    const all = { ...get().colorRangesByChain };
    const ranges = { ...all[chain] };
    const list = [...ranges[metric]];
    list[index] = { ...list[index], [field]: value };
    ranges[metric] = list;
    all[chain] = ranges;
    set({ colorRangesByChain: all });
    persist(all);
  },
  resetMetricRanges: (chain, metric) => {
    const all = { ...get().colorRangesByChain };
    const ranges = { ...all[chain] };
    ranges[metric] = [...SINGLE_CHAIN_DEFAULTS[metric]];
    all[chain] = ranges;
    set({ colorRangesByChain: all });
    persist(all);
  },
}));
