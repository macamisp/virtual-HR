'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OfficeSnapshotSchema, PeopleListSchema, RoomInvitesSchema } from '@hrvo/shared';
import type { RoomUpdateDto, StatusDto } from '@hrvo/shared';
import { z } from 'zod';
import { apiFetch } from './api';
import { useAuthStore } from './auth-store';

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');
const enc = encodeURIComponent;
export const officeKeys = { snapshot: ['office'] as const, people: (q: string) => ['office', 'people', q] as const };

export function useOfficeSnapshot() {
  return useQuery({ queryKey: officeKeys.snapshot, queryFn: () => apiFetch('/office', { schema: OfficeSnapshotSchema }), enabled: useSignedIn(), staleTime: 60_000 });
}

/** FR-VO-008: everyone, with where they are; refreshed while the page is open. */
export function useOfficePeople(q: string) {
  return useQuery({
    queryKey: officeKeys.people(q),
    queryFn: () => apiFetch(`/office/people${q ? `?q=${enc(q)}` : ''}`, { schema: PeopleListSchema }),
    enabled: useSignedIn(),
    refetchInterval: 15_000,
  });
}

function useSnapshotUpdate() {
  const qc = useQueryClient();
  return (s: z.infer<typeof OfficeSnapshotSchema>) => qc.setQueryData(officeKeys.snapshot, s);
}

export function useSetStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: StatusDto) => apiFetch('/office/me/status', { method: 'PUT', body: dto, schema: z.object({ status: z.string(), message: z.string() }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['office', 'people'] }),
  });
}

export function useClaimDesk() {
  const set = useSnapshotUpdate();
  return useMutation({ mutationFn: (deskId: string) => apiFetch(`/office/desks/${enc(deskId)}/claim`, { method: 'POST', schema: OfficeSnapshotSchema }), onSuccess: set });
}

export function useReleaseDesk() {
  const set = useSnapshotUpdate();
  return useMutation({ mutationFn: (deskId: string) => apiFetch(`/office/desks/${enc(deskId)}/claim`, { method: 'DELETE', schema: OfficeSnapshotSchema }), onSuccess: set });
}

export function useUpdateRoom() {
  const set = useSnapshotUpdate();
  return useMutation({
    mutationFn: ({ id, dto }: { id: string; dto: RoomUpdateDto }) => apiFetch(`/office/rooms/${enc(id)}`, { method: 'PUT', body: dto, schema: OfficeSnapshotSchema }),
    onSuccess: set,
  });
}

export function useRoomInvites(roomId: string | null) {
  return useQuery({ queryKey: ['office', 'invites', roomId], queryFn: () => apiFetch(`/office/rooms/${enc(roomId!)}/invites`, { schema: RoomInvitesSchema }), enabled: useSignedIn() && !!roomId });
}

export function useSetRoomInvites() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, userIds }: { id: string; userIds: string[] }) => apiFetch(`/office/rooms/${enc(id)}/invites`, { method: 'PUT', body: { userIds }, schema: RoomInvitesSchema }),
    onSuccess: (_r, v) => { void qc.invalidateQueries({ queryKey: ['office', 'invites', v.id] }); void qc.invalidateQueries({ queryKey: officeKeys.snapshot }); },
  });
}
