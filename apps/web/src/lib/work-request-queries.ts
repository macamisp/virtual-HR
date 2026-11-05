'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OnsiteRequestListSchema, OnsiteRequestSchema, OvertimeRequestListSchema, OvertimeRequestSchema } from '@hrvo/shared';
import type { OnsiteDecisionDto, OnsiteRequestDto, OvertimeDecisionDto, OvertimeRequestDto, RequestStatus } from '@hrvo/shared';
import { apiFetch } from './api';
import { useAuthStore } from './auth-store';

/** ADR 049 §2, §7: overtime and onsite work requests. */
const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');
const enc = encodeURIComponent;

function qs(scope: 'mine' | 'team', status?: RequestStatus): string {
  return `scope=${scope}${status ? `&status=${status}` : ''}`;
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['work-requests'] });
    void qc.invalidateQueries({ queryKey: ['timesheets'] });
  };
}

export function useOvertimeRequests(scope: 'mine' | 'team', status?: RequestStatus, enabled = true) {
  return useQuery({
    queryKey: ['work-requests', 'overtime', scope, status ?? 'all'] as const,
    queryFn: () => apiFetch(`/overtime-requests?${qs(scope, status)}`, { schema: OvertimeRequestListSchema }),
    enabled: useSignedIn() && enabled,
  });
}

export function useOnsiteRequests(scope: 'mine' | 'team', status?: RequestStatus, enabled = true) {
  return useQuery({
    queryKey: ['work-requests', 'onsite', scope, status ?? 'all'] as const,
    queryFn: () => apiFetch(`/onsite-requests?${qs(scope, status)}`, { schema: OnsiteRequestListSchema }),
    enabled: useSignedIn() && enabled,
  });
}

export function useRequestOvertime() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (dto: OvertimeRequestDto) => apiFetch('/overtime-requests', { method: 'POST', body: dto, schema: OvertimeRequestSchema }), onSuccess: invalidate });
}

export function useRequestOnsite() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (dto: OnsiteRequestDto) => apiFetch('/onsite-requests', { method: 'POST', body: dto, schema: OnsiteRequestSchema }), onSuccess: invalidate });
}

export function useOvertimeAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; decide: OvertimeDecisionDto } | { id: string; cancel: { comment?: string } }) =>
      'decide' in v
        ? apiFetch(`/overtime-requests/${enc(v.id)}/decide`, { method: 'POST', body: v.decide, schema: OvertimeRequestSchema })
        : apiFetch(`/overtime-requests/${enc(v.id)}/cancel`, { method: 'POST', body: v.cancel, schema: OvertimeRequestSchema }),
    onSuccess: invalidate,
  });
}

export function useOnsiteAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; decide: OnsiteDecisionDto } | { id: string; cancel: true }) =>
      'decide' in v
        ? apiFetch(`/onsite-requests/${enc(v.id)}/decide`, { method: 'POST', body: v.decide, schema: OnsiteRequestSchema })
        : apiFetch(`/onsite-requests/${enc(v.id)}/cancel`, { method: 'POST', schema: OnsiteRequestSchema }),
    onSuccess: invalidate,
  });
}
