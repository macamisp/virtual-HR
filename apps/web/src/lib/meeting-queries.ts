'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { JoinResultSchema, LobbySchema, MediaTokenSchema, MeetingListSchema, MeetingSchema } from '@hrvo/shared';
import type { ActionItemDto, MediaTokenRequest, MeetingCreateDto, MeetingUpdateDto } from '@hrvo/shared';
import { apiDownload, apiFetch, saveBlob } from './api';
import { useAuthStore } from './auth-store';

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');
const enc = encodeURIComponent;
export const meetingKeys = {
  all: ['meetings'] as const,
  list: (scope: string) => ['meetings', 'list', scope] as const,
  detail: (id: string) => ['meetings', 'detail', id] as const,
  lobby: (id: string) => ['meetings', 'lobby', id] as const,
};

/** ADR 016: the server picks the LiveKit room; the client only says what the token is for. */
export function fetchMediaToken(req: MediaTokenRequest) {
  return apiFetch('/media/token', { method: 'POST', body: req, schema: MediaTokenSchema });
}

export function useMeetings(scope: 'upcoming' | 'past' | 'live') {
  return useQuery({ queryKey: meetingKeys.list(scope), queryFn: () => apiFetch(`/meetings?scope=${scope}`, { schema: MeetingListSchema }), enabled: useSignedIn(), refetchInterval: scope === 'live' ? 15_000 : false });
}

export function useMeeting(id: string) {
  return useQuery({ queryKey: meetingKeys.detail(id), queryFn: () => apiFetch(`/meetings/${enc(id)}`, { schema: MeetingSchema }), enabled: useSignedIn() && !!id, retry: false });
}

function useSetMeeting() {
  const qc = useQueryClient();
  return (m: z.infer<typeof MeetingSchema>) => {
    qc.setQueryData(meetingKeys.detail(m.id), m);
    void qc.invalidateQueries({ queryKey: ['meetings', 'list'] });
  };
}

export function useCreateMeeting() {
  const set = useSetMeeting();
  return useMutation({ mutationFn: (dto: MeetingCreateDto) => apiFetch('/meetings', { method: 'POST', body: dto, schema: MeetingSchema }), onSuccess: set });
}

export function useUpdateMeeting(id: string) {
  const set = useSetMeeting();
  return useMutation({ mutationFn: (dto: MeetingUpdateDto) => apiFetch(`/meetings/${enc(id)}`, { method: 'PUT', body: dto, schema: MeetingSchema }), onSuccess: set });
}

export function useCancelMeeting(id: string) {
  const set = useSetMeeting();
  return useMutation({ mutationFn: () => apiFetch(`/meetings/${enc(id)}`, { method: 'DELETE', schema: MeetingSchema }), onSuccess: set });
}

export function useRespond(id: string) {
  const set = useSetMeeting();
  return useMutation({ mutationFn: (accept: boolean) => apiFetch(`/meetings/${enc(id)}/${accept ? 'accept' : 'decline'}`, { method: 'POST', schema: MeetingSchema }), onSuccess: set });
}

export function joinMeeting(id: string) {
  return apiFetch(`/meetings/${enc(id)}/join`, { method: 'POST', schema: JoinResultSchema });
}

export async function downloadIcs(id: string): Promise<void> {
  const { blob } = await apiDownload(`/meetings/${enc(id)}/invite.ics`);
  saveBlob(blob, 'invite.ics');
}

export function useLobby(id: string, enabled: boolean) {
  return useQuery({ queryKey: meetingKeys.lobby(id), queryFn: () => apiFetch(`/meetings/${enc(id)}/lobby`, { schema: LobbySchema }), enabled: useSignedIn() && enabled, refetchInterval: enabled ? 10_000 : false });
}

export function useLobbyDecision(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: { userId: string; admit: boolean }) => apiFetch(`/meetings/${enc(id)}/lobby`, { method: 'POST', body: dto, schema: z.object({ ok: z.literal(true) }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: meetingKeys.lobby(id) }),
  });
}

export function useMuteAll(id: string) {
  return useMutation({ mutationFn: () => apiFetch(`/meetings/${enc(id)}/mute-all`, { method: 'POST', schema: z.object({ muted: z.number() }) }) });
}

export function useRemoveParticipant(id: string) {
  return useMutation({ mutationFn: (userId: string) => apiFetch(`/meetings/${enc(id)}/remove`, { method: 'POST', body: { userId }, schema: z.object({ ok: z.literal(true) }) }) });
}

export function useAddActionItem(id: string) {
  const set = useSetMeeting();
  return useMutation({ mutationFn: (dto: ActionItemDto) => apiFetch(`/meetings/${enc(id)}/action-items`, { method: 'POST', body: dto, schema: MeetingSchema }), onSuccess: set });
}

export function useConvertToTask(id: string) {
  const set = useSetMeeting();
  return useMutation({ mutationFn: (itemId: string) => apiFetch(`/meetings/${enc(id)}/action-items/${enc(itemId)}/task`, { method: 'POST', schema: MeetingSchema }), onSuccess: set });
}
