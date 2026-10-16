'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { AnonymisationCheckSchema, PrivacyRequestListSchema, PrivacyRequestSchema } from '@hrvo/shared';
import type { CreateAnonymisationDto } from '@hrvo/shared';
import { apiFetch } from './api';
import { useAuthStore } from './auth-store';

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');
const enc = encodeURIComponent;

const PeopleSchema = z.array(z.object({ id: z.string(), email: z.string(), display_name: z.string().nullable(), role: z.string(), status: z.string() }));

/** FR-AUD-003: people HR can act on (users.manage). */
export function usePeople(enabled: boolean) {
  return useQuery({ queryKey: ['privacy', 'people'], queryFn: () => apiFetch('/users', { schema: PeopleSchema }), enabled: useSignedIn() && enabled });
}

export function useAnonymisationCheck(userId: string) {
  return useQuery({ queryKey: ['privacy', 'check', userId], queryFn: () => apiFetch(`/privacy/subjects/${enc(userId)}/anonymisation-check`, { schema: AnonymisationCheckSchema }), enabled: useSignedIn() && !!userId, retry: false });
}

export function usePrivacyRequests(enabled: boolean) {
  return useQuery({ queryKey: ['privacy', 'requests'], queryFn: () => apiFetch('/privacy/requests', { schema: PrivacyRequestListSchema }), enabled: useSignedIn() && enabled });
}

function useRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['privacy'] });
  };
}

export function useCreateAnonymisation() {
  const done = useRefresh();
  return useMutation({ mutationFn: (dto: CreateAnonymisationDto) => apiFetch('/privacy/requests', { method: 'POST', body: dto, schema: PrivacyRequestSchema }), onSuccess: done });
}

export function useExecuteAnonymisation() {
  const done = useRefresh();
  return useMutation({
    mutationFn: ({ id, confirmEmail }: { id: string; confirmEmail: string }) => apiFetch(`/privacy/requests/${enc(id)}/execute`, { method: 'POST', body: { confirmEmail }, schema: PrivacyRequestSchema }),
    onSuccess: done,
  });
}

export function useCancelAnonymisation() {
  const done = useRefresh();
  return useMutation({ mutationFn: (id: string) => apiFetch(`/privacy/requests/${enc(id)}/cancel`, { method: 'POST', schema: PrivacyRequestSchema }), onSuccess: done });
}
