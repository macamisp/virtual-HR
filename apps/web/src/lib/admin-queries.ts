'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AdminUserListSchema,
  AdminUserRowSchema,
  AuditFacetsSchema,
  AuditListSchema,
  AuditVerificationSchema,
  ConsentListSchema,
  CustomRoleSchema,
  MyAccessSchema,
  OrgPolicySchema,
  RetentionOverviewSchema,
  RolesOverviewSchema,
} from '@hrvo/shared';
import type { AssignRoleDto, ConsentDto, CustomRoleDto, OrgPolicy, RetentionSettings } from '@hrvo/shared';
import { apiFetch } from './api';
import { useAuthStore } from './auth-store';

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');

export const adminKeys = {
  access: ['me', 'access'] as const,
  policy: ['admin', 'policy'] as const,
  retention: ['admin', 'retention'] as const,
  roles: ['admin', 'roles'] as const,
  users: ['admin', 'users'] as const,
  audit: (q: string) => ['audit', 'list', q] as const,
  facets: ['audit', 'facets'] as const,
  consents: ['me', 'consents'] as const,
  userConsents: (id: string) => ['admin', 'consents', id] as const,
};

/** FR-ADM-002: the signed-in user's effective permissions, resolved by the API. */
export function useMyAccess() {
  return useQuery({ queryKey: adminKeys.access, queryFn: () => apiFetch('/me/access', { schema: MyAccessSchema }), enabled: useSignedIn(), staleTime: 30_000 });
}

export function usePolicy() {
  return useQuery({ queryKey: adminKeys.policy, queryFn: () => apiFetch('/admin/policy', { schema: OrgPolicySchema }), enabled: useSignedIn() });
}

export function useSavePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: OrgPolicy) => apiFetch('/admin/policy', { method: 'PUT', body: dto, schema: OrgPolicySchema }),
    onSuccess: (p) => qc.setQueryData(adminKeys.policy, p),
  });
}

export function useRetentionSettings() {
  return useQuery({ queryKey: adminKeys.retention, queryFn: () => apiFetch('/admin/retention', { schema: RetentionOverviewSchema }), enabled: useSignedIn() });
}

export function useSaveRetentionSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: RetentionSettings) => apiFetch('/admin/retention', { method: 'PUT', body: dto, schema: RetentionOverviewSchema }),
    onSuccess: (r) => qc.setQueryData(adminKeys.retention, r),
  });
}

export function useRoles() {
  return useQuery({ queryKey: adminKeys.roles, queryFn: () => apiFetch('/admin/roles', { schema: RolesOverviewSchema }), enabled: useSignedIn() });
}

export function useAdminUsers() {
  return useQuery({ queryKey: adminKeys.users, queryFn: () => apiFetch('/admin/users', { schema: AdminUserListSchema }), enabled: useSignedIn() });
}

function useRoleInvalidation() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: adminKeys.roles });
    void qc.invalidateQueries({ queryKey: adminKeys.users });
  };
}

export function useSaveRole() {
  const done = useRoleInvalidation();
  return useMutation({
    mutationFn: ({ id, dto }: { id: string | null; dto: CustomRoleDto }) =>
      apiFetch(id ? `/admin/roles/${encodeURIComponent(id)}` : '/admin/roles', { method: id ? 'PUT' : 'POST', body: dto, schema: CustomRoleSchema }),
    onSuccess: done,
  });
}

export function useDeleteRole() {
  const done = useRoleInvalidation();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/admin/roles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: done,
  });
}

export function useAssignRole() {
  const done = useRoleInvalidation();
  return useMutation({
    mutationFn: ({ userId, dto }: { userId: string; dto: AssignRoleDto }) =>
      apiFetch(`/admin/users/${encodeURIComponent(userId)}/role`, { method: 'PUT', body: dto, schema: AdminUserRowSchema }),
    onSuccess: done,
  });
}

export interface AuditFilters {
  action?: string;
  entityType?: string;
  entityId?: string;
  from?: string;
  to?: string;
  offset?: number;
}

export function auditQueryString(f: AuditFilters, limit?: number): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '') p.set(k, String(v));
  if (limit) p.set('limit', String(limit));
  return p.toString();
}

export function useAuditLog(f: AuditFilters, limit: number) {
  const q = auditQueryString(f, limit);
  return useQuery({ queryKey: adminKeys.audit(q), queryFn: () => apiFetch(`/audit-logs?${q}`, { schema: AuditListSchema }), enabled: useSignedIn() });
}

export function useAuditFacets() {
  return useQuery({ queryKey: adminKeys.facets, queryFn: () => apiFetch('/audit-logs/facets', { schema: AuditFacetsSchema }), enabled: useSignedIn() });
}

export function useVerifyAudit() {
  return useMutation({ mutationFn: () => apiFetch('/audit-logs/verify', { schema: AuditVerificationSchema }) });
}

export function useMyConsents() {
  return useQuery({ queryKey: adminKeys.consents, queryFn: () => apiFetch('/me/consents', { schema: ConsentListSchema }), enabled: useSignedIn() });
}

export function useRecordConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: ConsentDto) => apiFetch('/me/consents', { method: 'POST', body: dto, schema: ConsentListSchema }),
    onSuccess: (list) => qc.setQueryData(adminKeys.consents, list),
  });
}

export function useUserConsents(userId: string) {
  return useQuery({
    queryKey: adminKeys.userConsents(userId),
    queryFn: () => apiFetch(`/admin/users/${encodeURIComponent(userId)}/consents`, { schema: ConsentListSchema }),
    enabled: useSignedIn() && !!userId,
  });
}
