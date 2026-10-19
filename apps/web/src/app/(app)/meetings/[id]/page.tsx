'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, use, useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, ListTodo, MessagesSquare, MicOff, PhoneOff, UserMinus, Users } from 'lucide-react';
import type { CallState, Meeting } from '@hrvo/shared';
import { MeetingChat } from '@/components/meeting-chat';
import { CallView, useSession } from '@/components/media/call-view';
import { PreJoin } from '@/components/media/prejoin';
import { ConsentNotice, InCallConsent, RecordControls, RecordingBanner, RecordingsCard } from '@/components/media/recording-ui';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Markdown } from '@/components/markdown';
import { ApiError } from '@/lib/api';
import { formatDateTime, formatDuration } from '@/lib/format';
import type { DevicePrefs } from '@/lib/media/devices';
import { MediaSession } from '@/lib/media/media-session';
import {
  downloadIcs, joinMeeting, meetingKeys, useAddActionItem, useCancelMeeting, useConvertToTask, useLobby, useLobbyDecision,
  useCallResponses, useCancelCalls, useMeeting, useMuteAll, useRemoveParticipant, useRespond, useUpdateMeeting,
} from '@/lib/meeting-queries';
import { Permission, useCan } from '@/lib/permissions';
import { onUiEvent } from '@/lib/ui-socket';
import { answerRecording, recordingKeys } from '@/lib/recording-queries';

type Phase = 'idle' | 'prejoin' | 'joining' | 'waiting' | 'denied' | 'consent' | 'call';
const name = (p: { displayName: string | null; email: string }) => p.displayName ?? p.email;

/** FR-MEET-005: hosts and co-hosts admit or decline people waiting in the lobby. */
function LobbyPanel({ meetingId }: { meetingId: string }) {
  const qc = useQueryClient();
  const lobby = useLobby(meetingId, true);
  const decide = useLobbyDecision(meetingId);
  useEffect(() => onUiEvent<{ meetingId: string }>('meeting:lobby', (e) => { if (e.meetingId === meetingId) void qc.invalidateQueries({ queryKey: meetingKeys.lobby(meetingId) }); }), [meetingId, qc]);
  if (lobby.isError) return <ErrorState error={lobby.error} onRetry={() => void lobby.refetch()} />;
  if (!lobby.data?.items.length) return null;
  return (
    <Alert data-testid="lobby">
      <AlertDescription className="space-y-1">
        <p className="font-medium">Waiting in the lobby</p>
        <ul className="space-y-1">
          {lobby.data.items.map((e) => (
            <li key={e.userId} className="flex flex-wrap items-center gap-2">
              {name(e)}
              <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ userId: e.userId, admit: true })}>Admit</Button>
              <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate({ userId: e.userId, admit: false })}>Decline</Button>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/** FR-MEET-005: host controls (mute everyone, remove a participant); FR-MEET-007 recording. */
function HostControls({ meetingId, session, meeting }: { meetingId: string; session: MediaSession; meeting: CallMeeting }) {
  useSession(session);
  const muteAll = useMuteAll(meetingId);
  const remove = useRemoveParticipant(meetingId);
  const [who, setWho] = useState('');
  const id = useId();
  const others = session.tiles().filter((t) => !t.isLocal);
  return (
    <>
      <RecordControls meetingId={meetingId} recording={meeting.recording} canRecord={meeting.canRecord} />
      <Button size="sm" variant="outline" disabled={muteAll.isPending} onClick={() => muteAll.mutate()}><MicOff aria-hidden="true" /> Mute all</Button>
      {others.length ? (
        <span className="flex items-center gap-1">
          <Label htmlFor={id} className="sr-only">Participant to remove</Label>
          <NativeSelect id={id} value={who} onChange={(e) => setWho(e.target.value)} className="h-8"><option value="">Remove…</option>{others.map((t) => <option key={t.identity} value={t.identity}>{t.name}</option>)}</NativeSelect>
          <Button size="sm" variant="outline" disabled={!who || remove.isPending} onClick={() => remove.mutate(who, { onSuccess: () => setWho('') })}><UserMinus aria-hidden="true" /> Remove</Button>
        </span>
      ) : null}
      {muteAll.isError || remove.isError ? <span role="alert" className="text-xs text-destructive">{(muteAll.error ?? remove.error)?.message}</span> : null}
    </>
  );
}

/** Join flow: pre-join device check, then READY / lobby WAITING / DENIED, then the call. */
type CallMeeting = Pick<Meeting, 'id' | 'title' | 'status' | 'type' | 'myRole' | 'recording' | 'canRecord'>;

/** FR-MEET-005: the meeting chat toggle; inside the call controls during a call, above the call otherwise. */
function ChatToggle({ chat }: { chat: { open: boolean; toggle: () => void } }) {
  return <Button size="sm" variant={chat.open ? 'default' : 'outline'} aria-pressed={chat.open} onClick={chat.toggle}><MessagesSquare aria-hidden="true" /> Chat</Button>;
}

const CALL_STATE_LABEL: Record<CallState['state'], string> = {
  RINGING: 'Ringing…', ACCEPTED: 'Accepted', DECLINED: 'Declined', MISSED: 'Missed (no answer)', BUSY: 'Busy in another call', CANCELLED: 'Cancelled',
};

/** FR-VO-008: the caller sees each person's answer as it comes in, and can stop ringing. */
function CallResponses({ meetingId }: { meetingId: string }) {
  const calls = useCallResponses(meetingId);
  const cancel = useCancelCalls(meetingId);
  const items = calls.data?.items ?? [];
  if (!items.length) return null;
  const ringing = items.some((c) => c.state === 'RINGING');
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border p-2 text-sm" data-testid="call-responses" aria-live="polite">
      <span className="font-medium">Call:</span>
      {items.map((c) => (
        <Badge key={c.userId} variant={c.state === 'ACCEPTED' ? 'success' : c.state === 'RINGING' ? 'secondary' : 'outline'}>{c.name}: {CALL_STATE_LABEL[c.state]}</Badge>
      ))}
      {ringing ? <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate()}><PhoneOff aria-hidden="true" /> Cancel call</Button> : null}
      {cancel.isError ? <span role="alert" className="text-destructive">{cancel.error.message}</span> : null}
    </div>
  );
}

function MeetingCall({ meeting, autoStart, onChange, chat }: { meeting: CallMeeting; autoStart: boolean; onChange?: () => void; chat?: { open: boolean; toggle: () => void } }) {
  const [phase, setPhase] = useState<Phase>(autoStart ? 'prejoin' : 'idle');
  const [message, setMessage] = useState<string | null>(null);
  const [session] = useState(() => new MediaSession());
  const prefs = useRef<DevicePrefs | null>(null);
  const moderator = meeting.myRole === 'HOST' || meeting.myRole === 'COHOST';
  const qc = useQueryClient();
  const [consentFor, setConsentFor] = useState<string | null>(null);
  const [answering, setAnswering] = useState(false);

  const attempt = async () => {
    setPhase('joining');
    setMessage(null);
    try {
      const r = await joinMeeting(meeting.id);
      if (r.status === 'READY') {
        setPhase('call');
        onChange?.();
        await session.connect(r.token, prefs.current!);
      } else if (r.status === 'CONSENT_REQUIRED') {
        // FR-MEET-007: the call is being recorded; nobody joins without agreeing first.
        setConsentFor(r.recordingId);
        setPhase('consent');
      } else {
        setMessage(r.message);
        setPhase(r.status === 'WAITING' ? 'waiting' : 'denied');
        if (r.status === 'WAITING') onChange?.();
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not join');
      setPhase('denied');
    }
  };

  useEffect(() => {
    const offDecision = onUiEvent<{ meetingId: string; admit: boolean }>('meeting:lobby-decision', (e) => {
      if (e.meetingId !== meeting.id) return;
      if (e.admit) void attempt(); else { setMessage('The host did not let you in.'); setPhase('denied'); }
    });
    const offRemoved = onUiEvent<{ meetingId: string; reason?: string }>('meeting:removed', (e) => {
      if (e.meetingId !== meeting.id) return;
      void session.disconnect();
      setMessage(e.reason === 'RECORDING_CONSENT' ? 'This meeting is being recorded and you had not agreed. Join again to answer.' : 'You were removed by the host.');
      setPhase('denied');
    });
    // FR-MEET-007: recording requests and state changes refresh the banner and the list.
    const refresh = (e: { meetingId: string }) => {
      if (e.meetingId !== meeting.id) return;
      onChange?.();
      void qc.invalidateQueries({ queryKey: recordingKeys.list(meeting.id) });
    };
    const offRec = onUiEvent<{ meetingId: string }>('meeting:recording', refresh);
    const offAsk = onUiEvent<{ meetingId: string }>('meeting:recording-consent', refresh);
    return () => { offDecision(); offRemoved(); offRec(); offAsk(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting.id]);
  useEffect(() => () => { void session.disconnect(); }, [session]);

  if (meeting.status === 'CANCELLED') return <Alert><AlertDescription>This meeting was cancelled.</AlertDescription></Alert>;
  if (meeting.type === 'ROOM') return <Alert><AlertDescription>This is a room meeting. <Link className="underline" href="/office">Walk into the room in the office</Link> to join.</AlertDescription></Alert>;
  return (
    <div className="space-y-3">
      <RecordingBanner recording={meeting.recording} />
      {phase === 'call' ? <InCallConsent meetingId={meeting.id} recording={meeting.recording} /> : null}
      {moderator && phase === 'call' ? <LobbyPanel meetingId={meeting.id} /> : null}
      {phase === 'consent' && consentFor ? (
        <ConsentNotice joining busy={answering} error={message} onAnswer={(granted) => {
          setAnswering(true);
          setMessage(null);
          answerRecording(consentFor, granted)
            .then(() => { if (granted) void attempt(); else { setPhase('idle'); } })
            .catch((e: unknown) => setMessage(e instanceof Error ? e.message : 'Could not save your answer'))
            .finally(() => setAnswering(false));
        }} />
      ) : null}
      {chat && phase !== 'call' ? <div><ChatToggle chat={chat} /></div> : null}
      {phase === 'idle' ? <Button onClick={() => setPhase('prejoin')}>{meeting.myRole === 'NONE' ? 'Ask to join' : 'Join meeting'}</Button> : null}
      {phase === 'prejoin' ? <PreJoin title={`Join “${meeting.title}”`} onCancel={() => setPhase('idle')} onJoin={(p) => { prefs.current = p; void attempt(); }} /> : null}
      {phase === 'joining' ? <p role="status" className="text-sm text-muted-foreground">Joining…</p> : null}
      {phase === 'waiting' ? (
        <Alert data-testid="lobby-waiting"><AlertDescription className="flex flex-wrap items-center gap-2">{message} <Button size="sm" variant="ghost" onClick={() => setPhase('idle')}>Leave the lobby</Button></AlertDescription></Alert>
      ) : null}
      {phase === 'denied' ? <Alert variant="destructive" data-testid="join-denied"><AlertDescription>{message}</AlertDescription></Alert> : null}
      {phase === 'call' ? (
        <CallView session={session} onLeave={() => { void session.disconnect(); setPhase('idle'); }}
          extraControls={<>{moderator ? <HostControls meetingId={meeting.id} session={session} meeting={meeting} /> : null}{chat ? <ChatToggle chat={chat} /> : null}</>} />
      ) : null}
    </div>
  );
}

/** FR-MEET-008: shared notes (anyone in the meeting), saved with an optimistic version check. */
function Notes({ meeting }: { meeting: Meeting }) {
  const update = useUpdateMeeting(meeting.id);
  const [text, setText] = useState(meeting.notes);
  const [editing, setEditing] = useState(false);
  const id = useId();
  useEffect(() => { if (!editing) setText(meeting.notes); }, [meeting.notes, editing]);
  if (!editing) {
    return (
      <div className="space-y-2">
        {meeting.notes ? <Markdown source={meeting.notes} /> : <p className="text-sm text-muted-foreground">No notes yet.</p>}
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit notes</Button>
      </div>
    );
  }
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); update.mutate({ notes: text, version: meeting.version }, { onSuccess: () => setEditing(false) }); }}>
      <Label htmlFor={id}>Notes (Markdown)</Label>
      <Textarea id={id} rows={8} maxLength={50_000} value={text} onChange={(e) => setText(e.target.value)} />
      {update.isError ? <p role="alert" className="text-sm text-destructive">{update.error.message}</p> : null}
      <div className="flex gap-2"><Button size="sm" type="submit" disabled={update.isPending}>Save notes</Button><Button size="sm" type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button></div>
    </form>
  );
}

/** FR-MEET-008: action items, each convertible into a task (normal task assignment rules apply). */
function ActionItems({ meeting }: { meeting: Meeting }) {
  const add = useAddActionItem(meeting.id);
  const convert = useConvertToTask(meeting.id);
  const [text, setText] = useState('');
  const [assignee, setAssignee] = useState('');
  const [due, setDue] = useState('');
  const ids = { t: useId(), a: useId(), d: useId() };
  const people = [{ id: meeting.host.id, label: name(meeting.host) }, ...meeting.attendees.filter((a) => a.id !== meeting.host.id).map((a) => ({ id: a.id, label: name(a) }))];
  return (
    <div className="space-y-3">
      {meeting.actionItems.length ? (
        <ul className="space-y-1" data-testid="action-items">
          {meeting.actionItems.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2">
              <div><span>{i.text}</span><div className="text-xs text-muted-foreground">{i.assignee ? name(i.assignee) : 'Unassigned'}{i.dueDate ? ` · due ${i.dueDate}` : ''}</div></div>
              {i.taskId ? <Link className="text-sm underline" href={`/tasks/${i.taskId}`}>Open task</Link>
                : <Button size="sm" variant="outline" disabled={convert.isPending} onClick={() => convert.mutate(i.id)}><ListTodo aria-hidden="true" /> Make a task</Button>}
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted-foreground">No action items yet.</p>}
      {convert.isError ? <p role="alert" className="text-sm text-destructive">{convert.error.message}</p> : null}
      <form className="flex flex-wrap items-end gap-2" aria-label="Add an action item" onSubmit={(e) => { e.preventDefault(); add.mutate({ text, assigneeId: assignee || null, dueDate: due || null }, { onSuccess: () => { setText(''); setAssignee(''); setDue(''); } }); }}>
        <div className="min-w-48 flex-1 space-y-1"><Label htmlFor={ids.t}>Action item</Label><Input id={ids.t} required maxLength={500} value={text} onChange={(e) => setText(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor={ids.a}>Owner</Label><NativeSelect id={ids.a} value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">Unassigned</option>{people.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</NativeSelect></div>
        <div className="space-y-1"><Label htmlFor={ids.d}>Due</Label><Input id={ids.d} type="date" value={due} onChange={(e) => setDue(e.target.value)} /></div>
        <Button type="submit" size="sm" disabled={add.isPending || !text.trim()}>Add</Button>
      </form>
      {add.isError ? <p role="alert" className="text-sm text-destructive">{add.error.message}</p> : null}
    </div>
  );
}

function Details({ meeting }: { meeting: Meeting }) {
  const respond = useRespond(meeting.id);
  const cancel = useCancelMeeting(meeting.id);
  const [icsError, setIcsError] = useState<string | null>(null);
  const mine = meeting.myRole === 'ATTENDEE' || meeting.myRole === 'COHOST';
  return (
    <div className="space-y-3 text-sm">
      <p>{meeting.type === 'SCHEDULED' ? `${formatDateTime(meeting.scheduledStart)} – ${formatDateTime(meeting.scheduledEnd)}` : meeting.type === 'INSTANT' ? 'Instant call' : 'Room meeting'}{meeting.recurrence ? ` · repeats (${meeting.recurrence})` : ''}{meeting.lobby ? ' · lobby on' : ''}</p>
      {meeting.agenda ? <Markdown source={meeting.agenda} /> : null}
      <div>
        <p className="font-medium"><Users className="inline h-4 w-4" aria-hidden="true" /> People</p>
        <ul className="text-muted-foreground">
          <li>{name(meeting.host)} (host)</li>
          {meeting.attendees.filter((a) => a.role !== 'HOST').map((a) => <li key={a.id}>{name(a)}{a.role === 'COHOST' ? ' (co-host)' : ''} · {a.response === 'ACCEPTED' ? 'accepted' : a.response === 'DECLINED' ? 'declined' : 'no reply'}</li>)}
        </ul>
      </div>
      <div className="flex flex-wrap gap-2">
        {meeting.type === 'SCHEDULED' && mine ? (
          <>
            <Button size="sm" variant="outline" disabled={respond.isPending} onClick={() => respond.mutate(true)}>Accept</Button>
            <Button size="sm" variant="outline" disabled={respond.isPending} onClick={() => respond.mutate(false)}>Decline</Button>
          </>
        ) : null}
        {meeting.type === 'SCHEDULED' ? <Button size="sm" variant="outline" onClick={() => { setIcsError(null); downloadIcs(meeting.id).catch((e: unknown) => setIcsError(e instanceof Error ? e.message : 'Download failed')); }}><CalendarPlus aria-hidden="true" /> Add to calendar (.ics)</Button> : null}
        {meeting.canEdit && meeting.status !== 'CANCELLED' && meeting.status !== 'ENDED' ? <Button size="sm" variant="destructive" disabled={cancel.isPending} onClick={() => { if (window.confirm('Cancel this meeting for everyone?')) cancel.mutate(); }}>Cancel meeting</Button> : null}
      </div>
      {respond.isError || cancel.isError || icsError ? <p role="alert" className="text-destructive">{icsError ?? (respond.error ?? cancel.error)?.message}</p> : null}
      {meeting.participants.length ? (
        <div>
          <p className="font-medium">Attendance</p>
          <ul className="text-muted-foreground">{meeting.participants.map((p, i) => <li key={`${p.id}-${i}`}>{name(p)} · {formatDateTime(p.joinedAt)}{p.leftAt ? ` · ${formatDuration(p.durationSeconds)}` : ' · in the call'}</li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}

function MeetingPage({ id }: { id: string }) {
  const allowed = useCan(Permission.MEETINGS_USE);
  const params = useSearchParams();
  const meeting = useMeeting(id);
  // Sticky: once in ask-to-join mode, a later successful refetch must not unmount a running call.
  const [ask, setAsk] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const notFound = meeting.error instanceof ApiError && meeting.error.status === 404;
  useEffect(() => { if (notFound) setAsk(true); }, [notFound]);
  if (!allowed) return <AccessDenied what="Meetings" />;
  if (ask || notFound) {
    // Not invited: a shared link still lets you ask to join; the host admits you from the lobby (FR-MEET-005).
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">Join a meeting</h1>
        <p className="text-sm text-muted-foreground">You were not invited to this meeting. You can ask to join; a host decides whether to let you in.</p>
        <MeetingCall meeting={{ id, title: 'this meeting', status: 'SCHEDULED', type: 'INSTANT', myRole: 'NONE', recording: null, canRecord: false }} autoStart={params.get('join') === '1'} />
      </div>
    );
  }
  if (meeting.isPending) return <LoadingState label="Loading the meeting" rows={4} />;
  if (meeting.isError) return <ErrorState error={meeting.error} onRetry={() => void meeting.refetch()} />;
  const m = meeting.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold">{m.title}</h1>
        {m.status === 'LIVE' ? <Badge variant="success">Live</Badge> : m.status === 'CANCELLED' ? <Badge variant="destructive">Cancelled</Badge> : m.status === 'ENDED' ? <Badge variant="secondary">Ended</Badge> : null}
        <Link href="/meetings" className="ml-auto text-sm underline">All meetings</Link>
      </div>
      {m.type === 'INSTANT' && m.myRole === 'HOST' ? <CallResponses meetingId={m.id} /> : null}
      <MeetingCall meeting={m} autoStart={params.get('join') === '1'} onChange={() => void meeting.refetch()}
        chat={m.type !== 'ROOM' && m.status !== 'CANCELLED' ? { open: chatOpen, toggle: () => setChatOpen((o) => !o) } : undefined} />
      {chatOpen && m.type !== 'ROOM' ? <MeetingChat meetingId={m.id} /> : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card><CardHeader><CardTitle className="text-base">Details</CardTitle></CardHeader><CardContent><Details meeting={m} /></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Notes</CardTitle></CardHeader><CardContent><Notes meeting={m} /></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Action items</CardTitle></CardHeader><CardContent><ActionItems meeting={m} /></CardContent></Card>
      </div>
      {m.type !== 'ROOM' ? <RecordingsCard meetingId={m.id} /> : null}
      {m.status === 'ENDED' && !m.participants.length ? <EmptyState title="Nobody joined this meeting" /> : null}
    </div>
  );
}

export default function MeetingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Suspense><MeetingPage id={id} /></Suspense>;
}
