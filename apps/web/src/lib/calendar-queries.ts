'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { BusyListSchema, CalendarConnectionListSchema, CalendarConnectStartSchema } from '@hrvo/shared';
import type { CalendarProvider } from '@hrvo/shared';
import { apiFetch } from './api';
import { useAuthStore } from './auth-store';

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');
const KEY = ['calendar', 'connections'] as const;

export function useCalendarConnections() {
  return useQuery({ queryKey: KEY, queryFn: () => apiFetch('/calendar/connections', { schema: CalendarConnectionListSchema }), enabled: useSignedIn() });
}

/** Starts OAuth: the browser leaves for Google/Microsoft and comes back to /account/calendar. */
export function useConnectCalendar() {
  return useMutation({
    mutationFn: (p: CalendarProvider) => apiFetch(`/calendar/${p.toLowerCase()}/connect`, { method: 'POST', schema: CalendarConnectStartSchema }),
    onSuccess: (r) => { window.location.assign(r.authorizeUrl); },
  });
}

export function useDisconnectCalendar() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (p: CalendarProvider) => apiFetch(`/calendar/${p.toLowerCase()}`, { method: 'DELETE', schema: z.object({ ok: z.literal(true) }) }), onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }) });
}

export function useSyncCalendar() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => apiFetch('/calendar/sync', { method: 'POST', schema: CalendarConnectionListSchema }), onSuccess: (l) => qc.setQueryData(KEY, l) });
}

/** FR-MEET-006: colleagues' busy times (from their connected calendars) for a slot. */
export function useBusy(userIds: string[], from: string | null, to: string | null) {
  const q = userIds.length && from && to ? `userIds=${userIds.join(',')}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : '';
  return useQuery({ queryKey: ['calendar', 'busy', q], queryFn: () => apiFetch(`/calendar/busy?${q}`, { schema: BusyListSchema }), enabled: useSignedIn() && !!q, staleTime: 60_000 });
}
