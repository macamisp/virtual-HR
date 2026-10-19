'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SubcontractorListSchema, SubcontractorProfileSchema, SubcontractorSensitiveSchema } from '@hrvo/shared';
import type { SubcontractorProfileDto } from '@hrvo/shared';
import { apiFetch } from './api';
import { useAuthStore } from './auth-store';

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');
const enc = encodeURIComponent;
/** 'me' is the caller's own profile; anything else is a user id (HR routes). */
export type ProfileTarget = 'me' | string;
const path = (t: ProfileTarget) => (t === 'me' ? '/me/subcontractor-profile' : `/subcontractors/${enc(t)}/profile`);
export const subcontractorKeys = {
  list: ['subcontractors', 'list'] as const,
  profile: (t: ProfileTarget) => ['subcontractors', 'profile', t] as const,
};

/** FR-ORG-002 (ADR 033): HR's list of subcontractors (tax and bank only as "on file"). */
export function useSubcontractors(enabled = true) {
  return useQuery({ queryKey: subcontractorKeys.list, queryFn: () => apiFetch('/subcontractors', { schema: SubcontractorListSchema }), enabled: useSignedIn() && enabled });
}

/** The profile with tax ID and bank details masked. */
export function useSubcontractorProfile(target: ProfileTarget, enabled = true) {
  return useQuery({ queryKey: subcontractorKeys.profile(target), queryFn: () => apiFetch(path(target), { schema: SubcontractorProfileSchema }), enabled: useSignedIn() && enabled, retry: false });
}

export function useUpdateSubcontractorProfile(target: ProfileTarget) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: SubcontractorProfileDto) => apiFetch(path(target), { method: 'PUT', body: dto, schema: SubcontractorProfileSchema }),
    onSuccess: (p) => { qc.setQueryData(subcontractorKeys.profile(target), p); void qc.invalidateQueries({ queryKey: subcontractorKeys.list }); },
    gcTime: 0,
  });
}

/**
 * The clear tax ID and bank details. A mutation, not a query: nothing is cached, the result
 * lives only in the component that asked for it (gcTime 0), and every call is audited.
 */
export function useRevealSensitive(target: ProfileTarget) {
  return useMutation({ mutationFn: () => apiFetch(`${path(target)}/reveal`, { method: 'POST', schema: SubcontractorSensitiveSchema }), gcTime: 0 });
}
