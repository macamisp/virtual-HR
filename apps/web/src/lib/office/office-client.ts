'use client';

/**
 * Virtual office client (ADR 015): its own Socket.IO connection (purpose "office", so it never
 * counts as the attendance connection), the avatars in the neighbourhood, the roster, knocks and
 * proximity. Framework-free; React subscribes through `subscribe` / `getVersion`.
 */
import { io, type Socket } from 'socket.io-client';
import { buildGrid, findPath, inRect, MOVE_SPEED, walkable } from '@hrvo/shared';
import type {
  CollisionGrid, JoinAck, MoveAck, OfficeMap, OfficeSnapshot, Point, PositionsMessage, ProximityMessage, RosterEntry, TeleportAck, TeleportDto, VoStatus,
} from '@hrvo/shared';
import { API_URL } from '../env';
import { useAuthStore } from '../auth-store';

export interface RemoteAvatar {
  id: string;
  x: number;
  y: number;
  /** Rendered position, interpolated towards x/y. */
  rx: number;
  ry: number;
  dir: number;
  status: VoStatus;
  roomId: string | null;
}

export interface Knock { roomId: string; roomName: string; userId: string; name: string }

export interface SelfState {
  x: number;
  y: number;
  floorId: string;
  roomId: string | null;
  dir: number;
}

export type Notice = { kind: 'info' | 'error'; text: string; action?: { label: string; run: () => void } } | null;

const SEND_MS = 100;

export class OfficeClient {
  socket: Socket | null = null;
  snapshot: OfficeSnapshot;
  grids = new Map<string, CollisionGrid>();
  self: SelfState | null = null;
  readonly avatars = new Map<string, RemoteAvatar>();
  roster = new Map<string, RosterEntry>();
  proximity: ProximityMessage = { groupId: null, members: [] };
  knocks: Knock[] = [];
  notice: Notice = null;
  connected = false;
  roomOnly = false;
  /** Click-to-move waypoints. */
  path: Point[] = [];
  /** Keyboard input (WASD / arrows), unit vector components. */
  keys = { x: 0, y: 0 };
  /** Position latency samples (ms), from movers' echoed client clocks (same-machine tests only). */
  latencies: number[] = [];

  private version = 0;
  private listeners = new Set<() => void>();
  private lastSent: { x: number; y: number } | null = null;
  private sendTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(snapshot: OfficeSnapshot, private readonly positions: boolean) {
    this.snapshot = snapshot;
    for (const f of snapshot.floors) this.grids.set(f.id, buildGrid(f.map as OfficeMap));
  }

  // ---------------------------------------------------------------- React glue

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getVersion = (): number => this.version;
  changed(): void {
    this.version += 1;
    for (const l of this.listeners) l();
  }

  // ---------------------------------------------------------------- connection

  connect(): void {
    const socket = io(API_URL, {
      transports: ['websocket'],
      auth: (cb) => cb({ token: useAuthStore.getState().accessToken ?? '', purpose: 'office' }),
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
    });
    this.socket = socket;
    socket.on('connect', () => void this.join());
    socket.on('disconnect', () => { this.connected = false; this.changed(); });
    socket.on('auth:expired', () => {
      const token = useAuthStore.getState().accessToken;
      socket.emit('auth:refresh', { token }, (r: { success: boolean }) => { if (!r?.success) { socket.disconnect(); socket.connect(); } });
    });
    socket.on('office:positions', (m: PositionsMessage) => this.onPositions(m));
    socket.on('office:presence', (e: RosterEntry | { id: string; gone: true }) => {
      if ('gone' in e) { this.roster.delete(e.id); this.avatars.delete(e.id); } else {
        this.roster.set(e.id, e);
        // Our own room changes made by the server (e.g. a teleport from another tab) arrive here too.
        if (e.id === this.snapshot.me.id && this.self && e.floorId === this.self.floorId) this.self.roomId = e.roomId;
      }
      this.changed();
    });
    socket.on('office:proximity', (m: ProximityMessage) => { this.proximity = m; this.changed(); });
    socket.on('room:knock', (k: Knock) => { this.knocks = [...this.knocks.filter((x) => !(x.userId === k.userId && x.roomId === k.roomId)), k]; this.changed(); });
    socket.on('room:knock-handled', (k: { roomId: string; userId: string }) => { this.knocks = this.knocks.filter((x) => !(x.userId === k.userId && x.roomId === k.roomId)); this.changed(); });
    socket.on('room:answered', (a: { roomId: string; admit: boolean; by: string }) => {
      const room = this.snapshot.rooms.find((r) => r.id === a.roomId);
      if (a.admit && room) {
        this.notice = { kind: 'info', text: `${a.by} let you into ${room.name}.` };
        void this.teleport({ kind: 'room', roomId: room.id });
      } else this.notice = { kind: 'error', text: `${a.by} did not let you into ${room?.name ?? 'the room'}.` };
      this.changed();
    });
    if (this.positions) this.sendTimer = setInterval(() => this.flush(), SEND_MS);
  }

  disconnect(): void {
    if (this.sendTimer) clearInterval(this.sendTimer);
    this.socket?.emit('office:leave');
    this.socket?.disconnect();
    this.socket = null;
  }

  private async join(): Promise<void> {
    const ack = await this.socket!.emitWithAck('office:join', { positions: this.positions, floorId: this.self?.floorId }) as JoinAck;
    if (!ack.ok) { this.notice = { kind: 'error', text: `Could not enter the office: ${ack.error}` }; this.changed(); return; }
    this.connected = true;
    this.self = { ...ack.self, dir: 0 };
    this.lastSent = { x: ack.self.x, y: ack.self.y };
    this.roster = new Map(ack.roster.map((r) => [r.id, r]));
    this.avatars.clear();
    if (this.roomOnly) this.socket!.emit('office:mode', { roomOnly: true });
    this.changed();
  }

  private onPositions(m: PositionsMessage): void {
    const now = Date.now();
    for (const [id, x, y, d, s, r, t] of m.u) {
      const a = this.avatars.get(id);
      if (a) { a.x = x; a.y = y; a.dir = d; a.status = s; a.roomId = r; if (Math.hypot(a.rx - x, a.ry - y) > 300) { a.rx = x; a.ry = y; } }
      else this.avatars.set(id, { id, x, y, rx: x, ry: y, dir: d, status: s, roomId: r });
      if (t) { this.latencies.push(now - t); if (this.latencies.length > 2000) this.latencies.splice(0, 1000); }
    }
    for (const id of m.gone) this.avatars.delete(id);
  }

  // ---------------------------------------------------------------- movement (FR-VO-002)

  grid(): CollisionGrid | null {
    return this.self ? this.grids.get(this.self.floorId) ?? null : null;
  }

  /** Rooms the user may walk into without asking. */
  private canEnterAt = (p: Point): boolean => {
    if (!this.self) return false;
    const room = this.snapshot.rooms.find((r) => r.floorId === this.self!.floorId && inRect(r.bounds, p));
    return !room || room.id === this.self.roomId || room.canEnter;
  };

  /** Click-to-move. A click inside a room you may not enter offers to knock or ask for its password. */
  walkTo(target: Point): void {
    const g = this.grid();
    if (!g || !this.self) return;
    const room = this.snapshot.rooms.find((r) => r.floorId === this.self!.floorId && inRect(r.bounds, target));
    if (room && !this.canEnterAt(target)) { this.askToEnter(room.id); return; }
    const path = findPath(g, this.self, target, this.canEnterAt);
    if (!path) { this.notice = { kind: 'error', text: 'You cannot get there from here.' }; this.changed(); return; }
    this.path = path;
  }

  /** Called every frame with the elapsed time; moves the own avatar locally (prediction). */
  step(dtMs: number): void {
    const g = this.grid();
    if (!g || !this.self || !this.connected) return;
    const maxStep = (MOVE_SPEED * Math.min(dtMs, 100)) / 1000;
    let vx = this.keys.x;
    let vy = this.keys.y;
    if (vx !== 0 || vy !== 0) {
      this.path = [];
      const len = Math.hypot(vx, vy);
      vx = (vx / len) * maxStep;
      vy = (vy / len) * maxStep;
    } else if (this.path.length) {
      const next = this.path[0]!;
      const dx = next.x - this.self.x;
      const dy = next.y - this.self.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= maxStep) { vx = dx; vy = dy; this.path.shift(); } else { vx = (dx / dist) * maxStep; vy = (dy / dist) * maxStep; }
    } else return;
    // Slide along walls: try both axes, then each one.
    const s = this.self;
    const tryMove = (nx: number, ny: number) => walkable(g, nx, ny) && this.canEnterAt({ x: nx, y: ny });
    if (tryMove(s.x + vx, s.y + vy)) { s.x += vx; s.y += vy; }
    else if (tryMove(s.x + vx, s.y)) s.x += vx;
    else if (tryMove(s.x, s.y + vy)) s.y += vy;
    else this.path = [];
    s.dir = direction(vx, vy);
  }

  private flush(): void {
    const s = this.self;
    if (!this.socket || !s || !this.connected || this.inFlight) return;
    if (this.lastSent && Math.abs(this.lastSent.x - s.x) < 0.5 && Math.abs(this.lastSent.y - s.y) < 0.5) return;
    const sent = { x: Math.round(s.x), y: Math.round(s.y) };
    this.inFlight = true;
    this.socket.emit('office:move', { ...sent, dir: s.dir, ct: Date.now() }, (ack: MoveAck) => {
      this.inFlight = false;
      // The server decides which room we are in; walking through a door changes the call (FR-MEET-002).
      if (ack.roomId !== s.roomId) { s.roomId = ack.roomId; this.changed(); }
      if (ack.ok) { this.lastSent = sent; return; }
      if (ack.reason === 'RATE_LIMITED') return;
      // Server correction: snap back to the authoritative position.
      s.x = ack.x; s.y = ack.y; s.floorId = ack.floorId || s.floorId;
      this.lastSent = { x: ack.x, y: ack.y };
      this.path = [];
      if (ack.reason.startsWith('ROOM_')) {
        const room = this.snapshot.rooms.find((r) => r.floorId === s.floorId && inRect(r.bounds, sent));
        if (room) this.askToEnter(room.id);
      }
      this.changed();
    });
  }

  // ---------------------------------------------------------------- rooms, teleport, knock (FR-VO-004, 007, 008)

  askToEnter(roomId: string): void {
    const room = this.snapshot.rooms.find((r) => r.id === roomId);
    if (!room) return;
    if (room.accessMode === 'KNOCK') this.notice = { kind: 'info', text: `${room.name} is knock-to-enter.`, action: { label: 'Knock', run: () => void this.knock(room.id) } };
    else if (room.accessMode === 'PASSWORD') this.notice = { kind: 'info', text: `${room.name} needs a password.`, action: { label: 'Enter password', run: () => this.onPasswordNeeded?.(room.id) } };
    else if (room.accessMode === 'INVITE') this.notice = { kind: 'error', text: `${room.name} is invite-only.` };
    else this.notice = { kind: 'error', text: `${room.name} is full.` };
    this.changed();
  }

  onPasswordNeeded: ((roomId: string) => void) | null = null;

  async teleport(dto: TeleportDto): Promise<TeleportAck> {
    if (!this.socket) return { ok: false, error: 'Not connected' };
    const ack = await this.socket.emitWithAck('office:teleport', dto) as TeleportAck;
    if (ack.ok && this.self) {
      Object.assign(this.self, { x: ack.x, y: ack.y, floorId: ack.floorId, roomId: ack.roomId });
      this.lastSent = { x: ack.x, y: ack.y };
      this.path = [];
      if (dto.kind === 'room') {
        // The password or the knock admission now lets this user in.
        const room = this.snapshot.rooms.find((r) => r.id === dto.roomId);
        if (room) room.canEnter = true;
      }
      this.notice = null;
    } else if (!ack.ok) {
      if (dto.kind !== 'desk' && dto.kind !== 'floor' && (ack.code === 'KNOCK' || ack.code === 'PASSWORD' || ack.code === 'INVITE' || ack.code === 'FULL')) {
        const roomId = dto.kind === 'room' ? dto.roomId : this.roster.get(dto.userId)?.roomId;
        if (roomId && ack.code !== 'PASSWORD') this.askToEnter(roomId);
        else this.notice = { kind: 'error', text: ack.error };
      } else this.notice = { kind: 'error', text: ack.error };
    }
    this.changed();
    return ack;
  }

  async knock(roomId: string): Promise<void> {
    const r = await this.socket?.emitWithAck('room:knock', { roomId }) as { ok: boolean; error?: string } | undefined;
    this.notice = r?.ok ? { kind: 'info', text: 'You knocked. Someone inside will let you in.' } : { kind: 'error', text: r?.error ?? 'Could not knock' };
    this.changed();
  }

  answer(k: Knock, admit: boolean): void {
    this.socket?.emit('room:answer', { roomId: k.roomId, userId: k.userId, admit });
    this.knocks = this.knocks.filter((x) => x !== k);
    this.changed();
  }

  setRoomOnly(v: boolean): void {
    this.roomOnly = v;
    this.socket?.emit('office:mode', { roomOnly: v });
    this.changed();
  }

  dismissNotice(): void {
    this.notice = null;
    this.changed();
  }
}

/** 0 = east, counter-clockwise in 45° steps. */
export function direction(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  return ((Math.round(Math.atan2(-dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
}
