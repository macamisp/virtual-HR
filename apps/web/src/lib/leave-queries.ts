'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HolidayListSchema, LeaveRequestListSchema, LeaveRequestSchema } from '@hrvo/shared';
import type { HolidayDto, LeaveDecisionDto, LeaveRequestDto } from '@hrvo/shared';
import { apiFetch } from './api';
import { useAuthStore } from './auth-store';
import { queryKeys } from './queries';

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');
const enc = encodeURIComponent;
export const leaveKeys = {
  all: ['leave'] as const,
  list: (scope: string) => ['leave', 'list', scope] as const,
  holidays: (year: number) => ['holidays', year] as const,
};

/** FR-ORG-010 (ADR 027): my requests, or the requests I decide. */
export function useLeaveRequests(scope: 'mine' | 'team', enabled = true) {
  return useQuery({ queryKey: leaveKeys.list(scope), queryFn: () => apiFetch(`/leave/requests?scope=${scope}`, { schema: LeaveRequestListSchema }), enabled: useSignedIn() && enabled });
}

function useRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: leaveKeys.all });
    // Approved leave changes the live board and a person's expected day.
    void qc.invalidateQueries({ queryKey: queryKeys.live });
    void qc.invalidateQueries({ queryKey: ['attendance', 'days'] });
  };
}

export function useRequestLeave() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (dto: LeaveRequestDto) => apiFetch('/leave/requests', { method: 'POST', body: dto, schema: LeaveRequestSchema }), onSuccess: refresh });
}

export function useCancelLeave() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (id: string) => apiFetch(`/leave/requests/${enc(id)}/cancel`, { method: 'POST', schema: LeaveRequestSchema }), onSuccess: refresh });
}

export function useDecideLeave() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (v: { id: string; dto: LeaveDecisionDto }) => apiFetch(`/leave/requests/${enc(v.id)}/decide`, { method: 'POST', body: v.dto, schema: LeaveRequestSchema }), onSuccess: refresh });
}

/** FR-ORG-011: the organisation's public holidays for one year. */
export function useHolidays(year: number) {
  return useQuery({ queryKey: leaveKeys.holidays(year), queryFn: () => apiFetch(`/holidays?year=${year}`, { schema: HolidayListSchema }), enabled: useSignedIn() });
}

export function useHolidayMutations(year: number) {
  const qc = useQueryClient();
  const done = () => { void qc.invalidateQueries({ queryKey: ['holidays'] }); void qc.invalidateQueries({ queryKey: ['attendance', 'days'] }); };
  const add = useMutation({ mutationFn: (dto: HolidayDto) => apiFetch('/holidays', { method: 'POST', body: dto, schema: HolidayListSchema }), onSuccess: done });
  const remove = useMutation({ mutationFn: (id: string) => apiFetch(`/holidays/${enc(id)}`, { method: 'DELETE', schema: HolidayListSchema }), onSuccess: done });
  const loadDefaults = useMutation({ mutationFn: () => apiFetch('/holidays/defaults', { method: 'POST', body: { year }, schema: HolidayListSchema }), onSuccess: done });
  return { add, remove, loadDefaults };
}
