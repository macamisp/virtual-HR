'use client';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChatEvent } from '@hrvo/shared';
import { Composer, MessageList } from './chat-conversation';
import { ErrorState, LoadingState } from './state-views';
import { useMeetingChat } from '@/lib/meeting-queries';
import { onUiEvent } from '@/lib/ui-socket';

export function MeetingChat({ meetingId }: { meetingId: string }) {
  const chat = useMeetingChat(meetingId);
  const qc = useQueryClient();
  useEffect(() => onUiEvent<ChatEvent>('chat:message', (e) => {
    if (e.channelId === chat.data?.id) void qc.invalidateQueries({ queryKey: ['chat', 'messages', e.channelId] });
  }), [chat.data?.id, qc]);
  return <section role="region" aria-label="Meeting chat" className="space-y-2 rounded border p-3">
    <h2 className="font-medium">Meeting chat</h2>
    {chat.isPending ? <LoadingState label="Loading meeting chat" rows={2} /> : chat.isError ? <ErrorState error={chat.error} onRetry={() => void chat.refetch()} /> : <>
      <MessageList channelId={chat.data.id} parentId={null} />
      <Composer channelId={chat.data.id} parentId={null} label="Message this meeting" />
    </>}
  </section>;
}
