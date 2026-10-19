'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OrgPersonSchema, OrgStructureSchema, OrgTeamSchema } from '@hrvo/shared';
import type { OrgPerson, PlacementDto, TeamDto, TeamUpdateDto } from '@hrvo/shared';
import { apiFetch } from './api';
import { useAuthStore } from './auth-store';

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');
const enc = encodeURIComponent;
export const orgKeys = { structure: ['org', 'structure'] as const };

/** FR-ORG-006 (ADR 031): teams and people with their team and manager. */
export function useOrgStructure(enabled = true) {
  return useQuery({ queryKey: orgKeys.structure, queryFn: () => apiFetch('/org/structure', { schema: OrgStructureSchema }), enabled: useSignedIn() && enabled });
}

export function useTeamMutations() {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: orgKeys.structure });
  const create = useMutation({ mutationFn: (dto: TeamDto) => apiFetch('/org/teams', { method: 'POST', body: dto, schema: OrgTeamSchema }), onSuccess: done });
  const update = useMutation({ mutationFn: (v: { id: string; dto: TeamUpdateDto }) => apiFetch(`/org/teams/${enc(v.id)}`, { method: 'PATCH', body: v.dto, schema: OrgTeamSchema }), onSuccess: done });
  const remove = useMutation({ mutationFn: (id: string) => apiFetch(`/org/teams/${enc(id)}`, { method: 'DELETE' }), onSuccess: done });
  return { create, update, remove };
}

export function usePlacement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; dto: PlacementDto }): Promise<OrgPerson> => apiFetch(`/org/people/${enc(v.id)}/placement`, { method: 'PUT', body: v.dto, schema: OrgPersonSchema }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: orgKeys.structure }),
  });
}

export const personName = (p: { displayName: string | null; email: string }) => p.displayName ?? p.email;
