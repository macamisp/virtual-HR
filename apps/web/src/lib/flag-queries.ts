'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { AttendanceFlagListSchema, AttendanceFlagSchema, AttendanceGuardsSchema } from '@hrvo/shared';
import type { AttendanceGuards, FlagCommentDto, ResolveFlagDto } from '@hrvo/shared';
import { apiFetch } from './api';
import { useAuthStore } from './auth-store';

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');
const enc = encodeURIComponent;

/** ADR 019: review flags. "mine" = about me; "review" = people I review. */
export function useFlags(scope: 'mine' | 'review', status: 'OPEN' | 'RESOLVED' = 'OPEN', enabled = true) {
  return useQuery({
    queryKey: ['flags', scope, status],
    queryFn: () => apiFetch(`/attendance/flags?scope=${scope}&status=${status}`, { schema: AttendanceFlagListSchema }),
    enabled: useSignedIn() && enabled,
  });
}

function useRefresh() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ['flags'] });
}

export function useResolveFlag() {
  const done = useRefresh();
  return useMutation({ mutationFn: ({ id, dto }: { id: string; dto: ResolveFlagDto }) => apiFetch(`/attendance/flags/${enc(id)}/resolve`, { method: 'POST', body: dto, schema: AttendanceFlagSchema }), onSuccess: done });
}

export function useCommentFlag() {
  const done = useRefresh();
  return useMutation({ mutationFn: ({ id, dto }: { id: string; dto: FlagCommentDto }) => apiFetch(`/attendance/flags/${enc(id)}/comment`, { method: 'POST', body: dto, schema: AttendanceFlagSchema }), onSuccess: done });
}

export function useAttendanceGuards(enabled: boolean) {
  return useQuery({ queryKey: ['admin', 'attendance-guards'], queryFn: () => apiFetch('/admin/attendance-guards', { schema: AttendanceGuardsSchema }), enabled: useSignedIn() && enabled });
}

export function useSaveAttendanceGuards() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: AttendanceGuards) => apiFetch('/admin/attendance-guards', { method: 'PUT', body: dto, schema: AttendanceGuardsSchema }),
    onSuccess: (g) => qc.setQueryData(['admin', 'attendance-guards'], g),
  });
}

/** FR-ATT-023: "Yes, I am still working". */
export function answerChallenge(challengeId: string) {
  return apiFetch('/attendance/challenge', { method: 'POST', body: { challengeId }, schema: z.object({ currentState: z.string() }) });
}
