'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, Hash, Lock, MessageSquare, MessagesSquare, Plus, Search, Users, X } from 'lucide-react';
import type { Channel, ChatEvent, ChatMessage } from '@hrvo/shared';
import { PeoplePicker, type PickedPerson } from '@/components/people-picker';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { useAuthStore } from '@/lib/auth-store';
import {
  useChannelAction, useChannels, useChatSearch, useCreateChannel,
} from '@/lib/chat-queries';
import { formatDateTime } from '@/lib/format';
import { Permission, useCan } from '@/lib/permissions';
import { onUiEvent } from '@/lib/ui-socket';
import { Composer, MessageList } from '@/components/chat-conversation';

const author = (m: ChatMessage) => m.author.displayName ?? m.author.email;
const KIND_ICON: Record<Channel['kind'], typeof Hash> = { PUBLIC: Hash, PRIVATE: Lock, GROUP: Users, DM: MessageSquare };

function NewConversation({ onCreated }: { onCreated: (id: string) => void }) {
  const canPublic = useCan(Permission.CHAT_PUBLIC_CHANNELS);
  const me = useAuthStore((s) => s.user?.id);
  const create = useCreateChannel();
  const [kind, setKind] = useState<'DM' | 'GROUP' | 'PUBLIC' | 'PRIVATE'>('DM');
  const [people, setPeople] = useState<PickedPerson[]>([]);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const ids = { k: useId(), n: useId(), t: useId() };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const ok = (r: { id: string }) => onCreated(r.id);
    if (kind === 'DM') { if (people[0]) create.mutate({ kind: 'DM', userId: people[0].id }, { onSuccess: ok }); }
    else if (kind === 'GROUP') create.mutate({ kind: 'GROUP', memberIds: people.map((p) => p.id), ...(name.trim() ? { name: name.trim() } : {}) }, { onSuccess: ok });
    else if (kind === 'PUBLIC') create.mutate({ kind: 'PUBLIC', name, topic }, { onSuccess: ok });
    else create.mutate({ kind: 'PRIVATE', name, topic, memberIds: people.map((p) => p.id) }, { onSuccess: ok });
  };
  return (
    <form className="space-y-2" onSubmit={submit} aria-label="New conversation">
      <div className="space-y-1"><Label htmlFor={ids.k}>Type</Label>
        <NativeSelect id={ids.k} value={kind} onChange={(e) => { setKind(e.target.value as typeof kind); setPeople([]); }}>
          <option value="DM">Direct message</option><option value="GROUP">Group chat</option>{canPublic ? <option value="PUBLIC">Public channel</option> : null}<option value="PRIVATE">Private channel</option>
        </NativeSelect></div>
      {kind === 'PUBLIC' || kind === 'PRIVATE' || kind === 'GROUP' ? <div className="space-y-1"><Label htmlFor={ids.n}>Name{kind === 'GROUP' ? ' (optional)' : ''}</Label><Input id={ids.n} maxLength={60} required={kind !== 'GROUP'} value={name} onChange={(e) => setName(e.target.value)} /></div> : null}
      {kind === 'PUBLIC' || kind === 'PRIVATE' ? <div className="space-y-1"><Label htmlFor={ids.t}>Topic</Label><Input id={ids.t} maxLength={250} value={topic} onChange={(e) => setTopic(e.target.value)} /></div> : null}
      {kind !== 'PUBLIC' ? <PeoplePicker label={kind === 'DM' ? 'Person' : 'Members'} value={people} onChange={setPeople} excludeId={me} max={kind === 'DM' ? 1 : 49} /> : null}
      {create.isError ? <p role="alert" className="text-sm text-destructive">{create.error.message}</p> : null}
      <Button type="submit" size="sm" disabled={create.isPending || (kind === 'DM' && !people.length) || (kind === 'GROUP' && people.length < 2)}>Create</Button>
    </form>
  );
}

function SearchResults({ q, onOpen }: { q: string; onOpen: (channelId: string) => void }) {
  const res = useChatSearch(q);
  if (q.length < 2) return null;
  if (res.isPending) return <LoadingState label="Searching" rows={2} />;
  if (res.isError) return <ErrorState error={res.error} />;
  if (!res.data.items.length) return <p className="text-sm text-muted-foreground">No messages match “{q}”.</p>;
  return (
    <ul className="space-y-1" aria-label="Search results" data-testid="chat-search-results">
      {res.data.items.map((m) => (
        <li key={m.id}><button type="button" className="w-full rounded p-1 text-left text-sm hover:bg-accent" onClick={() => onOpen(m.channelId)}>
          <span className="text-xs text-muted-foreground">{m.channelName} · {author(m)} · {formatDateTime(m.createdAt)}</span><span className="line-clamp-2 block">{m.body}</span>
        </button></li>
      ))}
    </ul>
  );
}

/** FR-MEET-012/013 (ADR 017): channels, DMs, group chats, threads, mentions, search and file sharing. */
export default function ChatPage() {
  const allowed = useCan(Permission.CHAT_USE);
  const qc = useQueryClient();
  const channels = useChannels();
  const action = useChannelAction();
  const [selected, setSelected] = useState<string | null>(null);
  const [thread, setThread] = useState<ChatMessage | null>(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const searchId = useId();

  // Live delivery: refresh the affected channel (and its thread) and the unread counts.
  useEffect(() => onUiEvent<ChatEvent>('chat:message', (e) => {
    void qc.invalidateQueries({ queryKey: ['chat', 'messages', e.channelId] });
    void qc.invalidateQueries({ queryKey: ['chat', 'channels'] });
  }), [qc]);

  const list = useMemo(() => channels.data?.items ?? [], [channels.data]);
  const current = list.find((c) => c.id === selected) ?? null;
  useEffect(() => { if (!selected && list.length) setSelected((list.find((c) => c.isMember) ?? list[0]!).id); }, [selected, list]);
  useEffect(() => setThread(null), [selected]);
  if (!allowed) return <AccessDenied what="Chat" />;

  const groups: Array<{ title: string; items: Channel[] }> = [
    { title: 'Channels', items: list.filter((c) => c.kind === 'PUBLIC' || c.kind === 'PRIVATE') },
    { title: 'Direct messages', items: list.filter((c) => c.kind === 'DM') },
    { title: 'Group chats', items: list.filter((c) => c.kind === 'GROUP') },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Chat</h1>
        <div className="flex items-center gap-2">
          <Label htmlFor={searchId} className="sr-only">Search messages</Label>
          <div className="relative"><Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" /><Input id={searchId} type="search" className="w-56 pl-8" placeholder="Search messages" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <Button size="sm" variant={creating ? 'default' : 'outline'} aria-expanded={creating} onClick={() => setCreating(!creating)}><Plus aria-hidden="true" /> New</Button>
        </div>
      </div>
      {channels.isPending ? <LoadingState label="Loading conversations" rows={4} /> : null}
      {channels.isError ? <ErrorState error={channels.error} onRetry={() => void channels.refetch()} /> : null}
      {channels.data ? (
        <div className={cn('grid gap-3', thread ? 'lg:grid-cols-[16rem_1fr_22rem]' : 'lg:grid-cols-[16rem_1fr]')}>
          <nav aria-label="Conversations" className="space-y-3">
            {creating ? <Card><CardHeader><CardTitle className="text-sm">New conversation</CardTitle></CardHeader><CardContent><NewConversation onCreated={(id) => { setCreating(false); setSelected(id); }} /></CardContent></Card> : null}
            {q.trim().length >= 2 ? <Card><CardHeader><CardTitle className="text-sm">Search</CardTitle></CardHeader><CardContent><SearchResults q={q.trim()} onOpen={(id) => { setSelected(id); setQ(''); }} /></CardContent></Card> : null}
            {!list.length ? <EmptyState title="No conversations yet" description="Start a direct message or create a channel." /> : null}
            {groups.filter((g) => g.items.length).map((g) => (
              <div key={g.title}>
                <p className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.title}</p>
                <ul>
                  {g.items.map((c) => {
                    const Icon = KIND_ICON[c.kind];
                    return (
                      <li key={c.id}>
                        <button type="button" aria-current={c.id === selected ? 'true' : undefined} onClick={() => setSelected(c.id)} data-testid={`channel-${c.name}`}
                          className={cn('flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent', c.id === selected && 'bg-accent font-medium', !c.isMember && 'text-muted-foreground', c.archived && 'line-through')}>
                          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span className="truncate">{c.name}</span>
                          {c.unread ? <Badge className="ml-auto" aria-label={`${c.unread} unread`}>{c.unread}</Badge> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
          <Card className="min-w-0">
            {current ? (
              <>
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
                  <div>
                    <CardTitle className="text-base">{current.kind === 'PUBLIC' ? '#' : ''}{current.name}</CardTitle>
                    <p className="text-xs text-muted-foreground">{current.topic ? `${current.topic} · ` : ''}{current.memberCount} {current.memberCount === 1 ? 'member' : 'members'}{current.archived ? ' · archived' : ''}</p>
                  </div>
                  <div className="flex gap-1">
                    {!current.isMember && current.kind === 'PUBLIC' && !current.archived ? <Button size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: current.id, action: 'join' })}>Join channel</Button> : null}
                    {current.isMember && (current.kind === 'PUBLIC' || current.kind === 'PRIVATE' || current.kind === 'GROUP') ? <Button size="sm" variant="ghost" disabled={action.isPending} onClick={() => action.mutate({ id: current.id, action: 'leave' })}>Leave</Button> : null}
                    {current.canManage && !current.archived && current.kind !== 'DM' ? <Button size="sm" variant="ghost" disabled={action.isPending} onClick={() => { if (window.confirm(`Archive ${current.name}? Nobody can post in it afterwards.`)) action.mutate({ id: current.id, action: 'archive' }); }}><Archive aria-hidden="true" /> Archive</Button> : null}
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  {action.isError ? <p role="alert" className="text-sm text-destructive">{action.error.message}</p> : null}
                  <MessageList channelId={current.id} parentId={null} onThread={setThread} />
                  {current.isMember && !current.archived ? <Composer channelId={current.id} parentId={null} label={`Message ${current.name}`} /> : (
                    <p className="text-sm text-muted-foreground">{current.archived ? 'This conversation is archived.' : 'Join the channel to post.'}</p>
                  )}
                </CardContent>
              </>
            ) : <CardContent className="p-6"><EmptyState title="Pick a conversation" /></CardContent>}
          </Card>
          {thread && current ? (
            <Card aria-label="Thread" data-testid="thread">
              <CardHeader className="flex flex-row items-center justify-between space-y-0"><CardTitle className="flex items-center gap-1 text-sm"><MessagesSquare className="h-4 w-4" aria-hidden="true" /> Thread</CardTitle><Button size="sm" variant="ghost" aria-label="Close the thread" onClick={() => setThread(null)}><X aria-hidden="true" /></Button></CardHeader>
              <CardContent className="space-y-2">
                <MessageList channelId={current.id} parentId={thread.id} />
                {current.isMember && !current.archived ? <Composer channelId={current.id} parentId={thread.id} label="Reply in thread" /> : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
