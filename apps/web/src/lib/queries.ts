'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  BreakResultSchema,
  ConsentStatusSchema,
  CorrectionListSchema,
  CorrectionQueueSchema,
  CorrectionSchema,
  LiveBoardSchema,
  MyDaysSchema,
  MyTodaySchema,
  TransparencySchema,
} from '@hrvo/shared';
import { apiFetch } from './api';
import { useAuthStore } from './auth-store';

export const queryKeys = {
  consent: ['attendance', 'consent'] as const,
  today: ['attendance', 'today'] as const,
  days: (from: string, to: string) => ['attendance', 'days', from, to] as const,
  myCorrections: ['attendance', 'my-corrections'] as const,
  queue: ['attendance', 'correction-queue'] as const,
  live: ['attendance', 'live'] as const,
  transparency: ['attendance', 'transparency'] as const,
};

function useSignedIn(): boolean {
  return useAuthStore((s) => s.status === 'authenticated');
}

export function useConsent() {
  return useQuery({
    queryKey: queryKeys.consent,
    queryFn: () => apiFetch('/attendance/consent', { schema: ConsentStatusSchema }),
    enabled: useSignedIn(),
  });
}

export function useAcceptConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (noticeVersion: string) =>
      apiFetch('/attendance/consent', { method: 'POST', body: { noticeVersion }, schema: z.unknown() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.consent }),
  });
}

export function useToday() {
  return useQuery({
    queryKey: queryKeys.today,
    queryFn: () => apiFetch('/attendance/me/today', { schema: MyTodaySchema }),
    enabled: useSignedIn(),
    refetchInterval: 60_000,
  });
}

export function useDays(from: string, to: string) {
  return useQuery({
    queryKey: queryKeys.days(from, to),
    queryFn: () => apiFetch(`/attendance/me/days?from=${from}&to=${to}`, { schema: MyDaysSchema }),
    enabled: useSignedIn(),
  });
}

export function useBreak() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: 'start' | 'end') =>
      apiFetch(`/attendance/break/${action}`, { method: 'POST', schema: BreakResultSchema }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.today });
      void qc.invalidateQueries({ queryKey: ['attendance', 'days'] });
    },
  });
}

export function useMyCorrections() {
  return useQuery({
    queryKey: queryKeys.myCorrections,
    queryFn: () => apiFetch('/attendance/me/corrections', { schema: CorrectionListSchema }),
    enabled: useSignedIn(),
  });
}

export function useRequestCorrection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { requestedIn: string; requestedOut: string; reason: string }) =>
      apiFetch('/attendance/corrections', { method: 'POST', body, schema: CorrectionSchema }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.myCorrections }),
  });
}

export function useCorrectionQueue(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.queue,
    queryFn: () => apiFetch('/attendance/corrections', { schema: CorrectionQueueSchema }),
    enabled: useSignedIn() && enabled,
    refetchInterval: 60_000,
  });
}

export function useReviewCorrection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; status: 'APPROVED' | 'REJECTED'; reviewNote?: string }) =>
      apiFetch(`/attendance/corrections/${encodeURIComponent(v.id)}`, {
        method: 'PATCH',
        body: { status: v.status, reviewNote: v.reviewNote },
        schema: z.object({ correction: CorrectionSchema.passthrough() }).passthrough(),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.queue }),
  });
}

export function useLiveBoard(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.live,
    queryFn: () => apiFetch('/attendance/live', { schema: LiveBoardSchema }),
    enabled: useSignedIn() && enabled,
    // Socket updates patch this cache in real time; the poll corrects drift and covers tabs without a socket.
    refetchInterval: 30_000,
  });
}

export function useTransparency() {
  return useQuery({
    queryKey: queryKeys.transparency,
    queryFn: () => apiFetch('/attendance/me/events', { schema: TransparencySchema }),
    enabled: useSignedIn(),
  });
}
