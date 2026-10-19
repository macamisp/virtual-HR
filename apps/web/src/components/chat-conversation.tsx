'use client';
import Link from 'next/link';
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AtSign, Paperclip, Smile, X } from 'lucide-react';
import { MAX_MESSAGE_LENGTH, MENTION_PATTERN } from '@hrvo/shared';
import type { ChatMessage } from '@hrvo/shared';
import { PeoplePicker, type PickedPerson } from '@/components/people-picker';
import { EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuthStore } from '@/lib/auth-store';
import { useDeleteMessage, useEditMessage, useMessages, usePostMessage } from '@/lib/chat-queries';
import { useDocuments } from '@/lib/document-queries';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const EMOJI = ['👍', '🎉', '😀', '😂', '❤️', '🙏', '👀', '✅', '🚀', '🤔'];
const author = (m: ChatMessage) => m.author.displayName ?? m.author.email;

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

export function Composer({ channelId, parentId, label }: { channelId: string; parentId: string | null; label: string }) {
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

export function MessageList({ channelId, parentId, onThread }: { channelId: string; parentId: string | null; onThread?: (m: ChatMessage) => void }) {
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

