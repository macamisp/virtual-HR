'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { CalendarPlus, PhoneCall, Repeat } from 'lucide-react';
import type { MeetingCreateDto } from '@hrvo/shared';
import { PeoplePicker, type PickedPerson } from '@/components/people-picker';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime } from '@/lib/format';
import { useCreateMeeting, useMeetings } from '@/lib/meeting-queries';
import { useBusy } from '@/lib/calendar-queries';
import { Permission, useCan } from '@/lib/permissions';
import { useAuthStore } from '@/lib/auth-store';

type Scope = 'upcoming' | 'live' | 'past';
const SCOPE_LABEL: Record<Scope, string> = { upcoming: 'Upcoming', live: 'Live now', past: 'Past' };
const pad = (n: number) => String(n).padStart(2, '0');
/** A local datetime-local value, rounded up to the next half hour. */
function nextSlot(offsetMin = 0): string {
  const d = new Date(Date.now() + offsetMin * 60_000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** FR-MEET-006: who is busy in the chosen slot, from their connected calendars (times only). */
function BusyHint({ people, start, minutes }: { people: PickedPerson[]; start: string; minutes: number }) {
  const from = start ? new Date(start) : null;
  const valid = from && !Number.isNaN(from.getTime());
  const busy = useBusy(people.map((p) => p.id), valid ? from.toISOString() : null, valid ? new Date(from.getTime() + minutes * 60_000).toISOString() : null);
  const names = [...new Set((busy.data?.items ?? []).map((b) => people.find((p) => p.id === b.userId)?.name).filter(Boolean))];
  if (!names.length) return null;
  return <p role="status" className="text-sm text-amber-700 dark:text-amber-400" data-testid="busy-hint">Busy at this time (from their calendar): {names.join(', ')}.</p>;
}

/** FR-MEET-002/003: schedule a meeting with attendees, co-hosts, recurrence and a lobby. */
function ScheduleForm({ onDone }: { onDone: (id: string) => void }) {
  const create = useCreateMeeting();
  const me = useAuthStore((s) => s.user?.id);
  const [title, setTitle] = useState('');
  const [agenda, setAgenda] = useState('');
  const [start, setStart] = useState(() => nextSlot());
  const [minutes, setMinutes] = useState('30');
  const [attendees, setAttendees] = useState<PickedPerson[]>([]);
  const [cohosts, setCohosts] = useState<PickedPerson[]>([]);
  const [freq, setFreq] = useState<'' | 'DAILY' | 'WEEKLY' | 'MONTHLY'>('');
  const [count, setCount] = useState('10');
  const [lobby, setLobby] = useState(true);
  const ids = { t: useId(), a: useId(), s: useId(), m: useId(), f: useId(), c: useId() };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const s = new Date(start);
    const dto: MeetingCreateDto = {
      type: 'SCHEDULED', title, agenda, start: s.toISOString(), end: new Date(s.getTime() + Number(minutes) * 60_000).toISOString(),
      attendeeIds: [...new Set([...attendees, ...cohosts].map((p) => p.id))], cohostIds: cohosts.map((p) => p.id), lobby,
      recurrence: freq ? { freq, interval: 1, count: Number(count) } : null, sendInvites: true,
    };
    create.mutate(dto, { onSuccess: (m) => onDone(m.id) });
  };
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Schedule a meeting">
      <div className="space-y-1"><Label htmlFor={ids.t}>Title</Label><Input id={ids.t} required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
      <div className="space-y-1"><Label htmlFor={ids.a}>Agenda</Label><Textarea id={ids.a} rows={3} maxLength={10_000} value={agenda} onChange={(e) => setAgenda(e.target.value)} /></div>
      <div className="flex flex-wrap gap-3">
        <div className="space-y-1"><Label htmlFor={ids.s}>Starts</Label><Input id={ids.s} type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor={ids.m}>Length</Label>
          <NativeSelect id={ids.m} value={minutes} onChange={(e) => setMinutes(e.target.value)}>{[15, 30, 45, 60, 90, 120, 180].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`}</option>)}</NativeSelect></div>
        <div className="space-y-1"><Label htmlFor={ids.f}>Repeats</Label>
          <NativeSelect id={ids.f} value={freq} onChange={(e) => setFreq(e.target.value as typeof freq)}><option value="">Does not repeat</option><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option></NativeSelect></div>
        {freq ? <div className="space-y-1"><Label htmlFor={ids.c}>Occurrences</Label><Input id={ids.c} type="number" min={1} max={100} className="w-24" value={count} onChange={(e) => setCount(e.target.value)} /></div> : null}
      </div>
      <PeoplePicker label="Attendees" value={attendees} onChange={setAttendees} excludeId={me} />
      <BusyHint people={[...attendees, ...cohosts]} start={start} minutes={Number(minutes)} />
      <PeoplePicker label="Co-hosts" value={cohosts} onChange={setCohosts} excludeId={me} max={10} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={lobby} onChange={(e) => setLobby(e.target.checked)} /> Lobby: people who were not invited wait until a host lets them in</label>
      <p className="text-xs text-muted-foreground">Attendees receive an email with a calendar invite (.ics).</p>
      {create.isError ? <p role="alert" className="text-sm text-destructive">{create.error.message}</p> : null}
      <Button type="submit" disabled={create.isPending || !title.trim()}><CalendarPlus aria-hidden="true" /> {create.isPending ? 'Scheduling…' : 'Schedule'}</Button>
    </form>
  );
}

/** FR-MEET-001: an instant call with chosen colleagues (they get a ring). */
function InstantCall({ onDone }: { onDone: (id: string) => void }) {
  const create = useCreateMeeting();
  const me = useAuthStore((s) => s.user?.id);
  const [people, setPeople] = useState<PickedPerson[]>([]);
  return (
    <div className="space-y-2">
      <PeoplePicker label="Call" value={people} onChange={setPeople} excludeId={me} />
      {create.isError ? <p role="alert" className="text-sm text-destructive">{create.error.message}</p> : null}
      <Button disabled={create.isPending} onClick={() => create.mutate({ type: 'INSTANT', title: people.length ? `Call with ${people.map((p) => p.name).join(', ')}` : 'Instant call', attendeeIds: people.map((p) => p.id), lobby: true, sendInvites: false }, { onSuccess: (m) => onDone(m.id) })}>
        <PhoneCall aria-hidden="true" /> {create.isPending ? 'Starting…' : 'Start call'}
      </Button>
    </div>
  );
}

export default function MeetingsPage() {
  const allowed = useCan(Permission.MEETINGS_USE);
  const router = useRouter();
  const [scope, setScope] = useState<Scope>('upcoming');
  const [form, setForm] = useState<'none' | 'schedule' | 'instant'>('none');
  const list = useMeetings(scope);
  if (!allowed) return <AccessDenied what="Meetings" />;
  const open = (id: string) => router.push(`/meetings/${id}`);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Meetings</h1>
        <div className="flex gap-2">
          <Button variant={form === 'instant' ? 'default' : 'outline'} aria-expanded={form === 'instant'} onClick={() => setForm(form === 'instant' ? 'none' : 'instant')}><PhoneCall aria-hidden="true" /> Instant call</Button>
          <Button variant={form === 'schedule' ? 'default' : 'outline'} aria-expanded={form === 'schedule'} onClick={() => setForm(form === 'schedule' ? 'none' : 'schedule')}><CalendarPlus aria-hidden="true" /> Schedule</Button>
        </div>
      </div>
      {form !== 'none' ? (
        <Card><CardHeader><CardTitle className="text-base">{form === 'schedule' ? 'Schedule a meeting' : 'Start an instant call'}</CardTitle></CardHeader>
          <CardContent>{form === 'schedule' ? <ScheduleForm onDone={open} /> : <InstantCall onDone={open} />}</CardContent></Card>
      ) : null}
      <div role="tablist" aria-label="Meetings" className="flex gap-1">
        {(Object.keys(SCOPE_LABEL) as Scope[]).map((s) => <Button key={s} role="tab" size="sm" aria-selected={scope === s} variant={scope === s ? 'default' : 'outline'} onClick={() => setScope(s)}>{SCOPE_LABEL[s]}</Button>)}
      </div>
      <div role="tabpanel">
        {list.isPending ? <LoadingState label="Loading meetings" /> : null}
        {list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
        {list.data && !list.data.items.length ? <EmptyState title={scope === 'live' ? 'No meetings are live' : scope === 'past' ? 'No past meetings' : 'Nothing scheduled'} description={scope === 'upcoming' ? 'Schedule a meeting or start an instant call.' : undefined} /> : null}
        {list.data?.items.length ? (
          <ul className="divide-y rounded border" data-testid="meeting-list">
            {list.data.items.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <Link href={`/meetings/${m.id}`} className="font-medium hover:underline">{m.title}</Link>{' '}
                  {m.status === 'LIVE' ? <Badge variant="success">Live</Badge> : m.status === 'CANCELLED' ? <Badge variant="destructive">Cancelled</Badge> : null}{' '}
                  {m.recurrence ? <Repeat className="inline h-3 w-3" aria-label="Repeats" /> : null}
                  <div className="text-xs text-muted-foreground">{m.type === 'ROOM' ? 'Room meeting' : m.type === 'INSTANT' ? 'Instant call' : formatDateTime(m.scheduledStart)} · host {m.host.displayName ?? m.host.email}{m.myRole !== 'NONE' ? ` · you: ${m.myRole.toLowerCase()}` : ''}</div>
                </div>
                {m.status !== 'CANCELLED' && m.type !== 'ROOM' && scope !== 'past' ? <Button size="sm" asChild><Link href={`/meetings/${m.id}?join=1`}>Join</Link></Button> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
