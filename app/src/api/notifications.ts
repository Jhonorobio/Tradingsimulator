import { api } from './client';
import type { PushSubscription } from './types';

export interface SubscriptionInput {
  push_token: string;
  chain?: string;
  types?: string[];
  filter_preset?: string;
  min_smart_degen?: number;
  min_volume_24h?: number;
  max_rug_ratio?: number;
}

export function subscribe(input: SubscriptionInput) {
  return api.post<{ subscription: PushSubscription }>('/api/notifications/subscribe', input);
}

export function getSubscriptions() {
  return api.get<{ subscriptions: PushSubscription[] }>('/api/notifications/subscriptions');
}

export function setSubscriptionEnabled(id: number, enabled: boolean) {
  return api.patch<{ subscription: PushSubscription }>(`/api/notifications/subscriptions/${id}`, { enabled });
}

export function deleteSubscription(id: number) {
  return api.delete<{ ok: boolean }>(`/api/notifications/subscriptions/${id}`);
}