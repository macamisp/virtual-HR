'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { ChannelListSchema, ChatSearchSchema, MessageListSchema, MessageSchema } from '@hrvo/shared';
import type { ChannelCreateDto, MembersDto, MessageDto } from '@hrvo/shared';
import { apiFetch } from './api';
import { useAuthStore } from './auth-store';

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');
const enc = encodeURIComponent;
export const chatKeys = {
  channels: ['chat', 'channels'] as const,
  messages: (channelId: string, parentId: string | null) => ['chat', 'messages', channelId, parentId ?? 'top'] as const,
  search: (q: string) => ['chat', 'search', q] as const,
};

export function useChannels() {
  return useQuery({ queryKey: chatKeys.channels, queryFn: () => apiFetch('/channels', { schema: ChannelListSchema }), enabled: useSignedIn() });
}

/** Newest page first; older pages load with `before`. */
export function useMessages(channelId: string | null, parentId: string | null = null) {
  return useInfiniteQuery({
    queryKey: chatKeys.messages(channelId ?? '', parentId),
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: '50' });
      if (pageParam) p.set('before', pageParam);
      if (parentId) p.set('parentId', parentId);
      return apiFetch(`/channels/${enc(channelId!)}/messages?${p.toString()}`, { schema: MessageListSchema });
    },
    initialPageParam: '' as string,
    getNextPageParam: (last) => (last.hasMore && last.items.length ? last.items[0]!.createdAt : undefined),
    enabled: useSignedIn() && !!channelId,
  });
}

function useRefresh() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ['chat'] });
}

export function useCreateChannel() {
  const done = useRefresh();
  return useMutation({ mutationFn: (dto: ChannelCreateDto) => apiFetch('/channels', { method: 'POST', body: dto, schema: z.object({ id: z.string() }) }), onSuccess: done });
}

const Ok = z.object({ ok: z.literal(true) });
export function useChannelAction() {
  const done = useRefresh();
  return useMutation({ mutationFn: ({ id, action }: { id: string; action: 'join' | 'leave' | 'archive' }) => apiFetch(`/channels/${enc(id)}/${action}`, { method: 'POST', schema: Ok }), onSuccess: done });
}

export function useSetMembers(id: string) {
  const done = useRefresh();
  return useMutation({ mutationFn: (dto: MembersDto) => apiFetch(`/channels/${enc(id)}/members`, { method: 'PUT', body: dto, schema: Ok }), onSuccess: done });
}

export function usePostMessage(channelId: string) {
  const done = useRefresh();
  return useMutation({ mutationFn: (dto: MessageDto) => apiFetch(`/channels/${enc(channelId)}/messages`, { method: 'POST', body: dto, schema: MessageSchema }), onSuccess: done });
}

export function useEditMessage() {
  const done = useRefresh();
  return useMutation({ mutationFn: ({ id, body }: { id: string; body: string }) => apiFetch(`/messages/${enc(id)}`, { method: 'PUT', body: { body }, schema: MessageSchema }), onSuccess: done });
}

export function useDeleteMessage() {
  const done = useRefresh();
  return useMutation({ mutationFn: (id: string) => apiFetch(`/messages/${enc(id)}`, { method: 'DELETE', schema: MessageSchema }), onSuccess: done });
}

export function useChatSearch(q: string) {
  return useQuery({ queryKey: chatKeys.search(q), queryFn: () => apiFetch(`/chat/search?q=${enc(q)}`, { schema: ChatSearchSchema }), enabled: useSignedIn() && q.length >= 2 });
}
