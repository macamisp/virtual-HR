'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RatesListSchema,
  TimeEntrySchema,
  TimerStateSchema,
  TimesheetDetailSchema,
  TimesheetListSchema,
  TimesheetSettingsSchema,
} from '@hrvo/shared';
import type { ManualEntryDto, ProjectRateDto, RateProfileDto, TimesheetDetail, TimesheetSettingsDto, UpdateEntryDto } from '@hrvo/shared';
import { apiFetch } from './api';
import { useAuthStore } from './auth-store';

export const timesheetKeys = {
  all: ['timesheets'] as const,
  timer: ['timesheets', 'timer'] as const,
  current: ['timesheets', 'current'] as const,
  detail: (id: string) => ['timesheets', 'detail', id] as const,
  list: (q: string) => ['timesheets', 'list', q] as const,
  rates: ['timesheets', 'rates'] as const,
  settings: ['timesheets', 'settings'] as const,
};

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');
const enc = encodeURIComponent;

/** FR-TS-003: the running timer. The server clock (serverNow) drives the elapsed time. */
export function useTimer(enabled = true) {
  return useQuery({
    queryKey: timesheetKeys.timer,
    queryFn: () => apiFetch('/timer', { schema: TimerStateSchema }),
    enabled: useSignedIn() && enabled,
    refetchInterval: 60_000,
  });
}

function useInvalidateTime() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: timesheetKeys.all });
    void qc.invalidateQueries({ queryKey: ['tasks'] });
  };
}

export function useTimerAction() {
  const qc = useQueryClient();
  const invalidate = useInvalidateTime();
  return useMutation({
    mutationFn: (v: { action: 'start'; taskId: string } | { action: 'stop'; taskId?: string }) =>
      v.action === 'start'
        ? apiFetch(`/tasks/${enc(v.taskId)}/timer/start`, { method: 'POST', schema: TimerStateSchema })
        : apiFetch(v.taskId ? `/tasks/${enc(v.taskId)}/timer/stop` : '/timer/stop', { method: 'POST', schema: TimerStateSchema }),
    onSuccess: (state) => {
      qc.setQueryData(timesheetKeys.timer, state);
      invalidate();
    },
  });
}

export function useCurrentTimesheet(enabled: boolean) {
  return useQuery({
    queryKey: timesheetKeys.current,
    queryFn: () => apiFetch('/timesheets/current', { schema: TimesheetDetailSchema }),
    enabled: useSignedIn() && enabled,
  });
}

export function useTimesheet(id: string) {
  return useQuery({
    queryKey: timesheetKeys.detail(id),
    queryFn: () => apiFetch(`/timesheets/${enc(id)}`, { schema: TimesheetDetailSchema }),
    enabled: useSignedIn(),
  });
}

export interface TimesheetFilters {
  scope: 'mine' | 'team' | 'all';
  status?: string;
  from?: string;
  to?: string;
}

export function useTimesheets(f: TimesheetFilters, enabled = true) {
  const p = new URLSearchParams({ scope: f.scope });
  if (f.status) p.set('status', f.status);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  const q = p.toString();
  return useQuery({
    queryKey: timesheetKeys.list(q),
    queryFn: () => apiFetch(`/timesheets?${q}`, { schema: TimesheetListSchema }),
    enabled: useSignedIn() && enabled,
  });
}

/** Writes the returned detail into both caches it can appear in. */
function useStoreDetail() {
  const qc = useQueryClient();
  return (d: TimesheetDetail) => {
    qc.setQueryData(timesheetKeys.detail(d.id), d);
    void qc.invalidateQueries({ queryKey: timesheetKeys.current });
    void qc.invalidateQueries({ queryKey: ['timesheets', 'list'] });
  };
}

export type TimesheetAction =
  | { action: 'submit'; version: number }
  | { action: 'approve'; version: number; comment: string }
  | { action: 'reject'; version: number; comment: string }
  | { action: 'reopen'; reason: string }
  | { action: 'notes'; version: number; notes: string };

export function useTimesheetAction(id: string) {
  const store = useStoreDetail();
  return useMutation({
    mutationFn: (a: TimesheetAction) => {
      const { action, ...body } = a;
      return action === 'notes'
        ? apiFetch(`/timesheets/${enc(id)}`, { method: 'PATCH', body, schema: TimesheetDetailSchema })
        : apiFetch(`/timesheets/${enc(id)}/${action}`, { method: 'POST', body, schema: TimesheetDetailSchema });
    },
    onSuccess: store,
  });
}

export function useAddManualEntry() {
  const invalidate = useInvalidateTime();
  return useMutation({
    mutationFn: (dto: ManualEntryDto) => apiFetch('/time-entries', { method: 'POST', body: dto, schema: TimeEntrySchema }),
    onSuccess: invalidate,
  });
}

export function useEntryMutation() {
  const invalidate = useInvalidateTime();
  return useMutation({
    mutationFn: (v: { id: string; remove: true } | { id: string; patch: UpdateEntryDto }) =>
      'remove' in v
        ? apiFetch(`/time-entries/${enc(v.id)}`, { method: 'DELETE' })
        : apiFetch(`/time-entries/${enc(v.id)}`, { method: 'PATCH', body: v.patch, schema: TimeEntrySchema }),
    onSuccess: invalidate,
  });
}

export function useRates(enabled: boolean) {
  return useQuery({
    queryKey: timesheetKeys.rates,
    queryFn: () => apiFetch('/rates', { schema: RatesListSchema }),
    enabled: useSignedIn() && enabled,
  });
}

export function useRateMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { userId: string; profile: RateProfileDto } | { userId: string; projectId: string; rate: ProjectRateDto }) =>
      'profile' in v
        ? apiFetch(`/rates/${enc(v.userId)}`, { method: 'PUT', body: v.profile, schema: RatesListSchema })
        : apiFetch(`/projects/${enc(v.projectId)}/members/${enc(v.userId)}/rate`, { method: 'PUT', body: v.rate, schema: RatesListSchema }),
    onSuccess: (list) => {
      qc.setQueryData(timesheetKeys.rates, list);
      void qc.invalidateQueries({ queryKey: timesheetKeys.all });
    },
  });
}

export function useTimesheetSettings(enabled: boolean) {
  return useQuery({
    queryKey: timesheetKeys.settings,
    queryFn: () => apiFetch('/timesheets/settings', { schema: TimesheetSettingsSchema }),
    enabled: useSignedIn() && enabled,
  });
}

export function useUpdateTimesheetSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: TimesheetSettingsDto) => apiFetch('/timesheets/settings', { method: 'PUT', body: dto, schema: TimesheetSettingsSchema }),
    onSuccess: (s) => qc.setQueryData(timesheetKeys.settings, s),
  });
}
