'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { DoorOpen, Lock, Megaphone, Map as MapIcon, Minus, Navigation, Plus, Users } from 'lucide-react';
import { ACCESS_MODES, VO_STATUS_LABEL } from '@hrvo/shared';
import type { AccessMode, OfficeSnapshot, Room, VoStatus } from '@hrvo/shared';
import { AccessDenied, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { OfficeMedia } from '@/components/media/office-media';
import { AvatarActions } from '@/components/office/avatar-actions';
import { CallPerson } from '@/components/call-person';
import { OfficeClient } from '@/lib/office/office-client';
import { STATUS_COLOUR } from '@/lib/office/office-renderer';
import type { OfficeRenderer } from '@/lib/office/office-renderer';
import { useBroadcast, useClaimDesk, useOfficePeople, useOfficeSnapshot, useReleaseDesk, useSetStatus, useUpdateRoom } from '@/lib/office-queries';
import { Permission, useCan } from '@/lib/permissions';
import { cn } from '@/lib/utils';

type View = 'map' | 'list';
const VIEW_KEY = 'hrvo.office.view';
const ACCESS_LABEL: Record<AccessMode, string> = { OPEN: 'Open', KNOCK: 'Knock to enter', INVITE: 'Invite only', PASSWORD: 'Password' };
const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

function StatusDot({ status }: { status: VoStatus }) {
  return <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: hex(STATUS_COLOUR[status]) }} />;
}

function useClient(snapshot: OfficeSnapshot | undefined, view: View) {
  const [client, setClient] = useState<OfficeClient | null>(null);
  useEffect(() => {
    if (!snapshot) return;
    const c = new OfficeClient(snapshot, view === 'map');
    c.connect();
    setClient(c);
    return () => c.disconnect();
    // Reconnect only when the view (position stream) changes, not on every snapshot refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, !!snapshot]);
  useEffect(() => {
    if (client && snapshot) {
      client.snapshot = snapshot;
      client.changed();
    }
  }, [client, snapshot]);
  useSyncExternalStore(client?.subscribe ?? noopSubscribe, client?.getVersion ?? zero, zero);
  return client;
}
const noopSubscribe = () => () => undefined;
const zero = () => 0;

function MapView({ client }: { client: OfficeClient }) {
  const host = useRef<HTMLDivElement | null>(null);
  const renderer = useRef<OfficeRenderer | null>(null);
  const getRenderer = useCallback(() => renderer.current, []);
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let r: OfficeRenderer | null = null;
    let cancelled = false;
    void import('@/lib/office/office-renderer').then(async ({ OfficeRenderer: R }) => {
      if (cancelled || !host.current) return;
      r = new R(client, host.current);
      renderer.current = r;
      await r.init();
      const bench = Number(new URLSearchParams(window.location.search).get('bench') ?? 0);
      if (bench > 0 && client.snapshot.floors[0]) {
        // After the join, which resets the avatar list.
        const map = client.snapshot.floors[0].map as never;
        const start = () => { if (cancelled) return; if (client.connected) r?.startBench(Math.min(bench, 1000), map); else setTimeout(start, 200); };
        start();
      }
    });
    const t = setInterval(() => {
      if (renderer.current) {
        setFps(Math.round(renderer.current.fps));
        host.current?.setAttribute('data-fps', String(Math.round(renderer.current.fps)));
        host.current?.setAttribute('data-frame-ms', renderer.current.frameMs.toFixed(2));
        host.current?.setAttribute('data-avatars', String(client.avatars.size + 1));
      }
    }, 500);
    return () => { cancelled = true; clearInterval(t); r?.destroy(); renderer.current = null; };
  }, [client]);

  const KEYS: Record<string, [number, number]> = { KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1], KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0] };
  const pressed = useRef(new Set<string>());
  const updateKeys = () => {
    let x = 0; let y = 0;
    for (const k of pressed.current) { const v = KEYS[k]; if (v) { x += v[0]; y += v[1]; } }
    client.keys = { x: Math.sign(x), y: Math.sign(y) };
  };
  return (
    <div className="relative h-[calc(100vh-12rem)] min-h-[420px] overflow-hidden rounded border bg-slate-50">
      <div
        ref={host}
        data-testid="office-canvas"
        tabIndex={0}
        role="application"
        aria-label="Office map. Use W A S D or the arrow keys to walk, or click a spot. The list view offers the same actions without the map."
        className="h-full w-full outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onKeyDown={(e) => { if (KEYS[e.code]) { e.preventDefault(); pressed.current.add(e.code); updateKeys(); } }}
        onKeyUp={(e) => { if (pressed.current.delete(e.code)) updateKeys(); }}
        onBlur={() => { pressed.current.clear(); updateKeys(); }}
        onPointerDown={() => host.current?.focus()}
      />
      <AvatarActions client={client} renderer={getRenderer} />
      <div className="absolute right-2 top-2 flex flex-col gap-1">
        <Button size="sm" variant="outline" aria-label="Zoom in" onClick={() => renderer.current?.zoomBy(1.2)}><Plus aria-hidden="true" /></Button>
        <Button size="sm" variant="outline" aria-label="Zoom out" onClick={() => renderer.current?.zoomBy(1 / 1.2)}><Minus aria-hidden="true" /></Button>
      </div>
      <p className="absolute bottom-2 left-2 rounded bg-white/80 px-2 py-1 text-xs text-muted-foreground" aria-hidden="true">WASD / arrows to walk · click to go · {fps} fps</p>
    </div>
  );
}

function PasswordDialog({ room, onSubmit, onClose }: { room: Room; onSubmit: (pw: string) => void; onClose: () => void }) {
  const [pw, setPw] = useState('');
  const id = useId();
  return (
    <Card role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} data-testid="room-password" className="border-primary">
      <CardHeader><CardTitle id={`${id}-t`} className="text-base">{room.name} needs a password</CardTitle></CardHeader>
      <CardContent>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); onSubmit(pw); }}>
          <div className="space-y-1"><Label htmlFor={id}>Room password</Label><Input id={id} type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} /></div>
          <Button type="submit" disabled={!pw}>Enter</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function RoomSettings({ room }: { room: Room }) {
  const update = useUpdateRoom();
  const [mode, setMode] = useState<AccessMode>(room.accessMode);
  const [capacity, setCapacity] = useState(String(room.capacity));
  const [password, setPassword] = useState('');
  const id = useId();
  return (
    <form className="mt-2 space-y-2 rounded border p-2" aria-label={`Settings for ${room.name}`} onSubmit={(e) => {
      e.preventDefault();
      update.mutate({ id: room.id, dto: { accessMode: mode, capacity: Number(capacity), ...(mode === 'PASSWORD' && password ? { password } : {}) } }, { onSuccess: () => setPassword('') });
    }}>
      <div className="flex flex-wrap gap-2">
        <div className="space-y-1"><Label htmlFor={`${id}-m`} className="text-xs">Access</Label>
          <NativeSelect id={`${id}-m`} value={mode} onChange={(e) => setMode(e.target.value as AccessMode)}>{ACCESS_MODES.map((m) => <option key={m} value={m}>{ACCESS_LABEL[m]}</option>)}</NativeSelect></div>
        <div className="space-y-1"><Label htmlFor={`${id}-c`} className="text-xs">Capacity</Label><Input id={`${id}-c`} type="number" min={1} max={500} className="w-20" value={capacity} onChange={(e) => setCapacity(e.target.value)} /></div>
        {mode === 'PASSWORD' ? <div className="space-y-1"><Label htmlFor={`${id}-p`} className="text-xs">{room.accessMode === 'PASSWORD' ? 'New password (optional)' : 'Password'}</Label><Input id={`${id}-p`} type="password" minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} /></div> : null}
      </div>
      <Button size="sm" type="submit" disabled={update.isPending}>Save room</Button>
      {update.isError ? <p role="alert" className="text-xs text-destructive">{update.error.message}</p> : null}
    </form>
  );
}

function Rooms({ client, snapshot }: { client: OfficeClient; snapshot: OfficeSnapshot }) {
  const [open, setOpen] = useState<string | null>(null);
  const here = client.self?.floorId;
  const byRoom = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of client.roster.values()) if (r.roomId) m.set(r.roomId, [...(m.get(r.roomId) ?? []), r.name]);
    return m;
  }, [client.roster, client.getVersion()]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <ul className="space-y-1" aria-label="Rooms">
      {snapshot.rooms.filter((r) => !here || r.floorId === here).map((r) => {
        const people = byRoom.get(r.id) ?? [];
        const isHere = client.self?.roomId === r.id;
        return (
          <li key={r.id} className={cn('rounded border p-2', isHere && 'border-primary bg-accent/40')} data-testid={`room-${r.name}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-medium">{r.name}</span>{' '}
                <Badge variant="outline">{ACCESS_LABEL[r.accessMode]}</Badge>{' '}
                <span className="text-xs text-muted-foreground">{people.length}/{r.capacity}{isHere ? ' · you are here' : ''}</span>
                {people.length ? <div className="text-xs text-muted-foreground">{people.join(', ')}</div> : null}
              </div>
              <div className="flex gap-1">
                {!isHere ? <Button size="sm" variant="outline" onClick={() => void client.teleport({ kind: 'room', roomId: r.id })}><DoorOpen aria-hidden="true" /> Go to {r.name}</Button> : null}
                {!isHere && r.accessMode === 'KNOCK' && !r.canEnter ? <Button size="sm" variant="ghost" onClick={() => void client.knock(r.id)}>Knock</Button> : null}
                {snapshot.canManage ? <Button size="sm" variant="ghost" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>Settings</Button> : null}
              </div>
            </div>
            {open === r.id ? <RoomSettings room={r} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

function People({ client }: { client: OfficeClient }) {
  const [q, setQ] = useState('');
  const people = useOfficePeople(q.trim());
  const meId = client.snapshot.me.id;
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Find a colleague</Label>
      <Input id={id} type="search" value={q} placeholder="Name, email or team" onChange={(e) => setQ(e.target.value)} />
      {people.isPending ? <LoadingState label="Loading people" rows={2} /> : null}
      {people.isError ? <ErrorState error={people.error} onRetry={() => void people.refetch()} /> : null}
      <ul className="space-y-1" aria-label="People" data-testid="people-list">
        {people.data?.items.map((p) => {
          // The roster is live; the REST list fills in people who are not in the office.
          const live = client.roster.get(p.id);
          const status = live?.status ?? p.status;
          const roomName = live?.roomId ? client.snapshot.rooms.find((r) => r.id === live.roomId)?.name : live ? null : p.roomName;
          const where = live ? (roomName ? `in ${roomName}` : 'in the open area') : 'not in the office';
          return (
            <li key={p.id} className="flex items-center justify-between gap-2 rounded px-1 py-1 hover:bg-accent/50">
              <div className="min-w-0">
                <div className="flex items-center gap-2 truncate"><StatusDot status={status} /><span className="truncate font-medium">{p.displayName ?? p.email}</span>{p.id === meId ? <span className="text-xs text-muted-foreground">(you)</span> : null}</div>
                <div className="truncate text-xs text-muted-foreground">{VO_STATUS_LABEL[status]} · {where}{p.deskLabel ? ` · desk ${p.deskLabel}` : ''}{(live?.statusMessage ?? p.statusMessage) ? ` · “${live?.statusMessage ?? p.statusMessage}”` : ''}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {p.id !== meId ? <CallPerson userId={p.id} name={p.displayName ?? p.email} /> : null}
                {live && p.id !== meId ? <Button size="sm" variant="outline" aria-label={`Go to ${p.displayName ?? p.email}`} onClick={() => void client.teleport({ kind: 'user', userId: p.id })}><Navigation aria-hidden="true" /></Button> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MyPanel({ client, snapshot }: { client: OfficeClient; snapshot: OfficeSnapshot }) {
  const setStatus = useSetStatus();
  const claim = useClaimDesk();
  const release = useReleaseDesk();
  const [manual, setManual] = useState(snapshot.me.manualStatus);
  const [message, setMessage] = useState(snapshot.me.statusMessage);
  const [desk, setDesk] = useState('');
  const ids = { s: useId(), m: useId(), d: useId() };
  const myDesk = snapshot.desks.find((d) => d.id === snapshot.me.deskId);
  const free = snapshot.desks.filter((d) => !d.assignee);
  const live = client.roster.get(snapshot.me.id);
  return (
    <div className="space-y-3">
      <p className="text-sm" data-testid="my-status"><StatusDot status={live?.status ?? 'ACTIVE'} /> {VO_STATUS_LABEL[live?.status ?? 'ACTIVE']}{client.self?.roomId ? ` · in ${snapshot.rooms.find((r) => r.id === client.self!.roomId)?.name}` : ''}</p>
      <form className="space-y-2" aria-label="My status" onSubmit={(e) => { e.preventDefault(); setStatus.mutate({ status: manual, message }); }}>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1"><Label htmlFor={ids.s}>Status</Label>
            <NativeSelect id={ids.s} value={manual} onChange={(e) => setManual(e.target.value as typeof manual)}><option value="AUTO">Automatic (attendance)</option><option value="AWAY">Away</option><option value="DND">Do not disturb</option></NativeSelect></div>
          <div className="space-y-1"><Label htmlFor={ids.m}>Message</Label><Input id={ids.m} maxLength={100} value={message} onChange={(e) => setMessage(e.target.value)} className="w-40" /></div>
          <Button size="sm" type="submit" disabled={setStatus.isPending}>Set</Button>
        </div>
      </form>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={client.roomOnly} onChange={(e) => client.setRoomOnly(e.target.checked)} /> Room-only mode (no proximity in the open area)</label>
      {client.proximity.members.length > 1 ? <p className="text-sm text-muted-foreground" data-testid="proximity">Nearby: {client.proximity.members.filter((m) => m !== snapshot.me.id).map((m) => client.roster.get(m)?.name ?? '…').join(', ')}</p> : null}
      <div className="flex flex-wrap items-end gap-2">
        {myDesk ? (
          <>
            <Button size="sm" onClick={() => void client.teleport({ kind: 'desk' })}><Navigation aria-hidden="true" /> Go to my desk ({myDesk.label})</Button>
            <Button size="sm" variant="ghost" onClick={() => release.mutate(myDesk.id)}>Release desk</Button>
          </>
        ) : free.length ? (
          <>
            <div className="space-y-1"><Label htmlFor={ids.d}>Claim a free desk</Label>
              <NativeSelect id={ids.d} value={desk} onChange={(e) => setDesk(e.target.value)}><option value="">Choose…</option>{free.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</NativeSelect></div>
            <Button size="sm" variant="outline" disabled={!desk || claim.isPending} onClick={() => claim.mutate(desk)}>Claim</Button>
          </>
        ) : <p className="text-sm text-muted-foreground">No free desks.</p>}
      </div>
      {claim.isError ? <p role="alert" className="text-xs text-destructive">{claim.error.message}</p> : null}
    </div>
  );
}

/** FR-VO-010: broadcast to the whole office (office.broadcast). */
function BroadcastForm() {
  const send = useBroadcast();
  const [text, setText] = useState('');
  const id = useId();
  return (
    <form className="space-y-2" aria-label="Broadcast" onSubmit={(e) => { e.preventDefault(); send.mutate(text.trim(), { onSuccess: () => setText('') }); }}>
      <Label htmlFor={id}>Message to everyone online</Label>
      <Input id={id} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex items-center gap-2">
        <Button size="sm" type="submit" disabled={send.isPending || !text.trim()}><Megaphone aria-hidden="true" /> Broadcast</Button>
        {send.isSuccess ? <span role="status" className="text-xs text-muted-foreground">Sent.</span> : null}
        {send.isError ? <span role="alert" className="text-xs text-destructive">{send.error.message}</span> : null}
      </div>
    </form>
  );
}

/** FR-VO-001..005, 007, 008, 009, 010, 012, 013 (ADR 015, 016). */
export default function OfficePage() {
  const allowed = useCan(Permission.OFFICE_USE);
  const canBroadcast = useCan(Permission.BROADCAST);
  const snapshot = useOfficeSnapshot();
  const [view, setView] = useState<View>('map');
  useEffect(() => {
    try { const v = window.localStorage.getItem(VIEW_KEY); if (v === 'list' || v === 'map') setView(v); } catch { /* storage unavailable */ }
  }, []);
  const choose = (v: View) => { setView(v); try { window.localStorage.setItem(VIEW_KEY, v); } catch { /* storage unavailable */ } };
  const client = useClient(snapshot.data, view);
  const [passwordRoom, setPasswordRoom] = useState<string | null>(null);
  if (client) client.onPasswordNeeded = setPasswordRoom;
  if (!allowed) return <AccessDenied what="The virtual office" />;
  const pwRoom = passwordRoom ? snapshot.data?.rooms.find((r) => r.id === passwordRoom) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{snapshot.data?.office.name ?? 'Office'}</h1>
        <div role="group" aria-label="View" className="flex gap-1">
          <Button size="sm" variant={view === 'map' ? 'default' : 'outline'} aria-pressed={view === 'map'} onClick={() => choose('map')}><MapIcon aria-hidden="true" /> Map</Button>
          <Button size="sm" variant={view === 'list' ? 'default' : 'outline'} aria-pressed={view === 'list'} onClick={() => choose('list')}><Users aria-hidden="true" /> List</Button>
        </div>
      </div>
      {snapshot.isPending ? <LoadingState label="Loading the office" rows={4} /> : null}
      {snapshot.isError ? <ErrorState error={snapshot.error} onRetry={() => void snapshot.refetch()} /> : null}
      {client && snapshot.data ? (
        <>
          <div aria-live="polite" className="space-y-2">
            {!client.connected ? <Alert><AlertDescription>Connecting to the office…</AlertDescription></Alert> : null}
            {client.notice ? (
              <Alert variant={client.notice.kind === 'error' ? 'destructive' : 'default'} data-testid="office-notice">
                <AlertDescription className="flex flex-wrap items-center gap-2">
                  {client.notice.text}
                  {client.notice.action ? <Button size="sm" variant="outline" onClick={client.notice.action.run}>{client.notice.action.label}</Button> : null}
                  <Button size="sm" variant="ghost" onClick={() => client.dismissNotice()}>Dismiss</Button>
                </AlertDescription>
              </Alert>
            ) : null}
            {client.knocks.map((k) => (
              <Alert key={`${k.roomId}-${k.userId}`} data-testid="knock">
                <AlertDescription className="flex flex-wrap items-center gap-2">
                  <Lock className="h-4 w-4" aria-hidden="true" /> {k.name} is knocking on {k.roomName}.
                  <Button size="sm" onClick={() => client.answer(k, true)}>Let in</Button>
                  <Button size="sm" variant="ghost" onClick={() => client.answer(k, false)}>Decline</Button>
                </AlertDescription>
              </Alert>
            ))}
            {pwRoom ? <PasswordDialog room={pwRoom} onClose={() => setPasswordRoom(null)} onSubmit={(pw) => { void client.teleport({ kind: 'room', roomId: pwRoom.id, password: pw }).then((a) => { if (a.ok) setPasswordRoom(null); }); }} /> : null}
          </div>
          <div className={cn('grid gap-3', view === 'map' ? 'lg:grid-cols-[1fr_22rem]' : 'lg:grid-cols-2')}>
            {view === 'map' ? <MapView client={client} /> : (
              <Card><CardHeader><CardTitle className="text-base">Rooms</CardTitle></CardHeader><CardContent><Rooms client={client} snapshot={snapshot.data} /></CardContent></Card>
            )}
            <div className="space-y-3">
              <Card><CardHeader><CardTitle className="text-base">Me</CardTitle></CardHeader><CardContent><MyPanel client={client} snapshot={snapshot.data} /></CardContent></Card>
              <Card><CardHeader><CardTitle className="text-base">Audio and video</CardTitle></CardHeader><CardContent><OfficeMedia client={client} snapshot={snapshot.data} /></CardContent></Card>
              {view === 'map' ? <Card><CardHeader><CardTitle className="text-base">Rooms</CardTitle></CardHeader><CardContent><Rooms client={client} snapshot={snapshot.data} /></CardContent></Card> : null}
              <Card><CardHeader><CardTitle className="text-base">People</CardTitle></CardHeader><CardContent><People client={client} /></CardContent></Card>
              {canBroadcast ? <Card><CardHeader><CardTitle className="text-base">Broadcast</CardTitle></CardHeader><CardContent><BroadcastForm /></CardContent></Card> : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
