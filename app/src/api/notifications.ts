import { api } from './client';
import type { NotificationConfig, NotificationHistoryItem, NotificationCategoryFilters } from './types';

export function saveNotificationConfig(push_token: string, categories: NotificationConfig['categories'], filters?: Record<string, NotificationCategoryFilters>) {
  return api.put<{ ok: boolean }>('/api/notifications/config', { push_token, categories, filters });
}

export function getNotificationConfig() {
  return api.get<NotificationConfig>('/api/notifications/config');
}

export function getNotificationHistory(limit = 500) {
  return api.get<{ history: NotificationHistoryItem[] }>(`/api/notifications/history?limit=${limit}`);
}
