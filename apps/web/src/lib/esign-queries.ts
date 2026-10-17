'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReauthStatusSchema, SignatureRequestListSchema, SignatureRequestSchema, SignatureVerificationSchema } from '@hrvo/shared';
import type { SignatureRequestDto, SignDto } from '@hrvo/shared';
import { ApiError, apiFetch } from './api';
import { useAuthStore } from './auth-store';
import { docKeys } from './document-queries';

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');
const enc = encodeURIComponent;

export const signKeys = {
  all: ['signatures'] as const,
  list: (scope: string, documentId?: string) => ['signatures', 'list', scope, documentId ?? ''] as const,
  detail: (id: string) => ['signatures', 'detail', id] as const,
  verify: (id: string) => ['signatures', 'verify', id] as const,
};

/** FR-DOC-014: requests waiting for me, requests I sent, or the requests on one document. */
export function useSignatureRequests(scope: 'to-sign' | 'sent' | 'document', documentId?: string) {
  const q = new URLSearchParams({ scope, ...(documentId ? { documentId } : {}) }).toString();
  return useQuery({
    queryKey: signKeys.list(scope, documentId),
    queryFn: () => apiFetch(`/signature-requests?${q}`, { schema: SignatureRequestListSchema }),
    enabled: useSignedIn() && (scope !== 'document' || !!documentId),
  });
}

export function useSignatureRequest(id: string) {
  return useQuery({ queryKey: signKeys.detail(id), queryFn: () => apiFetch(`/signature-requests/${enc(id)}`, { schema: SignatureRequestSchema }), enabled: useSignedIn() });
}

export function useSignatureVerification(id: string, enabled: boolean) {
  return useQuery({
    queryKey: signKeys.verify(id),
    queryFn: () => apiFetch(`/signature-requests/${enc(id)}/verify`, { schema: SignatureVerificationSchema }),
    enabled: useSignedIn() && enabled,
    // The signed copy is checked once its virus scan has finished.
    refetchInterval: (q) => (q.state.data?.status === 'COMPLETED' && q.state.data.signedIntact === null ? 3000 : false),
  });
}

function useRefresh() {
  const qc = useQueryClient();
  return (documentId?: string) => {
    void qc.invalidateQueries({ queryKey: signKeys.all });
    if (documentId) void qc.invalidateQueries({ queryKey: docKeys.detail(documentId) });
  };
}

export function useRequestSignatures(documentId: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (dto: SignatureRequestDto) => apiFetch(`/documents/${enc(documentId)}/signature-requests`, { method: 'POST', body: dto, schema: SignatureRequestSchema }),
    onSuccess: () => refresh(documentId),
  });
}

/** Confirms identity (password or authenticator code) and then signs, so every signature has a fresh check. */
export function useSign(id: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (v: { credentials: { password?: string; totpCode?: string }; dto: SignDto }) => {
      try {
        await apiFetch('/vault/reauth', { method: 'POST', body: v.credentials, schema: ReauthStatusSchema });
      } catch (e) {
        throw e instanceof ApiError && e.status === 401 ? new ApiError(401, 'That password or code did not match. Try again.') : e;
      }
      return await apiFetch(`/signature-requests/${enc(id)}/sign`, { method: 'POST', body: v.dto, schema: SignatureRequestSchema });
    },
    onSuccess: (r) => refresh(r.documentId),
  });
}

export function useSignatureAction(id: string, action: 'decline' | 'cancel' | 'finalize') {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (reason?: string) => apiFetch(`/signature-requests/${enc(id)}/${action}`, { method: 'POST', body: action === 'decline' ? { reason } : undefined, schema: SignatureRequestSchema }),
    onSuccess: (r) => refresh(r.documentId),
  });
}
