'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ScheduleOverviewSchema, ScheduleSchema } from '@hrvo/shared';
import type { ScheduleDto, ScheduleEndDto } from '@hrvo/shared';
import { apiFetch } from './api';
import { useAuthStore } from './auth-store';
import { queryKeys } from './queries';

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');
export const scheduleKeys = { overview: ['schedules'] as const };

/** FR-ORG-005 (ADR 032): every schedule version in force today or starting later. */
export function useSchedules(enabled = true) {
  return useQuery({ queryKey: scheduleKeys.overview, queryFn: () => apiFetch('/schedules', { schema: ScheduleOverviewSchema }), enabled: useSignedIn() && enabled });
}

export function useScheduleMutations() {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: scheduleKeys.overview });
    // A change from today alters today's expected hours and flags.
    void qc.invalidateQueries({ queryKey: queryKeys.live });
    void qc.invalidateQueries({ queryKey: ['attendance', 'days'] });
  };
  const set = useMutation({ mutationFn: (dto: ScheduleDto) => apiFetch('/schedules', { method: 'PUT', body: dto, schema: ScheduleSchema }), onSuccess: done });
  const end = useMutation({ mutationFn: (dto: ScheduleEndDto) => apiFetch('/schedules/end', { method: 'POST', body: dto }), onSuccess: done });
  return { set, end };
}
