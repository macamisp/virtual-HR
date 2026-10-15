'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NotificationListSchema } from '@hrvo/shared';
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
