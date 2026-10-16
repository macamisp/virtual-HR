'use client';

import Link from 'next/link';
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, AtSign, Hash, Lock, MessageSquare, MessagesSquare, Paperclip, Plus, Search, Smile, Users, X } from 'lucide-react';
import { MAX_MESSAGE_LENGTH, MENTION_PATTERN } from '@hrvo/shared';
import type { Channel, ChatEvent, ChatMessage } from '@hrvo/shared';
import { PeoplePicker, type PickedPerson } from '@/components/people-picker';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAuthStore } from '@/lib/auth-store';
import {
  useChannelAction, useChannels, useChatSearch, useCreateChannel, useDeleteMessage, useEditMessage, useMessages, usePostMessage,
} from '@/lib/chat-queries';
import { useDocuments } from '@/lib/document-queries';
import { formatDateTime } from '@/lib/format';
import { Permission, useCan } from '@/lib/permissions';
import { onUiEvent } from '@/lib/ui-socket';
import { cn } from '@/lib/utils';

const EMOJI = ['👍', '🎉', '😀', '😂', '❤️', '🙏', '👀', '✅', '🚀', '🤔'];
const author = (m: ChatMessage) => m.author.displayName ?? m.author.email;
const KIND_ICON: Record<Channel['kind'], typeof Hash> = { PUBLIC: Hash, PRIVATE: Lock, GROUP: Users, DM: MessageSquare };

/** Plain text with @mentions highlighted; never rendered as HTML. */
function Body({ text, me }: { text: string; me: string | undefined }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(MENTION_PATTERN.source, 'g'))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<span key={m.index} className={cn('rounded px-0.5 font-medium text-primary', m[2] === me && 'bg-yellow-100')}>@{m[1]}</span>);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <p className="whitespace-pre-wrap break-words">{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</p>;
}

function MessageItem({ m, onThread, inThread }: { m: ChatMessage; onThread?: () => void; inThread?: boolean }) {
  const me = useAuthStore((s) => s.user?.id);
  const edit = useEditMessage();
  const del = useDeleteMessage();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.body);
  return (
    <li className="group rounded px-2 py-1 hover:bg-accent/40" data-testid="chat-message">
      <div className="flex items-baseline gap-2 text-xs text-muted-foreground"><span className="font-semibold text-foreground">{author(m)}</span><time dateTime={m.createdAt}>{formatDateTime(m.createdAt)}</time>{m.editedAt ? <span>(edited)</span> : null}</div>
      {m.deleted ? <p className="text-sm italic text-muted-foreground">Message deleted</p> : editing ? (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); edit.mutate({ id: m.id, body: text }, { onSuccess: () => setEditing(false) }); }}>
          <Input aria-label="Edit message" value={text} maxLength={MAX_MESSAGE_LENGTH} onChange={(e) => setText(e.target.value)} />
          <Button size="sm" type="submit" disabled={edit.isPending || !text.trim()}>Save</Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
        </form>
      ) : <div className="text-sm"><Body text={m.body} me={me} /></div>}
      {m.attachment && !m.deleted ? (
        <Link href={`/documents/${m.attachment.documentId}`} className="mt-1 inline-flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-accent" data-testid="chat-attachment">
          <Paperclip className="h-3 w-3" aria-hidden="true" /> {m.attachment.title}{m.attachment.sizeBytes ? ` · ${Math.ceil(m.attachment.sizeBytes / 1024)} KB` : ''}
        </Link>
      ) : null}
      <div className="flex gap-2 text-xs">
        {!inThread && onThread ? <button type="button" className="text-primary hover:underline" onClick={onThread}>{m.replyCount ? `${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}` : 'Reply in thread'}</button> : null}
        {m.author.id === me && !m.deleted ? (
          <span className="hidden gap-2 group-focus-within:flex group-hover:flex">
            <button type="button" className="hover:underline" onClick={() => { setText(m.body); setEditing(true); }}>Edit</button>
            <button type="button" className="text-destructive hover:underline" onClick={() => { if (window.confirm('Delete this message?')) del.mutate(m.id); }}>Delete</button>
          </span>
        ) : null}
      </div>
    </li>
  );
}

/** FR-MEET-013: pick a document you manage; the server checks it is scanned clean and shares it with the channel. */
function AttachPicker({ onPick, onClose }: { onPick: (d: { id: string; title: string }) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const docs = useDocuments({ q: q.trim() || undefined });
  const id = useId();
  return (
    <div className="space-y-2 rounded border p-2" role="dialog" aria-label="Share a document">
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1"><Label htmlFor={id}>Share a document</Label><Input id={id} type="search" autoFocus value={q} placeholder="Search your documents" onChange={(e) => setQ(e.target.value)} /></div>
        <Button size="sm" variant="ghost" aria-label="Close" onClick={onClose}><X aria-hidden="true" /></Button>
      </div>
      {docs.isPending ? <LoadingState label="Loading documents" rows={2} /> : null}
      {docs.isError ? <ErrorState error={docs.error} /> : null}
      {docs.data && !docs.data.items.length ? <p className="text-sm text-muted-foreground">No documents. <Link className="underline" href="/documents">Upload one first</Link>.</p> : null}
      <ul className="max-h-48 overflow-auto">
        {docs.data?.items.slice(0, 20).map((d) => (
          <li key={d.id}>
            <Button type="button" size="sm" variant="ghost" className="w-full justify-start" disabled={d.latestStatus !== 'CLEAN'} onClick={() => onPick({ id: d.id, title: d.title })}>
              {d.title} {d.latestStatus !== 'CLEAN' ? <span className="text-xs text-muted-foreground">({d.latestStatus === 'PENDING' ? 'still being scanned' : 'not available'})</span> : null}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Composer({ channelId, parentId, label }: { channelId: string; parentId: string | null; label: string }) {
  const post = usePostMessage(channelId);
  const [text, setText] = useState('');
  const [doc, setDoc] = useState<{ id: string; title: string } | null>(null);
  const [panel, setPanel] = useState<'none' | 'emoji' | 'mention' | 'attach'>('none');
  const [mention, setMention] = useState<PickedPerson[]>([]);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const id = useId();
  const insert = (s: string) => {
    const el = area.current;
    const at = el?.selectionStart ?? text.length;
    setText(text.slice(0, at) + s + text.slice(at));
    setPanel('none');
    requestAnimationFrame(() => el?.focus());
  };
  useEffect(() => {
    const p = mention[0];
    if (p) { insert(`@[${p.name.replace(/[[\]]/g, '')}](user:${p.id}) `); setMention([]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mention]);
  const send = () => {
    if (!text.trim() && !doc) return;
    post.mutate({ body: text.trim(), parentId, documentId: doc?.id ?? null }, { onSuccess: () => { setText(''); setDoc(null); } });
  };
  return (
    <form className="space-y-2 border-t pt-2" aria-label={label} onSubmit={(e) => { e.preventDefault(); send(); }}>
      <Label htmlFor={id} className="sr-only">{label}</Label>
      <Textarea id={id} ref={area} rows={2} maxLength={MAX_MESSAGE_LENGTH} value={text} placeholder="Write a message. Enter sends, Shift+Enter adds a line."
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
      {doc ? <Badge variant="secondary" className="gap-1"><Paperclip className="h-3 w-3" aria-hidden="true" /> {doc.title}<button type="button" aria-label="Remove the attachment" onClick={() => setDoc(null)}><X className="h-3 w-3" aria-hidden="true" /></button></Badge> : null}
      {panel === 'emoji' ? <div role="group" aria-label="Emoji" className="flex flex-wrap gap-1">{EMOJI.map((e) => <Button key={e} type="button" size="sm" variant="ghost" aria-label={`Insert ${e}`} onClick={() => insert(e)}>{e}</Button>)}</div> : null}
      {panel === 'mention' ? <PeoplePicker label="Mention someone" value={mention} onChange={setMention} max={1} /> : null}
      {panel === 'attach' ? <AttachPicker onClose={() => setPanel('none')} onPick={(d) => { setDoc(d); setPanel('none'); }} /> : null}
      <div className="flex items-center gap-1">
        <Button type="button" size="sm" variant="ghost" aria-label="Emoji" aria-expanded={panel === 'emoji'} onClick={() => setPanel(panel === 'emoji' ? 'none' : 'emoji')}><Smile aria-hidden="true" /></Button>
        <Button type="button" size="sm" variant="ghost" aria-label="Mention someone" aria-expanded={panel === 'mention'} onClick={() => setPanel(panel === 'mention' ? 'none' : 'mention')}><AtSign aria-hidden="true" /></Button>
        <Button type="button" size="sm" variant="ghost" aria-label="Share a document" aria-expanded={panel === 'attach'} onClick={() => setPanel(panel === 'attach' ? 'none' : 'attach')}><Paperclip aria-hidden="true" /></Button>
        {post.isError ? <span role="alert" className="text-xs text-destructive">{post.error.message}</span> : null}
        <Button type="submit" size="sm" className="ml-auto" disabled={post.isPending || (!text.trim() && !doc)}>Send</Button>
      </div>
    </form>
  );
}

function MessageList({ channelId, parentId, onThread }: { channelId: string; parentId: string | null; onThread?: (m: ChatMessage) => void }) {
  const msgs = useMessages(channelId, parentId);
  const end = useRef<HTMLDivElement | null>(null);
  // Pages arrive newest first; each page is oldest-to-newest inside.
  const items = useMemo(() => (msgs.data ? (parentId ? msgs.data.pages.flatMap((p) => p.items) : [...msgs.data.pages].reverse().flatMap((p) => p.items)) : []), [msgs.data, parentId]);
  const lastId = items[items.length - 1]?.id;
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [lastId]);
  if (msgs.isPending) return <LoadingState label="Loading messages" rows={3} />;
  if (msgs.isError) return <ErrorState error={msgs.error} onRetry={() => void msgs.refetch()} />;
  return (
    <div className="max-h-[calc(100vh-22rem)] min-h-48 overflow-auto" aria-live="polite">
      {!parentId && msgs.hasNextPage ? <Button size="sm" variant="ghost" disabled={msgs.isFetchingNextPage} onClick={() => void msgs.fetchNextPage()}>{msgs.isFetchingNextPage ? 'Loading…' : 'Load older messages'}</Button> : null}
      {!items.length ? <EmptyState title="No messages yet" description="Say hello." /> : (
        <ul className="space-y-1" aria-label="Messages">
          {items.map((m) => <MessageItem key={m.id} m={m} inThread={!!parentId} onThread={onThread ? () => onThread(m) : undefined} />)}
        </ul>
      )}
      <div ref={end} />
    </div>
  );
}

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
