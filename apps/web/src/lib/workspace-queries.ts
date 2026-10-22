'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AdminUserRowSchema,
  EffectiveAccessSchema,
  InvitationListSchema,
  InvitationRowSchema,
  MyAccessSchema,
  OrgProfileSchema,
  OwnershipTransferListSchema,
  OwnershipTransferSchema,
} from '@hrvo/shared';
import type { InviteUserDto, OrgProfileUpdateDto, OwnershipTransferDto, ProfileUpdateDto, UserStatusDto } from '@hrvo/shared';
import { z } from 'zod';
import { apiFetch } from './api';
import { adminKeys } from './admin-queries';
import { useAuthStore } from './auth-store';

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');

export const workspaceKeys = {
  invitations: ['admin', 'invitations'] as const,
  access: (id: string) => ['admin', 'access', id] as const,
  orgProfile: ['org', 'profile'] as const,
  transfers: ['org', 'ownership'] as const,
};

const InviteResponseSchema = z.object({ id: z.string(), email: z.string(), role: z.string(), expiresAt: z.string(), inviteToken: z.string() });

// ---------------------------------------------------------------- invitations (FR-AUTH-001)

export function useInvitations(enabled = true) {
  const signedIn = useSignedIn();
  return useQuery({ queryKey: workspaceKeys.invitations, queryFn: () => apiFetch('/auth/invitations', { schema: InvitationListSchema }), enabled: signedIn && enabled });
}

function useInvitationInvalidation() {
  const qc = useQueryClient();
  return () => { void qc.invalidateQueries({ queryKey: workspaceKeys.invitations }); void qc.invalidateQueries({ queryKey: adminKeys.users }); };
}

export function useInviteUser() {
  const done = useInvitationInvalidation();
  return useMutation({ mutationFn: (dto: InviteUserDto) => apiFetch('/auth/invitations/invite', { method: 'POST', body: dto, schema: InviteResponseSchema }), onSuccess: done });
}

export function useResendInvitation() {
  const done = useInvitationInvalidation();
  return useMutation({ mutationFn: (id: string) => apiFetch(`/auth/invitations/${encodeURIComponent(id)}/resend`, { method: 'POST', body: {}, schema: InvitationRowSchema }), onSuccess: done });
}

export function useRevokeInvitation() {
  const done = useInvitationInvalidation();
  return useMutation({ mutationFn: (id: string) => apiFetch(`/auth/invitations/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: {}, schema: InvitationRowSchema }), onSuccess: done });
}

// ---------------------------------------------------------------- people (FR-ORG-009, job titles)

function useUsersInvalidation() {
  const qc = useQueryClient();
  return () => { void qc.invalidateQueries({ queryKey: adminKeys.users }); void qc.invalidateQueries({ queryKey: ['admin', 'access'] }); void qc.invalidateQueries({ queryKey: workspaceKeys.orgProfile }); };
}

export function useSetUserStatus() {
  const done = useUsersInvalidation();
  return useMutation({ mutationFn: ({ userId, dto }: { userId: string; dto: UserStatusDto }) => apiFetch(`/admin/users/${encodeURIComponent(userId)}/status`, { method: 'PUT', body: dto, schema: AdminUserRowSchema }), onSuccess: done });
}

export function useUpdateUserProfile() {
  const done = useUsersInvalidation();
  return useMutation({ mutationFn: ({ userId, dto }: { userId: string; dto: ProfileUpdateDto }) => apiFetch(`/admin/users/${encodeURIComponent(userId)}/profile`, { method: 'PUT', body: dto, schema: AdminUserRowSchema }), onSuccess: done });
}

export function useUpdateMyProfile() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (dto: ProfileUpdateDto) => apiFetch('/me/profile', { method: 'PUT', body: dto, schema: MyAccessSchema }), onSuccess: (a) => qc.setQueryData(adminKeys.access, a) });
}

export function useEffectiveAccess(userId: string | null) {
  const signedIn = useSignedIn();
  return useQuery({ queryKey: workspaceKeys.access(userId ?? ''), queryFn: () => apiFetch(`/admin/users/${encodeURIComponent(userId!)}/access`, { schema: EffectiveAccessSchema }), enabled: signedIn && !!userId });
}

// ---------------------------------------------------------------- organisation profile and ownership

export function useOrgProfile(enabled = true) {
  const signedIn = useSignedIn();
  return useQuery({ queryKey: workspaceKeys.orgProfile, queryFn: () => apiFetch('/org/profile', { schema: OrgProfileSchema }), enabled: signedIn && enabled, staleTime: 30_000 });
}

export function useSaveOrgProfile() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (dto: OrgProfileUpdateDto) => apiFetch('/org/profile', { method: 'PUT', body: dto, schema: OrgProfileSchema }), onSuccess: (p) => qc.setQueryData(workspaceKeys.orgProfile, p) });
}

export function useOwnershipTransfers(enabled = true) {
  const signedIn = useSignedIn();
  return useQuery({ queryKey: workspaceKeys.transfers, queryFn: () => apiFetch('/org/ownership/transfers', { schema: OwnershipTransferListSchema }), enabled: signedIn && enabled });
}

function useOwnershipInvalidation() {
  const qc = useQueryClient();
  return () => { void qc.invalidateQueries({ queryKey: workspaceKeys.transfers }); void qc.invalidateQueries({ queryKey: adminKeys.users }); void qc.invalidateQueries({ queryKey: workspaceKeys.orgProfile }); void qc.invalidateQueries({ queryKey: adminKeys.access }); };
}

export function useCreateTransfer() {
  const done = useOwnershipInvalidation();
  return useMutation({ mutationFn: (dto: OwnershipTransferDto) => apiFetch('/org/ownership/transfers', { method: 'POST', body: dto, schema: OwnershipTransferSchema }), onSuccess: done });
}

export function useDecideTransfer() {
  const done = useOwnershipInvalidation();
  return useMutation({ mutationFn: ({ id, decision }: { id: string; decision: 'accept' | 'cancel' }) => apiFetch(`/org/ownership/transfers/${encodeURIComponent(id)}/${decision}`, { method: 'POST', body: {}, schema: OwnershipTransferSchema }), onSuccess: done });
}

export function useRemoveOwner() {
  const done = useOwnershipInvalidation();
  return useMutation({ mutationFn: ({ userId, proof }: { userId: string; proof: { password?: string; totpCode?: string } }) => apiFetch(`/org/owners/${encodeURIComponent(userId)}/remove`, { method: 'POST', body: proof, schema: z.object({ removed: z.literal(true) }) }), onSuccess: done });
}
