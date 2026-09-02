import { api } from './client';
import type { NotificationConfig, NotificationHistoryItem } from './types';

export function saveNotificationConfig(push_token: string, categories: NotificationConfig['categories']) {
  return api.put<{ ok: boolean }>('/api/notifications/config', { push_token, categories });
}

export function getNotificationConfig() {
  return api.get<NotificationConfig>('/api/notifications/config');
}

export function getNotificationHistory(limit = 50) {
  return api.get<{ history: NotificationHistoryItem[] }>(`/api/notifications/history?limit=${limit}`);
}
