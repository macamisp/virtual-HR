'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AccessLogListSchema,
  AclListSchema,
  ContractListSchema,
  ContractSchema,
  DocumentDetailSchema,
  DocumentListSchema,
  FolderListSchema,
  FolderSchema,
  ShareTargetsSchema,
  DocumentSummarySchema,
  ShareLinkListSchema,
  CreatedShareLinkSchema,
  RetentionRulesSchema,
} from '@hrvo/shared';
import type { AclGrantDto, ContractDto, CreatedShareLink, ContractUpdateDto, DocumentDetail, FolderDto, RetentionRulesDto, ShareLinkDto, UpdateDocumentDto } from '@hrvo/shared';
import { apiFetch } from './api';
import { useAuthStore } from './auth-store';

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');
const enc = encodeURIComponent;

export const docKeys = {
  all: ['documents'] as const,
  list: (q: string) => ['documents', 'list', q] as const,
  detail: (id: string) => ['documents', 'detail', id] as const,
  acl: (id: string) => ['documents', 'acl', id] as const,
  log: (id: string) => ['documents', 'log', id] as const,
  folders: ['documents', 'folders'] as const,
  contracts: ['contracts'] as const,
};

export interface DocumentFilters {
  folderId?: string;
  category?: string;
  q?: string;
}

/** Waiting on a virus scan: poll until every listed document has a final status. */
const scanning = (s: string | null | undefined) => s === 'PENDING' || s === 'UPLOADING';

export function useDocuments(f: DocumentFilters) {
  const p = new URLSearchParams();
  if (f.folderId) p.set('folderId', f.folderId);
  if (f.category) p.set('category', f.category);
  if (f.q) p.set('q', f.q);
  const q = p.toString();
  return useQuery({
    queryKey: docKeys.list(q),
    queryFn: () => apiFetch(`/documents${q ? `?${q}` : ''}`, { schema: DocumentListSchema }),
    enabled: useSignedIn(),
    refetchInterval: (query) => (query.state.data?.items.some((d) => scanning(d.latestStatus)) ? 2000 : false),
  });
}

export function useDocument(id: string) {
  return useQuery({
    queryKey: docKeys.detail(id),
    queryFn: () => apiFetch(`/documents/${enc(id)}`, { schema: DocumentDetailSchema }),
    enabled: useSignedIn(),
    refetchInterval: (query) => (scanning(query.state.data?.latestStatus) ? 2000 : false),
  });
}

function useStore() {
  const qc = useQueryClient();
  return (d: DocumentDetail) => {
    qc.setQueryData(docKeys.detail(d.id), d);
    void qc.invalidateQueries({ queryKey: ['documents', 'list'] });
    void qc.invalidateQueries({ queryKey: docKeys.contracts });
  };
}

export function useUpdateDocument(id: string) {
  const store = useStore();
  return useMutation({
    mutationFn: (dto: UpdateDocumentDto) => apiFetch(`/documents/${enc(id)}`, { method: 'PATCH', body: dto, schema: DocumentDetailSchema }),
    onSuccess: store,
  });
}

export function useRestoreVersion(id: string) {
  const store = useStore();
  return useMutation({
    mutationFn: (versionId: string) => apiFetch(`/documents/${enc(id)}/versions/${enc(versionId)}/restore`, { method: 'POST', schema: DocumentDetailSchema }),
    onSuccess: store,
  });
}

export function useDeleteDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/documents/${enc(id)}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: docKeys.all }),
  });
}

export function useAcl(target: { documentId?: string; folderId?: string }, enabled: boolean) {
  const path = target.documentId ? `/documents/${enc(target.documentId)}/acl` : `/documents/folders/${enc(target.folderId ?? '')}/acl`;
  return useQuery({
    queryKey: docKeys.acl(target.documentId ?? `folder:${target.folderId}`),
    queryFn: () => apiFetch(path, { schema: AclListSchema }),
    enabled: useSignedIn() && enabled,
  });
}

export function useAclMutation(target: { documentId?: string; folderId?: string }) {
  const qc = useQueryClient();
  const base = target.documentId ? `/documents/${enc(target.documentId)}/acl` : `/documents/folders/${enc(target.folderId ?? '')}/acl`;
  return useMutation({
    mutationFn: (v: { grant: AclGrantDto } | { revoke: string }) =>
      'grant' in v
        ? apiFetch(base, { method: 'POST', body: v.grant, schema: AclListSchema })
        : apiFetch(`${base}/${enc(v.revoke)}`, { method: 'DELETE', schema: AclListSchema }),
    onSuccess: (list) => {
      qc.setQueryData(docKeys.acl(target.documentId ?? `folder:${target.folderId}`), list);
      if (target.documentId) void qc.invalidateQueries({ queryKey: docKeys.log(target.documentId) });
    },
  });
}

export function useAccessLog(id: string, enabled: boolean) {
  return useQuery({
    queryKey: docKeys.log(id),
    queryFn: () => apiFetch(`/documents/${enc(id)}/access-log?limit=50`, { schema: AccessLogListSchema }),
    enabled: useSignedIn() && enabled,
  });
}

export function useFolders() {
  return useQuery({ queryKey: docKeys.folders, queryFn: () => apiFetch('/documents/folders', { schema: FolderListSchema }), enabled: useSignedIn() });
}

export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: FolderDto) => apiFetch('/documents/folders', { method: 'POST', body: dto, schema: FolderSchema }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: docKeys.folders }),
  });
}

export function useContracts() {
  return useQuery({ queryKey: docKeys.contracts, queryFn: () => apiFetch('/contracts', { schema: ContractListSchema }), enabled: useSignedIn() });
}

export function useContractMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { create: ContractDto } | { id: string; update: ContractUpdateDto }) =>
      'create' in v
        ? apiFetch('/contracts', { method: 'POST', body: v.create, schema: ContractSchema })
        : apiFetch(`/contracts/${enc(v.id)}`, { method: 'PATCH', body: v.update, schema: ContractSchema }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: docKeys.contracts });
      void qc.invalidateQueries({ queryKey: docKeys.all });
    },
  });
}

export function useShareTargets(enabled: boolean) {
  return useQuery({
    queryKey: ['documents', 'share-targets'],
    queryFn: () => apiFetch('/documents/share-targets', { schema: ShareTargetsSchema }),
    enabled: useSignedIn() && enabled,
    staleTime: 60_000,
  });
}

// ---- confidential vault (FR-DOC-005, 006, 010, 017)

export function useVaultMutation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v:
      | { action: 'set'; password: string; currentPassword?: string }
      | { action: 'remove'; currentPassword: string }
      | { action: 'recover'; newPassword: string; reason: string }
      | { action: 'hold'; hold: boolean; reason?: string }
      | { action: 'untrash' }) => {
      const e = encodeURIComponent(id);
      switch (v.action) {
        case 'set': return apiFetch(`/documents/${e}/password`, { method: 'PUT', body: { password: v.password, currentPassword: v.currentPassword }, schema: DocumentSummarySchema });
        case 'remove': return apiFetch(`/documents/${e}/password/remove`, { method: 'POST', body: { currentPassword: v.currentPassword }, schema: DocumentSummarySchema });
        case 'recover': return apiFetch(`/documents/${e}/password/recover`, { method: 'POST', body: { newPassword: v.newPassword, reason: v.reason }, schema: DocumentSummarySchema });
        case 'hold': return apiFetch(`/documents/${e}/legal-hold`, { method: 'PUT', body: { hold: v.hold, reason: v.reason }, schema: DocumentSummarySchema });
        case 'untrash': return apiFetch(`/documents/${e}/untrash`, { method: 'POST', schema: DocumentSummarySchema });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: docKeys.all });
    },
  });
}

export function useShareLinks(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['documents', 'share-links', id],
    queryFn: () => apiFetch(`/documents/${enc(id)}/share-links`, { schema: ShareLinkListSchema }),
    enabled: useSignedIn() && enabled,
  });
}

export function useShareLinkMutation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { create: ShareLinkDto } | { revoke: string }): Promise<CreatedShareLink | null> => {
      if ('create' in v) return await apiFetch(`/documents/${enc(id)}/share-links`, { method: 'POST', body: v.create, schema: CreatedShareLinkSchema });
      await apiFetch(`/documents/${enc(id)}/share-links/${enc(v.revoke)}`, { method: 'DELETE', schema: ShareLinkListSchema });
      return null;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['documents', 'share-links', id] }),
  });
}

export function useTrash() {
  return useQuery({ queryKey: ['documents', 'trash'], queryFn: () => apiFetch('/documents/trash', { schema: DocumentListSchema }), enabled: useSignedIn() });
}

export function useRetention() {
  return useQuery({ queryKey: ['documents', 'retention'], queryFn: () => apiFetch('/documents/retention', { schema: RetentionRulesSchema }), enabled: useSignedIn() });
}

export function useSaveRetention() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: RetentionRulesDto) => apiFetch('/documents/retention', { method: 'PUT', body: dto, schema: RetentionRulesSchema }),
    onSuccess: (r) => qc.setQueryData(['documents', 'retention'], r),
  });
}
