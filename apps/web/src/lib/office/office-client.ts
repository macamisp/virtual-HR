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
import { refreshSession, secondsUntilExpiry } from '../session';

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
  /** ADR 048: in the office but not looking at it (another page of the app). */
  away: boolean;
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
  private unsubAuth: (() => void) | null = null;
  private reconnecting = false;
  private deniedCount = 0;
  private joinRetry: ReturnType<typeof setTimeout> | null = null;

  /** Whether the office view is on screen, and whether the map wants the position stream (ADR 048). */
  private visible = true;

  constructor(snapshot: OfficeSnapshot, private positions: boolean) {
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
    socket.on('connect', () => { this.deniedCount = 0; void this.join(); });
    socket.on('disconnect', (reason) => {
      this.connected = false;
      // A move whose acknowledgement will never come must not block every later move (ADR 048 §8).
      this.inFlight = false;
      this.path = [];
      this.changed();
      // Kicked by the server (expired token): Socket.IO does not reconnect from this on its own.
      if (reason === 'io server disconnect') void this.reconnectWithFreshToken();
    });
    socket.on('connect_error', (err) => {
      // Refused in the handshake (stale token): also never retried by Socket.IO itself.
      if (err.message === 'Unauthorized') { this.deniedCount += 1; void this.reconnectWithFreshToken(Math.min(30_000, 2_000 * this.deniedCount)); }
    });
    // `auth:expired` is followed at once by a server disconnect: the disconnect handler reconnects
    // with a fresh token. Answering it with auth:refresh would only race that reconnection.
    socket.on('auth:expired', () => undefined);
    // Every refreshed access token extends this socket's life on the server before it expires
    // (ADR 005 `auth:refresh`), so an idle office tab is never kicked in the first place.
    this.unsubAuth = useAuthStore.subscribe((state, prev) => {
      if (state.accessToken && state.accessToken !== prev.accessToken) void this.extendAuth();
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
    this.sendTimer = setInterval(() => this.flush(), SEND_MS);
  }

  /** ADR 048: the office page came on or off screen; the socket and the avatar stay. */
  setView(visible: boolean, positions: boolean): void {
    if (this.visible === visible && this.positions === positions) return;
    this.visible = visible;
    this.positions = positions;
    if (this.connected) this.socket?.emit('office:view', { visible, positions });
    this.changed();
  }

  disconnect(): void {
    if (this.sendTimer) clearInterval(this.sendTimer);
    if (this.joinRetry) clearTimeout(this.joinRetry);
    this.unsubAuth?.();
    this.unsubAuth = null;
    this.socket?.emit('office:leave');
    this.socket?.disconnect();
    this.socket = null;
  }

  /** Hands the current access token to the live socket (extends its expiry on the server). */
  private async extendAuth(): Promise<void> {
    const socket = this.socket;
    const token = useAuthStore.getState().accessToken;
    if (!socket || !token) return;
    if (!socket.connected) { socket.connect(); return; }
    const connection = socket.id;
    const r = await socket.timeout(10_000).emitWithAck('auth:refresh', { token }).catch(() => null) as { success: boolean } | null;
    // A reply that arrives after a reconnection is about an earlier connection: leave this one alone.
    if (this.socket !== socket || socket.id !== connection) return;
    if (!r?.success) { socket.disconnect(); void this.reconnectWithFreshToken(); }
  }

  /**
   * ADR 048 §8: after a kick or a refused handshake, make sure the session is fresh (the shell
   * refreshes a minute before expiry, but a throttled background tab can be late) and reconnect.
   * A session that cannot be refreshed means a sign-out; the provider then closes the office.
   */
  private async reconnectWithFreshToken(afterMs = 0): Promise<void> {
    if (this.reconnecting || !this.socket) return;
    this.reconnecting = true;
    try {
      if (afterMs) await new Promise((r) => setTimeout(r, afterMs));
      const token = useAuthStore.getState().accessToken;
      if (!token || secondsUntilExpiry(token) < 30) { if (!(await refreshSession())) return; }
      if (this.socket && !this.socket.connected) this.socket.connect();
    } finally { this.reconnecting = false; }
  }

  private async join(): Promise<void> {
    const sent = { positions: this.positions, visible: this.visible };
    const ack = await this.socket!.emitWithAck('office:join', { ...sent, floorId: this.self?.floorId }) as JoinAck;
    if (!ack.ok) {
      this.notice = { kind: 'error', text: `Could not enter the office: ${ack.error}` };
      this.changed();
      // Transient (a database hiccup, a token that just turned): try again; "Forbidden" is final.
      if (ack.error !== 'Forbidden' && this.socket) this.joinRetry = setTimeout(() => { if (this.socket?.connected) void this.join(); }, 3_000);
      return;
    }
    this.inFlight = false;
    this.connected = true;
    // The view may have changed while the join was in flight (ADR 048).
    if (sent.positions !== this.positions || sent.visible !== this.visible) this.socket!.emit('office:view', { visible: this.visible, positions: this.positions });
    this.self = { ...ack.self, dir: 0 };
    this.lastSent = { x: ack.self.x, y: ack.self.y };
    this.roster = new Map(ack.roster.map((r) => [r.id, r]));
    this.avatars.clear();
    if (this.roomOnly) this.socket!.emit('office:mode', { roomOnly: true });
    this.changed();
  }

  private onPositions(m: PositionsMessage): void {
    const now = Date.now();
    for (const [id, x, y, d, s, r, t, away] of m.u) {
      const a = this.avatars.get(id);
      if (a) { a.x = x; a.y = y; a.dir = d; a.status = s; a.roomId = r; a.away = away === 1; if (Math.hypot(a.rx - x, a.ry - y) > 300) { a.rx = x; a.ry = y; } }
      else this.avatars.set(id, { id, x, y, rx: x, ry: y, dir: d, status: s, roomId: r, away: away === 1 });
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
