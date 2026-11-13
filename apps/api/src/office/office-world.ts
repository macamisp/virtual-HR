/**
 * The live state of one organisation's office (ADR 015): who is where, which rooms they may
 * enter, pending knocks, and what each observer has already been sent. In memory, per API
 * instance; a Redis-backed world is needed before the office runs on more than one instance.
 *
 * All positions here are server-validated (collision map, speed, room access). Client clocks are
 * only echoed for latency measurement.
 */
import { randomUUID } from 'node:crypto';
import {
  ACTION_MS, buildGrid, centre, mapSeats, PAIR_REACH, PAIR_REQUEST_TTL_MS, SEAT_REACH, segmentClear, displayStatus, inRect, InterestGrid, isClosedRoom, nearestWalkable, proximityGroups, spawnPoint, TILE_SIZE, validateMove,
} from '../../../../packages/shared/src/office/index.ts';
import type {
  AccessMode, AvatarActionKind, AvatarActionState, AvatarKey, PairAction, PairClosedMessage, Seat, CollisionGrid, ManualStatus, OfficeDefinition, Point, PositionEntry, PositionsMessage, ProximityMessage, Rect, RosterEntry, RoomType, VoStatus,
} from '../../../../packages/shared/src/office/index.ts';

export interface RoomInfo {
  id: string;
  floorId: string;
  name: string;
  type: RoomType;
  capacity: number;
  accessMode: AccessMode;
  bounds: Rect;
  passwordHash: string | null;
}

export interface DeskInfo {
  id: string;
  floorId: string;
  label: string;
  bounds: Rect;
  assignedUserId: string | null;
}

export interface Avatar {
  userId: string;
  name: string;
  floorId: string;
  x: number;
  y: number;
  dir: number;
  roomId: string | null;
  /** Server ms of the last accepted position. */
  lastMoveAt: number;
  /** Bumped on every visible change; observers compare it with what they were sent. */
  version: number;
  attendance: string | null;
  manual: ManualStatus;
  message: string;
  roomOnly: boolean;
  isAdmin: boolean;
  /** Socket ids in the office; those with positions=true get the position stream, viewing=true show the office view (ADR 048). */
  sockets: Map<string, { positions: boolean; viewing: boolean }>;
  ct: number | null;
  /** ADR 048: server ms when the last socket dropped without leaving; removed by the tick after the grace. */
  goneAt: number | null;
  /** The login session family that dropped: only it gets its place back (a reload); a new sign-in starts fresh. */
  goneSid: string | null;
  /** ADR 053: the saved pixel-art character (roster only, not the position stream). */
  avatarKey: AvatarKey;
  /** ADR 056: what the person is doing; `until` is server ms (null: until they stand or walk). */
  action?: (AvatarActionState & { until: number | null }) | null;
}

/** ADR 056: a hug or high-five request waiting for the other person's answer. */
export interface PairRequest { id: string; kind: PairAction; from: string; to: string; expiresAt: number }

export type Denial = 'KNOCK' | 'INVITE' | 'PASSWORD' | 'FULL';

export interface WorldEmitter {
  /** One observer's stream. */
  positions(userId: string, msg: PositionsMessage): void;
  proximity(userId: string, msg: ProximityMessage): void;
  /** Everyone in the office: someone joined, left, changed room or status. */
  roster(orgId: string, entry: RosterEntry | { id: string; gone: true }): void;
  /** ADR 056: one person's sockets (pair requests and their outcome). */
  personal?(userId: string, event: string, payload: unknown): void;
}

const seat = (d: DeskInfo): Point => ({ x: d.bounds.x + d.bounds.width / 2, y: d.bounds.y + d.bounds.height - TILE_SIZE / 2 });

export class OfficeWorld {
  readonly grids = new Map<string, CollisionGrid>();
  readonly spawns = new Map<string, Point>();
  readonly avatars = new Map<string, Avatar>();
  /** Ephemeral entry rights: admitted after a knock, or the password was given. */
  readonly grants = new Map<string, Set<string>>();
  /** roomId -> knocking userId -> server ms */
  readonly knocks = new Map<string, Map<string, number>>();
  private readonly known = new Map<string, Map<string, number>>();
  private readonly lastGroup = new Map<string, string>();
  /** FR-VO-005: the current proximity group of each person (set every tick). */
  readonly groupByUser = new Map<string, { id: string; members: string[] }>();
  rosterChanged = false;
  readonly changedRoster = new Set<string>();
  /** ADR 056: the chairs of each floor, from the map; and the open hug / high-five requests. */
  readonly seats = new Map<string, Map<string, Seat>>();
  readonly requests = new Map<string, PairRequest>();

  constructor(
    readonly orgId: string,
    readonly officeId: string,
    readonly definition: OfficeDefinition,
    public rooms: RoomInfo[],
    public desks: DeskInfo[],
    public invites: Map<string, Set<string>>,
    public proximityRadius: number,
  ) {
    for (const f of definition.floors) {
      this.grids.set(f.id, buildGrid(f.map));
      this.spawns.set(f.id, spawnPoint(f.map));
      this.seats.set(f.id, new Map(mapSeats(f.map, this.grids.get(f.id)!).map((x) => [x.id, x])));
    }
  }

  roomAt(floorId: string, p: Point): RoomInfo | null {
    return this.rooms.find((r) => r.floorId === floorId && inRect(r.bounds, p)) ?? null;
  }

  occupants(roomId: string): Avatar[] {
    return [...this.avatars.values()].filter((a) => a.roomId === roomId);
  }

  /** Null when allowed, otherwise why not. */
  mayEnter(userId: string, room: RoomInfo, isAdmin: boolean, alreadyInside = false): Denial | null {
    // Capacity limits real rooms; OPEN-type areas (reception, lounge) are parts of the floor.
    if (room.type !== 'OPEN' && !alreadyInside && this.occupants(room.id).length >= room.capacity) return 'FULL';
    if (room.accessMode === 'OPEN' || isAdmin) return null;
    if (room.accessMode === 'INVITE') return this.invites.get(room.id)?.has(userId) ? null : 'INVITE';
    return this.grants.get(userId)?.has(room.id) ? null : room.accessMode;
  }

  grant(userId: string, roomId: string): void {
    const set = this.grants.get(userId) ?? new Set<string>();
    set.add(roomId);
    this.grants.set(userId, set);
    this.knocks.get(roomId)?.delete(userId);
  }

  status(a: Avatar): VoStatus {
    return displayStatus(a.attendance, a.manual, true);
  }

  /** ADR 048: in the office but not looking at it (every socket on another page, or none left). */
  away(a: Avatar): boolean {
    for (const s of a.sockets.values()) if (s.viewing) return false;
    return true;
  }

  rosterEntry(a: Avatar): RosterEntry {
    const act = a.action ? { kind: a.action.kind, since: a.action.since, ...(a.action.with ? { with: a.action.with } : {}), ...(a.action.seat ? { seat: a.action.seat, facing: a.action.facing } : {}) } : null;
    return { id: a.userId, name: a.name, status: this.status(a), statusMessage: a.message, floorId: a.floorId, roomId: a.roomId, away: this.away(a), avatar: a.avatarKey, action: act };
  }

  // ---------------------------------------------------------------- ADR 056 actions

  /** Everyone sees an action change with the next roster update; positions are not resent. */
  private rosterOnly(a: Avatar): void {
    this.rosterChanged = true;
    this.changedRoster.add(a.userId);
  }

  setAction(a: Avatar, kind: AvatarActionKind | null, now: number, extra: Partial<AvatarActionState> = {}): void {
    a.action = kind ? { kind, ...extra, since: now, until: kind === 'sit' ? null : now + ACTION_MS[kind] } : null;
    this.rosterOnly(a);
  }

  /** Who sits on a chair (null when free). */
  seatOccupant(floorId: string, seatId: string): Avatar | null {
    for (const a of this.avatars.values()) if (a.floorId === floorId && a.action?.kind === 'sit' && a.action.seat === seatId) return a;
    return null;
  }

  /**
   * Sit on a chair: it must exist on this floor, be free, be within reach in a straight walkable
   * line (never through a wall), and be in a room the person may enter. The avatar is placed on
   * the seat point, which mapSeats only produces where the collision map allows standing.
   */
  sit(a: Avatar, seatId: string, now: number): { ok: true } | { ok: false; code: 'NO_SEAT' | 'TAKEN' | 'TOO_FAR' | 'BLOCKED' | 'ROOM' } {
    const seat = this.seats.get(a.floorId)?.get(seatId);
    if (!seat) return { ok: false, code: 'NO_SEAT' };
    const other = this.seatOccupant(a.floorId, seatId);
    if (other && other.userId !== a.userId) return { ok: false, code: 'TAKEN' };
    if (Math.hypot(seat.x - a.x, seat.y - a.y) > SEAT_REACH) return { ok: false, code: 'TOO_FAR' };
    const g = this.grids.get(a.floorId);
    if (!g || !segmentClear(g, { x: a.x, y: a.y }, seat)) return { ok: false, code: 'BLOCKED' };
    const room = this.roomAt(a.floorId, seat);
    if (room && room.id !== a.roomId && this.mayEnter(a.userId, room, a.isAdmin)) return { ok: false, code: 'ROOM' };
    this.place(a, a.floorId, seat, now);
    this.setAction(a, 'sit', now, { seat: seat.id, facing: seat.facing });
    return { ok: true };
  }

  /** Close enough for a hug or a high five: same floor, same room (or both in the open), nearby. */
  pairReach(a: Avatar, b: Avatar): boolean {
    return a.floorId === b.floorId && a.roomId === b.roomId && Math.hypot(a.x - b.x, a.y - b.y) <= PAIR_REACH;
  }

  openRequest(kind: PairAction, from: string, to: string, now: number, ttlMs = PAIR_REQUEST_TTL_MS): PairRequest {
    const r: PairRequest = { id: randomUUID(), kind, from, to, expiresAt: now + ttlMs };
    this.requests.set(r.id, r);
    return r;
  }

  /** Ends a request and tells both people why. */
  closeRequest(r: PairRequest, reason: PairClosedMessage['reason'], emit?: WorldEmitter): void {
    if (!this.requests.delete(r.id)) return;
    const msg: PairClosedMessage = { id: r.id, kind: r.kind, from: r.from, to: r.to, accepted: reason === 'accepted', reason };
    emit?.personal?.(r.from, 'office:pair-closed', msg);
    emit?.personal?.(r.to, 'office:pair-closed', msg);
  }

  /**
   * ADR 053: someone saved another character. Everyone in the office gets the new roster entry on
   * the next tick; the version (and so the position stream) is left alone, since nothing moved.
   */
  setAvatar(userId: string, key: AvatarKey): boolean {
    const a = this.avatars.get(userId);
    if (!a || a.avatarKey === key) return false;
    a.avatarKey = key;
    this.rosterChanged = true;
    this.changedRoster.add(userId);
    return true;
  }

  /** Observers whose position stream was off get a full neighbourhood again when it comes back. */
  forgetKnown(userId: string): void {
    this.known.delete(userId);
  }

  /** Mark an avatar changed for the position stream and the roster. */
  touch(a: Avatar): void {
    a.version += 1;
    this.rosterChanged = true;
    this.changedRoster.add(a.userId);
  }

  roster(): RosterEntry[] {
    return [...this.avatars.values()].map((a) => this.rosterEntry(a));
  }

  /** Where someone appears: their desk seat, else the floor spawn. */
  startPoint(userId: string, floorId?: string): { floorId: string; p: Point } {
    const desk = this.desks.find((d) => d.assignedUserId === userId && (!floorId || d.floorId === floorId));
    if (desk) {
      const g = this.grids.get(desk.floorId);
      const p = g ? nearestWalkable(g, seat(desk)) : null;
      if (p) return { floorId: desk.floorId, p };
    }
    const f = floorId && this.grids.has(floorId) ? floorId : this.definition.floors[0]!.id;
    const g = this.grids.get(f)!;
    return { floorId: f, p: nearestWalkable(g, this.spawns.get(f)!) ?? this.spawns.get(f)! };
  }

  /** Validated movement. Returns the reason when refused (the caller sends back the authoritative position). */
  move(a: Avatar, to: Point, dir: number, now: number, ct: number | null): { ok: true } | { ok: false; reason: string } {
    const g = this.grids.get(a.floorId);
    if (!g) return { ok: false, reason: 'NO_FLOOR' };
    const verdict = validateMove(g, { x: a.x, y: a.y }, to, now - a.lastMoveAt);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    const room = this.roomAt(a.floorId, to);
    if (room && room.id !== a.roomId) {
      const denial = this.mayEnter(a.userId, room, a.isAdmin);
      if (denial) return { ok: false, reason: `ROOM_${denial}` };
    }
    const moved = Math.round(to.x) !== a.x || Math.round(to.y) !== a.y;
    this.place(a, a.floorId, to, now, dir, ct);
    // ADR 056: walking stands you up and ends a dance (a short wave or jump plays on).
    if (moved && (a.action?.kind === 'sit' || a.action?.kind === 'dance')) this.setAction(a, null, now);
    return { ok: true };
  }

  /** Puts an avatar somewhere (validated by the caller); tracks room changes. */
  place(a: Avatar, floorId: string, p: Point, now: number, dir = a.dir, ct: number | null = null): void {
    const before = a.roomId;
    a.floorId = floorId;
    a.x = Math.round(p.x);
    a.y = Math.round(p.y);
    a.dir = dir;
    a.lastMoveAt = now;
    a.ct = ct;
    a.roomId = this.roomAt(floorId, p)?.id ?? null;
    a.version += 1;
    if (before !== a.roomId) {
      // A knock admission lasts until you leave that room; password grants last for the visit.
      const prev = before ? this.rooms.find((r) => r.id === before) : null;
      if (prev && prev.accessMode === 'KNOCK') this.grants.get(a.userId)?.delete(prev.id);
      this.rosterChanged = true;
      this.changedRoster.add(a.userId);
    }
  }

  teleportTarget(floorId: string, p: Point): Point | null {
    const g = this.grids.get(floorId);
    return g ? nearestWalkable(g, p, 6) : null;
  }

  nearUser(target: Avatar): { floorId: string; p: Point } | null {
    const g = this.grids.get(target.floorId);
    if (!g) return null;
    for (const [dx, dy] of [[TILE_SIZE, 0], [-TILE_SIZE, 0], [0, TILE_SIZE], [0, -TILE_SIZE]] as const) {
      const p = nearestWalkable(g, { x: target.x + dx, y: target.y + dy }, 2);
      if (p && this.roomAt(target.floorId, p)?.id === target.roomId) return { floorId: target.floorId, p };
    }
    const p = nearestWalkable(g, { x: target.x, y: target.y }, 4);
    return p ? { floorId: target.floorId, p } : null;
  }

  roomCentre(room: RoomInfo): Point | null {
    return this.teleportTarget(room.floorId, centre(room.bounds));
  }

  deskSeat(desk: DeskInfo): Point | null {
    return this.teleportTarget(desk.floorId, seat(desk));
  }

  /** The 10 Hz tick: per-observer deltas of the neighbourhood, proximity changes, roster changes. */
  tick(emit: WorldEmitter, now: number, leaveGraceMs = 0): { messages: number; entries: number } {
    // ADR 056: actions run out; requests lapse, or end when one of the two has left.
    for (const a of this.avatars.values()) if (a.action && a.action.until !== null && now >= a.action.until) this.setAction(a, null, now);
    for (const r of [...this.requests.values()]) {
      if (!this.avatars.has(r.from) || !this.avatars.has(r.to)) this.closeRequest(r, 'gone', emit);
      else if (now >= r.expiresAt) this.closeRequest(r, 'timeout', emit);
    }
    // ADR 048: a dropped connection (reload) keeps its place for the grace, then is gone for everyone.
    for (const a of this.avatars.values()) {
      if (a.goneAt !== null && now - a.goneAt >= leaveGraceMs) { this.remove(a.userId); emit.roster(this.orgId, { id: a.userId, gone: true }); }
    }
    const all = [...this.avatars.values()];
    const interest = new InterestGrid(all.map((a) => ({ id: a.userId, floorId: a.floorId, x: a.x, y: a.y })));
    const entry = new Map<string, PositionEntry>();
    const entryOf = (a: Avatar): PositionEntry => {
      let e = entry.get(a.userId);
      // The mover's clock is echoed only for a move made since the previous tick, so a resend
      // (someone re-entering the neighbourhood, a status change) never looks like a slow delivery.
      if (!e) { e = [a.userId, a.x, a.y, a.dir, this.status(a), a.roomId, a.ct !== null && now - a.lastMoveAt <= 150 ? a.ct : null, this.away(a) ? 1 : 0]; entry.set(a.userId, e); }
      return e;
    };
    let messages = 0;
    let entries = 0;
    for (const obs of all) {
      if (![...obs.sockets.values()].some((s) => s.positions)) continue;
      const seen = this.known.get(obs.userId) ?? new Map<string, number>();
      const visible = interest.neighbourhood(obs.floorId, obs.x, obs.y);
      const u: PositionEntry[] = [];
      for (const id of visible) {
        if (id === obs.userId) continue;
        const a = this.avatars.get(id)!;
        if (seen.get(id) !== a.version) { u.push(entryOf(a)); seen.set(id, a.version); }
      }
      const gone: string[] = [];
      for (const id of seen.keys()) if (!visible.has(id) || !this.avatars.has(id)) { gone.push(id); seen.delete(id); }
      this.known.set(obs.userId, seen);
      if (u.length || gone.length) {
        emit.positions(obs.userId, { st: now, floorId: obs.floorId, u, gone });
        messages += 1;
        entries += u.length;
      }
    }
    // Proximity groups: only changes are sent.
    const groups = proximityGroups(all.map((a) => {
      const room = a.roomId ? this.rooms.find((r) => r.id === a.roomId) : null;
      return { id: a.userId, floorId: a.floorId, x: a.x, y: a.y, closedRoomId: room && isClosedRoom(room) ? room.id : null, roomOnly: a.roomOnly };
    }), this.proximityRadius);
    const groupOf = new Map<string, { id: string; members: string[] }>();
    for (const [id, members] of groups) for (const m of members) groupOf.set(m, { id, members });
    this.groupByUser.clear();
    for (const [u, g] of groupOf) this.groupByUser.set(u, g);
    for (const a of all) {
      const g = groupOf.get(a.userId);
      const sig = g ? `${g.id}|${g.members.join(',')}` : '';
      if ((this.lastGroup.get(a.userId) ?? '') !== sig) {
        this.lastGroup.set(a.userId, sig);
        emit.proximity(a.userId, { groupId: g?.id ?? null, members: g?.members ?? [] });
      }
    }
    if (this.rosterChanged) {
      for (const id of this.changedRoster) { const a = this.avatars.get(id); if (a) emit.roster(this.orgId, this.rosterEntry(a)); }
      this.changedRoster.clear();
      this.rosterChanged = false;
    }
    return { messages, entries };
  }

  remove(userId: string): void {
    this.avatars.delete(userId);
    this.known.delete(userId);
    this.lastGroup.delete(userId);
    this.groupByUser.delete(userId);
    this.grants.delete(userId);
    for (const k of this.knocks.values()) k.delete(userId);
  }
}
