'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SavedViewListSchema, TodaySchema, WeekSchema, WorkloadSchema } from '@hrvo/shared';
import type { ConfirmPlanDto, EodReportDto, SavedViewDto, WeeklyPlanDto } from '@hrvo/shared';
import { apiFetch } from './api';
import { useAuthStore } from './auth-store';

export const planningKeys = {
  today: (date?: string) => ['planning', 'today', date ?? null] as const,
  week: (start?: string) => ['planning', 'week', start ?? null] as const,
  workload: (start?: string) => ['planning', 'workload', start ?? null] as const,
  views: ['task-views'] as const,
};

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');

export function useToday(date?: string) {
  return useQuery({
    queryKey: planningKeys.today(date),
    queryFn: () => apiFetch(`/planning/today${date ? `?date=${date}` : ''}`, { schema: TodaySchema }),
    enabled: useSignedIn(),
  });
}

function useInvalidatePlanning() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['planning'] });
    void qc.invalidateQueries({ queryKey: ['tasks'] });
  };
}

export function useConfirmPlan(date: string) {
  const invalidate = useInvalidatePlanning();
  return useMutation({
    mutationFn: (dto: ConfirmPlanDto) => apiFetch(`/planning/daily/${date}/confirm`, { method: 'POST', body: dto, schema: TodaySchema }),
    onSuccess: invalidate,
  });
}

export function useSubmitReport(date: string) {
  const invalidate = useInvalidatePlanning();
  return useMutation({
    mutationFn: (dto: EodReportDto) => apiFetch(`/planning/daily/${date}/report`, { method: 'POST', body: dto, schema: TodaySchema }),
    onSuccess: invalidate,
  });
}

export function useWeek(start?: string) {
  return useQuery({
    queryKey: planningKeys.week(start),
    queryFn: () => apiFetch(`/planning/week${start ? `?start=${start}` : ''}`, { schema: WeekSchema }),
    enabled: useSignedIn(),
  });
}

export function useSaveWeek(start: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: WeeklyPlanDto) => apiFetch(`/planning/week/${start}`, { method: 'PUT', body: dto, schema: WeekSchema }),
    onSuccess: (week) => {
      qc.setQueryData(planningKeys.week(start), week);
      void qc.invalidateQueries({ queryKey: ['planning', 'workload'] });
    },
  });
}

export function useWorkload(start: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: planningKeys.workload(start),
    queryFn: () => apiFetch(`/planning/workload${start ? `?start=${start}` : ''}`, { schema: WorkloadSchema }),
    enabled: useSignedIn() && enabled,
  });
}

export function useSavedViews() {
  return useQuery({ queryKey: planningKeys.views, queryFn: () => apiFetch('/task-views', { schema: SavedViewListSchema }), enabled: useSignedIn() });
}

export function useSavedViewMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { save: SavedViewDto } | { deleteId: string }) =>
      'save' in v
        ? apiFetch('/task-views', { method: 'POST', body: v.save, schema: SavedViewListSchema })
        : apiFetch(`/task-views/${v.deleteId}`, { method: 'DELETE', schema: SavedViewListSchema }),
    onSuccess: (views) => qc.setQueryData(planningKeys.views, views),
  });
}

/** Plan a task for a day (weekly planner drag/drop and keyboard moves). */
export function usePlanTask() {
  const invalidate = useInvalidatePlanning();
  return useMutation({
    mutationFn: (v: { id: string; version: number; plannedDate: string | null }) =>
      apiFetch(`/tasks/${encodeURIComponent(v.id)}`, { method: 'PATCH', body: { version: v.version, plannedDate: v.plannedDate } }),
    onSettled: invalidate,
  });
}
