'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NotificationListSchema, NotificationPreferencesSchema, UnsubscribeResultSchema } from '@hrvo/shared';
import type { NotificationPreferencesDto } from '@hrvo/shared';
import { apiFetch } from './api';
import { useAuthStore } from './auth-store';

export const notificationKeys = { list: ['notifications'] as const };

/** FR-NOTIF-001. Live updates arrive over the socket (heartbeat worker); the poll is a fallback. */
export function useNotifications() {
  return useQuery({
    queryKey: notificationKeys.list,
    queryFn: () => apiFetch('/notifications?limit=30', { schema: NotificationListSchema }),
    enabled: useAuthStore((s) => s.status === 'authenticated'),
    refetchInterval: 60_000,
  });
}

export function useMarkNotifications() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string } | { all: true }) =>
      'all' in v
        ? apiFetch('/notifications/read-all', { method: 'POST', schema: NotificationListSchema })
        : apiFetch(`/notifications/${encodeURIComponent(v.id)}/read`, { method: 'POST', schema: NotificationListSchema }),
    onSuccess: (list) => qc.setQueryData(notificationKeys.list, list),
  });
}

export const preferenceKeys = { prefs: ['notifications', 'preferences'] as const };

/** FR-NOTIF-004 */
export function useNotificationPreferences() {
  return useQuery({
    queryKey: preferenceKeys.prefs,
    queryFn: () => apiFetch('/notifications/preferences', { schema: NotificationPreferencesSchema }),
    enabled: useAuthStore((s) => s.status === 'authenticated'),
  });
}

export function useSaveNotificationPreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: NotificationPreferencesDto) => apiFetch('/notifications/preferences', { method: 'PUT', body: dto, schema: NotificationPreferencesSchema }),
    onSuccess: (p) => qc.setQueryData(preferenceKeys.prefs, p),
  });
}

/** FR-NOTIF-002: public, from the link in an email. */
export function useUnsubscribe() {
  return useMutation({
    mutationFn: (token: string) => apiFetch('/notifications/unsubscribe', { method: 'POST', body: { token }, auth: 'none', schema: UnsubscribeResultSchema }),
  });
}
