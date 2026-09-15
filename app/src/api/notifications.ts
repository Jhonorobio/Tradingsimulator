import { api } from './client';
import type { NotificationConfig, NotificationHistoryItem, NotificationCategoryFilters } from './types';

export function saveNotificationConfig(push_token: string, categories: NotificationConfig['categories'], filters?: Record<string, NotificationCategoryFilters>) {
  return api.put<{ ok: boolean }>('/api/notifications/config', { push_token, categories, filters });
}

export function getNotificationConfig() {
  return api.get<NotificationConfig>('/api/notifications/config');
}

export function getNotificationHistory(limit = 300) {
  return api.get<{ history: NotificationHistoryItem[] }>(`/api/notifications/history?limit=${limit}`);
}

export interface WinnerItem {
  id: number;
  address: string;
  chain: string;
  symbol: string | null;
  name: string | null;
  category: string;
  mcap: number | null;
  logo: string | null;
  gain_pct: number;
  time_to_peak_minutes: number;
  snapshots: NotificationHistoryItem['snapshots'];
  added_at: string;
}

export function getWinners() {
  return api.get<{ winners: WinnerItem[] }>('/api/notifications/winners');
}
