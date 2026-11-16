import {
  ConnectedSocket, MessageBody, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import { OnModuleInit } from '@nestjs/common';
import argon2 from 'argon2';
import type { Server, Socket } from 'socket.io';
import type { ZodType } from 'zod';
import { PrismaService } from '../common/prisma.service.ts';
import { PermissionResolver } from '../common/permission-resolver.ts';
import { AttendanceGateway } from '../attendance/attendance.gateway.ts';
import { AttendanceService } from '../attendance/attendance.service.ts';
import { Permission } from '../../../../packages/shared/src/auth/types.ts';
import type { JwtPayload } from '../../../../packages/shared/src/index.ts';
import {
  ActionDtoSchema, avatarKeyOr, BoardAnswerDtoSchema, BoardIdDtoSchema, BoardInviteDtoSchema, BoardMoveDtoSchema, JoinDtoSchema, playMove, ModeDtoSchema, NUDGE_MAX_WAITING, NudgeAnswerDtoSchema, NudgeCancelDtoSchema, NudgeDtoSchema, nudgeReach, nudgeRules, NUDGES_PER_MINUTE, PAIR_REQUEST_TTL_MS, PairAnswerDtoSchema, PairCancelDtoSchema, PairRequestDtoSchema, SitDtoSchema, MoveDtoSchema, RoomAnswerDtoSchema, RoomKnockDtoSchema, TeleportDtoSchema, ViewDtoSchema,
} from '../../../../packages/shared/src/office/index.ts';
import type { ActionAck, BoardAck, BoardInviteMessage, JoinAck, ManualStatus, MoveAck, NudgeAck, NudgeAnswerAck, NudgeRequestMessage, PairAck, PairRequestMessage, SitAck, TeleportAck } from '../../../../packages/shared/src/office/index.ts';
import { OfficeRegistry } from './office-registry.ts';
import { OfficePresenceStore } from './office-presence.ts';
import type { Avatar, OfficeWorld, WorldEmitter } from './office-world.ts';

/** From AttendanceGateway.authenticate: the JWT and its session family (stable across refresh rotations). */
interface SocketAuth { user: JwtPayload; familyId?: string }

const MOVE_RATE_PER_S = 15;
const PASSWORD_ATTEMPTS_PER_MIN = 5;
const KNOCK_COOLDOWN_MS = 10_000;
/** ADR 056: solo actions and sitting, per person; and one hug / high-five request per 3 s. */
const ACTIONS_PER_WINDOW = 8;
const ACTION_WINDOW_MS = 5_000;
const PAIR_COOLDOWN_MS = 3_000;
const NUDGE_RATE_WINDOW_MS = 60_000;
/** FR-VO-017: one board invitation per 3 s per person; at most 20 moves per 5 s. */
const BOARD_INVITE_COOLDOWN_MS = 3_000;
const BOARD_MOVES_PER_WINDOW = 20;

function parse<T>(schema: ZodType<T>, body: unknown): T | null {
  const r = schema.safeParse(body ?? {});
  return r.success ? r.data : null;
}

/**
 * Virtual office socket events (SRS 8.4, ADR 015) on the same Socket.IO server as attendance,
 * which authenticates every connection. Rooms used:
 *   vo-org:<orgId>      everyone in the office (roster: join, leave, room, status)
 *   vo:<userId>         one person (proximity, knocks)
 *   vo:<userId>:pos     sockets that want the 10 Hz position stream (map view)
 */
@WebSocketGateway()
export class OfficeGateway implements OnGatewayDisconnect, OnModuleInit {
  @WebSocketServer()
  server!: Server;

  private readonly moveWindow = new Map<string, { at: number; n: number }>();
  private readonly passwordTries = new Map<string, { at: number; n: number }>();
  private readonly lastKnock = new Map<string, number>();
  private readonly actionWindow = new Map<string, { at: number; n: number }>();
  private readonly lastPair = new Map<string, number>();
  /** ADR 058: when each sender last nudged each person ("from>to"), and each sender's recent nudges. */
  private readonly nudgedAt = new Map<string, number>();
  private readonly nudgeTimes = new Map<string, number[]>();
  private readonly lastBoardInvite = new Map<string, number>();
  private readonly boardMoveWindow = new Map<string, { at: number; n: number }>();
  /** ADR 056: tells one person's sockets about their pair requests. */
  private readonly personalEmitter: WorldEmitter = {
    positions: () => undefined, proximity: () => undefined, roster: () => undefined,
    personal: (userId, event, payload) => this.server?.to(`vo:${userId}`).emit(event, payload),
  };

  constructor(
    private readonly registry: OfficeRegistry,
    private readonly resolver: PermissionResolver,
    private readonly prisma: PrismaService,
    private readonly attendanceGateway: AttendanceGateway,
    private readonly attendance: AttendanceService,
    private readonly presence: OfficePresenceStore,
  ) {}

  onModuleInit(): void {
    this.registry.start({
      positions: (userId, msg) => this.server?.to(`vo:${userId}:pos`).emit('office:positions', msg),
      proximity: (userId, msg) => this.server?.to(`vo:${userId}`).emit('office:proximity', msg),
      roster: (orgId, entry) => this.server?.to(`vo-org:${orgId}`).emit('office:presence', entry),
      personal: (userId, event, payload) => this.server?.to(`vo:${userId}`).emit(event, payload),
      // ADR 059: the grace ran out: the connection ended when it dropped, not now.
      left: (orgId, userId, droppedAt) => this.presence.closed(orgId, userId, droppedAt, 'DROPPED'),
    });
    // FR-VO-003: the attendance engine is the source of truth for the presence ring.
    this.attendanceGateway.onPresence((orgId, userId, state) => {
      const w = this.registry.peek(orgId);
      const a = w?.avatars.get(userId);
      if (!w || !a || a.attendance === state) return;
      a.attendance = state;
      a.version += 1;
      w.rosterChanged = true;
      w.changedRoster.add(userId);
    });
  }

  private auth(client: Socket): SocketAuth | null {
    return (client.data?.auth as SocketAuth | undefined) ?? null;
  }

  private avatarOf(world: OfficeWorld, client: Socket): Avatar | null {
    const auth = this.auth(client);
    const a = auth ? world.avatars.get(auth.user.sub) : undefined;
    return a && a.sockets.has(client.id) ? a : null;
  }

  /** FR-VO-010: every socket of the organisation (office and attendance) sees the announcement. */
  broadcast(orgId: string, msg: { id: string; message: string; from: string; at: string }): void {
    this.server?.to(`org:${orgId}`).emit('office:broadcast', msg);
  }

  @SubscribeMessage('office:join')
  async join(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): Promise<JoinAck> {
    const auth = this.auth(client);
    const dto = parse(JoinDtoSchema, body);
    if (!auth || !dto) return { ok: false, error: 'Bad request' };
    let access;
    try {
      access = await this.resolver.resolve({ id: auth.user.sub, orgId: auth.user.orgId });
    } catch {
      return { ok: false, error: 'Unauthorized' };
    }
    if (!access.permissions.includes(Permission.OFFICE_USE)) return { ok: false, error: 'Forbidden' };
    const orgId = auth.user.orgId;
    const userId = auth.user.sub;
    const world = await this.registry.world(orgId);
    let a = world.avatars.get(userId);
    // ADR 048: the place is kept for the login session that dropped (a reload, whose refresh rotates the
    // token but not the session family); a new sign-in starts fresh.
    if (a && a.goneAt !== null && a.goneSid !== (auth.familyId ?? null)) {
      this.presence.closed(orgId, userId, a.goneAt, 'DROPPED'); // ADR 059: the old sign-in's connection ended when it dropped
      world.remove(userId);
      this.server?.to(`vo-org:${orgId}`).emit('office:presence', { id: userId, gone: true });
      a = undefined;
    }
    if (!a) {
      const u = await this.prisma.runWithTenantContext(orgId, async (db) => (await db.query<{ display_name: string | null; email: string; vo_status: ManualStatus; vo_status_message: string; vo_avatar_key: string }>(
        `SELECT display_name, email, vo_status, vo_status_message, vo_avatar_key FROM users WHERE id = $1`, [userId])).rows[0]);
      if (!u) return { ok: false, error: 'Unauthorized' };
      let attendanceState: string | null = null;
      try { attendanceState = (await this.attendance.getMyToday(orgId, userId)).state; } catch { attendanceState = null; }
      const start = world.startPoint(userId, dto.floorId);
      a = {
        userId, name: u.display_name ?? u.email, floorId: start.floorId, x: 0, y: 0, dir: 0, roomId: null, lastMoveAt: 0, version: 0,
        attendance: attendanceState, manual: u.vo_status, message: u.vo_status_message, roomOnly: false,
        isAdmin: access.permissions.includes(Permission.ORG_MANAGE), sockets: new Map(), ct: null, goneAt: null, goneSid: null,
        avatarKey: avatarKeyOr(u.vo_avatar_key),
      };
      world.avatars.set(userId, a);
      this.presence.opened(orgId, userId, Date.now()); // ADR 059: first office connection
      world.place(a, start.floorId, start.p, Date.now());
      world.rosterChanged = true;
      world.changedRoster.add(userId);
    }
    // ADR 048: a rejoin within the leave grace (a reload) keeps the avatar where it was.
    a.goneAt = null;
    a.goneSid = null;
    const wasAway = world.away(a);
    a.sockets.set(client.id, { positions: dto.positions, viewing: dto.visible });
    if (wasAway !== world.away(a)) world.touch(a);
    client.data.officeOrg = orgId;
    await client.join([`vo-org:${orgId}`, `vo:${userId}`]);
    if (dto.positions) { world.forgetKnown(userId); await client.join(`vo:${userId}:pos`); }
    // FR-VO-017: a game still running after a reload (within the grace) comes back on screen.
    const game = world.boardGameOf(userId);
    if (game) client.emit('office:board', world.boardSnapshot(game));
    return { ok: true, self: { x: a.x, y: a.y, floorId: a.floorId, roomId: a.roomId }, roster: world.roster(), nudge: nudgeRules(process.env) };
  }

  /** ADR 048: the office view came on or off screen; the position stream follows the map. */
  @SubscribeMessage('office:view')
  async view(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): Promise<{ ok: boolean }> {
    const orgId = client.data?.officeOrg as string | undefined;
    const world = orgId ? this.registry.peek(orgId) : null;
    const a = world ? this.avatarOf(world, client) : null;
    const dto = parse(ViewDtoSchema, body);
    if (!world || !a || !dto) return { ok: false };
    const wasAway = world.away(a);
    const had = a.sockets.get(client.id)?.positions ?? false;
    a.sockets.set(client.id, { positions: dto.positions, viewing: dto.visible });
    if (wasAway !== world.away(a)) world.touch(a);
    if (dto.positions && !had) { world.forgetKnown(a.userId); await client.join(`vo:${a.userId}:pos`); }
    else if (!dto.positions && had) await client.leave(`vo:${a.userId}:pos`);
    return { ok: true };
  }

  @SubscribeMessage('office:leave')
  async leave(@ConnectedSocket() client: Socket): Promise<{ ok: true }> {
    await this.detach(client, true);
    return { ok: true };
  }

  async handleDisconnect(client: Socket): Promise<void> {
    await this.detach(client, false);
  }

  /** `explicit`: the user left (remove now); otherwise the connection dropped (kept for the grace, ADR 048). */
  private async detach(client: Socket, explicit: boolean): Promise<void> {
    const auth = this.auth(client);
    const orgId = client.data?.officeOrg as string | undefined;
    if (!auth || !orgId) return;
    const world = this.registry.peek(orgId);
    const a = world?.avatars.get(auth.user.sub);
    this.moveWindow.delete(client.id);
    if (!world || !a) return;
    const wasAway = world.away(a);
    a.sockets.delete(client.id);
    for (const room of [`vo-org:${orgId}`, `vo:${a.userId}`, `vo:${a.userId}:pos`]) void client.leave(room);
    if (a.sockets.size === 0) {
      // ADR 056: nobody is behind the avatar any more: no action, no chair, no open request.
      if (a.action) world.setAction(a, null, Date.now());
      for (const r of [...world.requests.values()]) if (r.from === a.userId || r.to === a.userId) world.closeRequest(r, 'gone', this.personalEmitter);
      // ADR 058: and no nudge waiting on them, or for them.
      for (const n of [...world.nudges.values()]) if (n.from === a.userId || n.to === a.userId) world.closeNudge(n, 'gone', this.personalEmitter);
      // FR-VO-017: no board invitation waiting on them; a game ends at once if they left on purpose
      // (after a dropped connection it waits for the grace: the tick ends it when they are gone).
      for (const i of [...world.boardInvites.values()]) if (i.from === a.userId || i.to === a.userId) world.closeBoardInvite(i, 'gone', this.personalEmitter);
      const game = world.boardGameOf(a.userId);
      if (game && (explicit || this.registry.leaveGraceMs === 0)) world.endBoardGame(game, { winner: game.white.id === a.userId ? 'b' : 'w', reason: 'left' }, this.personalEmitter);
      this.lastBoardInvite.delete(a.userId);
      this.boardMoveWindow.delete(a.userId);
      this.actionWindow.delete(a.userId);
      this.lastPair.delete(a.userId);
      if (explicit || this.registry.leaveGraceMs === 0) {
        this.presence.closed(orgId, a.userId, Date.now(), explicit ? 'LEFT' : 'DROPPED'); // ADR 059
        world.remove(a.userId);
        this.server?.to(`vo-org:${orgId}`).emit('office:presence', { id: a.userId, gone: true });
        return;
      }
      a.goneAt = Date.now();
      a.goneSid = auth.familyId ?? null;
    }
    if (wasAway !== world.away(a)) world.touch(a);
  }

  @SubscribeMessage('office:move')
  move(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): MoveAck {
    const orgId = client.data?.officeOrg as string | undefined;
    const world = orgId ? this.registry.peek(orgId) : null;
    const a = world ? this.avatarOf(world, client) : null;
    if (!world || !a) return { ok: false, reason: 'NOT_JOINED', x: 0, y: 0, floorId: '', roomId: null };
    const now = Date.now();
    const win = this.moveWindow.get(client.id);
    const refuse = (reason: string): MoveAck => ({ ok: false, reason, x: a.x, y: a.y, floorId: a.floorId, roomId: a.roomId });
    if (!win || now - win.at >= 1000) this.moveWindow.set(client.id, { at: now, n: 1 });
    else if ((win.n += 1) > MOVE_RATE_PER_S) return refuse('RATE_LIMITED');
    const dto = parse(MoveDtoSchema, body);
    if (!dto) return refuse('BAD_REQUEST');
    const r = world.move(a, { x: dto.x, y: dto.y }, dto.dir, now, dto.ct ?? null);
    // The room comes from the server's own room check (OfficeWorld.place), never from the client.
    return r.ok ? { ok: true, roomId: a.roomId } : refuse(r.reason);
  }

  /** FR-VO-007: go to my desk, to a colleague, to a room (with its password), or to another floor. */
  @SubscribeMessage('office:teleport')
  async teleport(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): Promise<TeleportAck> {
    const orgId = client.data?.officeOrg as string | undefined;
    const world = orgId ? this.registry.peek(orgId) : null;
    const a = world ? this.avatarOf(world, client) : null;
    const dto = parse(TeleportDtoSchema, body);
    if (!world || !a) return { ok: false, error: 'Join the office first' };
    if (!dto) return { ok: false, error: 'Bad request' };
    const now = Date.now();
    const done = (floorId: string, p: { x: number; y: number } | null): TeleportAck => {
      if (!p) return { ok: false, error: 'No free spot there', code: 'NOT_FOUND' };
      world.place(a, floorId, p, now);
      // ADR 056: a teleport stands you up from a chair and ends a dance.
      if (a.action?.kind === 'sit' || a.action?.kind === 'dance') world.setAction(a, null, now);
      return { ok: true, x: a.x, y: a.y, floorId: a.floorId, roomId: a.roomId };
    };
    const deny = (code: 'KNOCK' | 'INVITE' | 'PASSWORD' | 'FULL'): TeleportAck => ({
      ok: false, code,
      error: { KNOCK: 'Knock to ask the people inside to let you in', INVITE: 'This room is invite-only', PASSWORD: 'This room needs its password', FULL: 'This room is full' }[code],
    });
    if (dto.kind === 'desk') {
      const desk = world.desks.find((d) => d.assignedUserId === a.userId);
      if (!desk) return { ok: false, error: 'You have no desk yet', code: 'NOT_FOUND' };
      return done(desk.floorId, world.deskSeat(desk));
    }
    if (dto.kind === 'floor') {
      if (!world.grids.has(dto.floorId)) return { ok: false, error: 'No such floor', code: 'NOT_FOUND' };
      const s = world.startPoint('', dto.floorId);
      return done(s.floorId, s.p);
    }
    if (dto.kind === 'user') {
      const target = world.avatars.get(dto.userId);
      if (!target || target.userId === a.userId) return { ok: false, error: 'This person is not in the office', code: 'NOT_FOUND' };
      const room = target.roomId ? world.rooms.find((r) => r.id === target.roomId) : null;
      if (room && room.id !== a.roomId) { const d = world.mayEnter(a.userId, room, a.isAdmin); if (d) return deny(d); }
      const near = world.nearUser(target);
      return near ? done(near.floorId, near.p) : { ok: false, error: 'No free spot there', code: 'NOT_FOUND' };
    }
    const room = world.rooms.find((r) => r.id === dto.roomId);
    if (!room) return { ok: false, error: 'Room not found', code: 'NOT_FOUND' };
    let denial = world.mayEnter(a.userId, room, a.isAdmin, room.id === a.roomId);
    if (denial === 'PASSWORD' && dto.password !== undefined) {
      const key = `${a.userId}:${room.id}`;
      const t = this.passwordTries.get(key);
      if (t && now - t.at < 60_000 && t.n >= PASSWORD_ATTEMPTS_PER_MIN) return { ok: false, error: 'Too many attempts; wait a minute', code: 'RATE_LIMITED' };
      const ok = room.passwordHash ? await argon2.verify(room.passwordHash, dto.password).catch(() => false) : false;
      if (!ok) {
        this.passwordTries.set(key, t && now - t.at < 60_000 ? { at: t.at, n: t.n + 1 } : { at: now, n: 1 });
        return { ok: false, error: 'Wrong room password', code: 'BAD_PASSWORD' };
      }
      this.passwordTries.delete(key);
      world.grant(a.userId, room.id);
      denial = world.mayEnter(a.userId, room, a.isAdmin);
    }
    if (denial) return deny(denial);
    return done(room.floorId, world.roomCentre(room));
  }

  /** FR-VO-004 / 008: knock-to-enter; anyone inside answers. */
  @SubscribeMessage('room:knock')
  knock(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): { ok: boolean; error?: string } {
    const orgId = client.data?.officeOrg as string | undefined;
    const world = orgId ? this.registry.peek(orgId) : null;
    const a = world ? this.avatarOf(world, client) : null;
    const dto = parse(RoomKnockDtoSchema, body);
    if (!world || !a || !dto) return { ok: false, error: 'Bad request' };
    const room = world.rooms.find((r) => r.id === dto.roomId);
    if (!room) return { ok: false, error: 'Room not found' };
    if (room.accessMode !== 'KNOCK') return { ok: false, error: 'This room does not take knocks' };
    const occupants = world.occupants(room.id);
    if (occupants.length === 0) return { ok: false, error: 'Nobody is in the room to let you in' };
    const key = `${a.userId}:${room.id}`;
    const now = Date.now();
    if (now - (this.lastKnock.get(key) ?? 0) < KNOCK_COOLDOWN_MS) return { ok: false, error: 'You knocked a moment ago' };
    this.lastKnock.set(key, now);
    const knocks = world.knocks.get(room.id) ?? new Map<string, number>();
    knocks.set(a.userId, now);
    world.knocks.set(room.id, knocks);
    for (const o of occupants) this.server.to(`vo:${o.userId}`).emit('room:knock', { roomId: room.id, roomName: room.name, userId: a.userId, name: a.name });
    return { ok: true };
  }

  @SubscribeMessage('room:answer')
  answer(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): { ok: boolean; error?: string } {
    const orgId = client.data?.officeOrg as string | undefined;
    const world = orgId ? this.registry.peek(orgId) : null;
    const a = world ? this.avatarOf(world, client) : null;
    const dto = parse(RoomAnswerDtoSchema, body);
    if (!world || !a || !dto) return { ok: false, error: 'Bad request' };
    if (a.roomId !== dto.roomId) return { ok: false, error: 'Only people inside the room can answer' };
    if (!world.knocks.get(dto.roomId)?.has(dto.userId)) return { ok: false, error: 'Nobody is knocking' };
    world.knocks.get(dto.roomId)!.delete(dto.userId);
    if (dto.admit) world.grant(dto.userId, dto.roomId);
    this.server.to(`vo:${dto.userId}`).emit('room:answered', { roomId: dto.roomId, admit: dto.admit, by: a.name });
    for (const o of world.occupants(dto.roomId)) if (o.userId !== a.userId) this.server.to(`vo:${o.userId}`).emit('room:knock-handled', { roomId: dto.roomId, userId: dto.userId });
    return { ok: true };
  }

  // ---------------------------------------------------------------- ADR 056 avatar actions
  // All of them act on the caller's own avatar in the caller's own organisation's world, found
  // through the authenticated socket; nothing here touches attendance, status or meetings.

  private joined(client: Socket): { world: OfficeWorld; a: Avatar } | null {
    const orgId = client.data?.officeOrg as string | undefined;
    const world = orgId ? this.registry.peek(orgId) : null;
    const a = world ? this.avatarOf(world, client) : null;
    return world && a ? { world, a } : null;
  }

  private actionAllowed(userId: string, now: number): boolean {
    const w = this.actionWindow.get(userId);
    if (!w || now - w.at >= ACTION_WINDOW_MS) { this.actionWindow.set(userId, { at: now, n: 1 }); return true; }
    w.n += 1;
    return w.n <= ACTIONS_PER_WINDOW;
  }

  /** Jump, wave, dance, or stop (ends a dance or a wave). */
  @SubscribeMessage('office:action')
  action(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): ActionAck {
    const j = this.joined(client);
    if (!j) return { ok: false, error: 'Join the office first', code: 'NOT_JOINED' };
    const dto = parse(ActionDtoSchema, body);
    if (!dto) return { ok: false, error: 'Bad request', code: 'BAD_REQUEST' };
    const now = Date.now();
    if (!this.actionAllowed(j.a.userId, now)) return { ok: false, error: 'Slow down a little', code: 'RATE_LIMITED' };
    const { world, a } = j;
    if (dto.kind === 'stop') {
      if (a.action && a.action.kind !== 'sit') world.setAction(a, null, now);
      return { ok: true };
    }
    // A jump, wave or dance replaces sitting: the person stands up for it.
    world.setAction(a, dto.kind, now);
    return { ok: true };
  }

  @SubscribeMessage('office:sit')
  sit(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): SitAck {
    const j = this.joined(client);
    if (!j) return { ok: false, error: 'Join the office first', code: 'NOT_JOINED' };
    const dto = parse(SitDtoSchema, body);
    if (!dto) return { ok: false, error: 'Bad request', code: 'BAD_REQUEST' };
    const now = Date.now();
    if (!this.actionAllowed(j.a.userId, now)) return { ok: false, error: 'Slow down a little', code: 'RATE_LIMITED' };
    const r = j.world.sit(j.a, dto.seatId, now);
    if (!r.ok) {
      const error = { NO_SEAT: 'There is no chair there', TAKEN: 'Someone is sitting there', TOO_FAR: 'Walk up to the chair first', BLOCKED: 'You cannot reach that chair from here', ROOM: 'That chair is in a room you may not enter' }[r.code];
      return { ok: false, error, code: r.code };
    }
    return { ok: true, x: j.a.x, y: j.a.y, roomId: j.a.roomId };
  }

  @SubscribeMessage('office:stand')
  stand(@ConnectedSocket() client: Socket): ActionAck {
    const j = this.joined(client);
    if (!j) return { ok: false, error: 'Join the office first', code: 'NOT_JOINED' };
    if (j.a.action?.kind === 'sit') j.world.setAction(j.a, null, Date.now());
    return { ok: true };
  }

  /** Ask someone nearby for a hug or a high five; nothing happens until they accept. */
  @SubscribeMessage('office:pair')
  pair(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): PairAck {
    const j = this.joined(client);
    if (!j) return { ok: false, error: 'Join the office first', code: 'NOT_JOINED' };
    const dto = parse(PairRequestDtoSchema, body);
    if (!dto) return { ok: false, error: 'Bad request', code: 'BAD_REQUEST' };
    const { world, a } = j;
    const now = Date.now();
    if (now - (this.lastPair.get(a.userId) ?? 0) < PAIR_COOLDOWN_MS) return { ok: false, error: 'You asked a moment ago', code: 'RATE_LIMITED' };
    // Another organisation's people are not in this world: "not found", like anyone absent.
    const b = world.avatars.get(dto.to);
    if (!b || b.userId === a.userId || b.goneAt !== null) return { ok: false, error: 'This person is not here', code: 'NOT_FOUND' };
    if (!world.pairReach(a, b)) return { ok: false, error: 'Stand next to them first', code: 'TOO_FAR' };
    for (const r of world.requests.values()) {
      if (r.from === a.userId) return { ok: false, error: 'You are already waiting for an answer', code: 'PENDING' };
      if (r.to === b.userId || r.from === b.userId) return { ok: false, error: 'They are busy with another request', code: 'BUSY' };
    }
    if (world.status(b) === 'DND' || world.away(b)) return { ok: false, error: 'They are not available right now', code: 'BUSY' };
    this.lastPair.set(a.userId, now);
    // OFFICE_PAIR_TTL_MS: shorter in tests (like OFFICE_LEAVE_GRACE_MS); 15 s by default.
    const ttl = Math.max(1_000, Number(process.env.OFFICE_PAIR_TTL_MS ?? PAIR_REQUEST_TTL_MS) || PAIR_REQUEST_TTL_MS);
    const r = world.openRequest(dto.kind, a.userId, b.userId, now, ttl);
    const msg: PairRequestMessage = { id: r.id, kind: r.kind, from: a.userId, fromName: a.name, expiresInMs: r.expiresAt - now };
    this.server.to(`vo:${b.userId}`).emit('office:pair-request', msg);
    return { ok: true, id: r.id, expiresInMs: r.expiresAt - now };
  }

  /** The person asked says yes or no. A yes still needs both to be close together. */
  @SubscribeMessage('office:pair-answer')
  pairAnswer(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): ActionAck {
    const j = this.joined(client);
    if (!j) return { ok: false, error: 'Join the office first', code: 'NOT_JOINED' };
    const dto = parse(PairAnswerDtoSchema, body);
    if (!dto) return { ok: false, error: 'Bad request', code: 'BAD_REQUEST' };
    const { world, a } = j;
    const r = world.requests.get(dto.id);
    if (!r || r.to !== a.userId) return { ok: false, error: 'That request is no longer open' };
    const emit = this.personalEmitter;
    if (!dto.accept) { world.closeRequest(r, 'declined', emit); return { ok: true }; }
    const from = world.avatars.get(r.from);
    if (!from) { world.closeRequest(r, 'gone', emit); return { ok: false, error: 'They have left' }; }
    if (!world.pairReach(from, a)) { world.closeRequest(r, 'too-far', emit); return { ok: false, error: 'You are no longer next to each other' }; }
    const now = Date.now();
    world.setAction(from, r.kind, now, { with: a.userId });
    world.setAction(a, r.kind, now, { with: from.userId });
    world.closeRequest(r, 'accepted', emit);
    return { ok: true };
  }

  @SubscribeMessage('office:pair-cancel')
  pairCancel(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): ActionAck {
    const j = this.joined(client);
    if (!j) return { ok: false, error: 'Join the office first', code: 'NOT_JOINED' };
    const dto = parse(PairCancelDtoSchema, body);
    if (!dto) return { ok: false, error: 'Bad request', code: 'BAD_REQUEST' };
    const r = j.world.requests.get(dto.id);
    if (!r || r.from !== j.a.userId) return { ok: false, error: 'That request is no longer open' };
    j.world.closeRequest(r, 'cancelled', this.personalEmitter);
    return { ok: true };
  }

  // ---------------------------------------------------------------- ADR 058 nudge
  // A bell for someone nearby. Both people are looked up in the caller's own organisation's world,
  // found through the authenticated socket, so a nudge can never reach another organisation.
  // Nothing is stored and nothing but the two people's notifications changes.

  /** Forgets cooldowns that have run out, so the map cannot grow without bound. */
  private pruneNudges(now: number, cooldownMs: number): void {
    if (this.nudgedAt.size < 2_000) return;
    for (const [k, at] of this.nudgedAt) if (now - at >= cooldownMs) this.nudgedAt.delete(k);
  }

  @SubscribeMessage('office:nudge')
  nudge(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): NudgeAck {
    const j = this.joined(client);
    if (!j) return { ok: false, error: 'Join the office first', code: 'NOT_JOINED' };
    const dto = parse(NudgeDtoSchema, body);
    if (!dto) return { ok: false, error: 'Bad request', code: 'BAD_REQUEST' };
    const { world, a } = j;
    const rules = nudgeRules(process.env);
    const now = Date.now();
    if (dto.to === a.userId) return { ok: false, error: 'You cannot nudge yourself', code: 'SELF' };
    // Another organisation's people are not in this world: "not here", like anyone absent.
    const b = world.avatars.get(dto.to);
    if (!b || b.goneAt !== null) return { ok: false, error: 'This person is not here', code: 'NOT_FOUND' };
    if (!nudgeReach(a, b, rules.reachPx)) return { ok: false, error: 'Walk closer to them first', code: 'TOO_FAR' };
    if (world.status(b) === 'DND') return { ok: false, error: `${b.name} does not want to be disturbed`, code: 'DND' };
    if (world.away(b)) return { ok: false, error: `${b.name} is not looking at the office right now`, code: 'AWAY' };
    let waiting = 0;
    for (const n of world.nudges.values()) {
      if (n.from === a.userId) return { ok: false, error: 'You are already waiting for an answer', code: 'PENDING' };
      if (n.to === b.userId) waiting += 1;
    }
    if (waiting >= NUDGE_MAX_WAITING) return { ok: false, error: `${b.name} has several nudges waiting`, code: 'BUSY' };
    const key = `${a.userId}>${b.userId}`;
    const since = now - (this.nudgedAt.get(key) ?? -Infinity);
    if (since < rules.cooldownMs) return { ok: false, error: `You nudged ${b.name} a moment ago`, code: 'COOLDOWN', retryInMs: rules.cooldownMs - since };
    const recent = (this.nudgeTimes.get(a.userId) ?? []).filter((t) => now - t < NUDGE_RATE_WINDOW_MS);
    if (recent.length >= NUDGES_PER_MINUTE) return { ok: false, error: 'That is a lot of nudges; wait a little', code: 'RATE_LIMITED', retryInMs: NUDGE_RATE_WINDOW_MS - (now - recent[0]!) };
    this.nudgeTimes.set(a.userId, [...recent, now]);
    this.nudgedAt.set(key, now);
    this.pruneNudges(now, rules.cooldownMs);
    const n = world.openNudge(a.userId, b.userId, now, rules.ttlMs);
    const msg: NudgeRequestMessage = { id: n.id, from: a.userId, fromName: a.name, expiresInMs: rules.ttlMs };
    this.server.to(`vo:${b.userId}`).emit('office:nudge-request', msg);
    return { ok: true, id: n.id, expiresInMs: rules.ttlMs };
  }

  /** The person nudged accepts or ignores; both are told. Only that person can answer. */
  @SubscribeMessage('office:nudge-answer')
  nudgeAnswer(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): NudgeAnswerAck {
    const j = this.joined(client);
    if (!j) return { ok: false, error: 'Join the office first', code: 'NOT_JOINED' };
    const dto = parse(NudgeAnswerDtoSchema, body);
    if (!dto) return { ok: false, error: 'Bad request', code: 'BAD_REQUEST' };
    const n = j.world.nudges.get(dto.id);
    if (!n || n.to !== j.a.userId) return { ok: false, error: 'That nudge is no longer open', code: 'NOT_OPEN' };
    j.world.closeNudge(n, dto.accept ? 'accepted' : 'ignored', this.personalEmitter);
    return { ok: true };
  }

  /** The sender takes it back. Only the sender can. */
  @SubscribeMessage('office:nudge-cancel')
  nudgeCancel(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): NudgeAnswerAck {
    const j = this.joined(client);
    if (!j) return { ok: false, error: 'Join the office first', code: 'NOT_JOINED' };
    const dto = parse(NudgeCancelDtoSchema, body);
    if (!dto) return { ok: false, error: 'Bad request', code: 'BAD_REQUEST' };
    const n = j.world.nudges.get(dto.id);
    if (!n || n.from !== j.a.userId) return { ok: false, error: 'That nudge is no longer open', code: 'NOT_OPEN' };
    j.world.closeNudge(n, 'cancelled', this.personalEmitter);
    return { ok: true };
  }

  // ---------------------------------------------------------------- FR-VO-017 board games (ADR 062)
  // Chess and checkers at a game table, between two people standing at it. Both are looked up in
  // the caller's own organisation's world (never another organisation's); every move is checked
  // with the shared rules; games are in memory only and end when a player resigns or leaves.

  @SubscribeMessage('office:board-invite')
  boardInvite(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): BoardAck {
    const j = this.joined(client);
    if (!j) return { ok: false, error: 'Join the office first', code: 'NOT_JOINED' };
    const dto = parse(BoardInviteDtoSchema, body);
    if (!dto) return { ok: false, error: 'Bad request', code: 'BAD_REQUEST' };
    const { world, a } = j;
    const now = Date.now();
    if (now - (this.lastBoardInvite.get(a.userId) ?? 0) < BOARD_INVITE_COOLDOWN_MS) return { ok: false, error: 'You asked a moment ago', code: 'RATE_LIMITED' };
    if (dto.to === a.userId) return { ok: false, error: 'Invite someone else', code: 'SELF' };
    const b = world.avatars.get(dto.to);
    if (!b || b.goneAt !== null) return { ok: false, error: 'This person is not here', code: 'NOT_FOUND' };
    const table = world.boardTable(a.floorId, dto.tableId, dto.kind);
    if (!table) return { ok: false, error: `That table has no ${dto.kind}`, code: 'NO_TABLE' };
    if (!world.atTable(a, a.floorId, table)) return { ok: false, error: 'Walk up to the table first', code: 'TOO_FAR' };
    if (!world.atTable(b, a.floorId, table)) return { ok: false, error: `${b.name} is not at the table`, code: 'TOO_FAR' };
    if (world.tableBusy(a.floorId, dto.tableId)) return { ok: false, error: 'A game is already being played at this table', code: 'BUSY' };
    if (world.boardGameOf(a.userId)) return { ok: false, error: 'Finish your game first', code: 'PLAYING' };
    if (world.boardGameOf(b.userId)) return { ok: false, error: `${b.name} is already playing`, code: 'BUSY' };
    if (world.status(b) === 'DND' || world.away(b)) return { ok: false, error: `${b.name} is not available right now`, code: 'BUSY' };
    for (const i of world.boardInvites.values()) {
      if (i.from === a.userId) return { ok: false, error: 'You are already waiting for an answer', code: 'PENDING' };
      if (i.to === b.userId) return { ok: false, error: `${b.name} has an invitation waiting`, code: 'BUSY' };
    }
    this.lastBoardInvite.set(a.userId, now);
    const ttl = Math.max(1_000, Number(process.env.OFFICE_BOARD_INVITE_TTL_MS ?? 0) || 30_000);
    const inv = world.openBoardInvite(dto.kind, a.floorId, dto.tableId, a.userId, b.userId, now, ttl);
    const msg: BoardInviteMessage = { id: inv.id, from: a.userId, fromName: a.name, kind: inv.kind, tableId: inv.tableId, expiresInMs: ttl };
    this.server.to(`vo:${b.userId}`).emit('office:board-invite', msg);
    return { ok: true, id: inv.id };
  }

  /** The person invited accepts or declines. A yes still needs both at the table and the table free. */
  @SubscribeMessage('office:board-answer')
  boardAnswer(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): BoardAck {
    const j = this.joined(client);
    if (!j) return { ok: false, error: 'Join the office first', code: 'NOT_JOINED' };
    const dto = parse(BoardAnswerDtoSchema, body);
    if (!dto) return { ok: false, error: 'Bad request', code: 'BAD_REQUEST' };
    const { world, a } = j;
    const inv = world.boardInvites.get(dto.id);
    if (!inv || inv.to !== a.userId) return { ok: false, error: 'That invitation is no longer open', code: 'NOT_OPEN' };
    const emit = this.personalEmitter;
    if (!dto.accept) { world.closeBoardInvite(inv, 'declined', emit); return { ok: true }; }
    const from = world.avatars.get(inv.from);
    const table = world.boardTable(inv.floorId, inv.tableId, inv.kind);
    if (!from || from.goneAt !== null || !table) { world.closeBoardInvite(inv, 'gone', emit); return { ok: false, error: 'They have left', code: 'GONE' }; }
    if (!world.atTable(from, inv.floorId, table) || !world.atTable(a, inv.floorId, table)) { world.closeBoardInvite(inv, 'too-far', emit); return { ok: false, error: 'You both need to be at the table', code: 'TOO_FAR' }; }
    if (world.tableBusy(inv.floorId, inv.tableId) || world.boardGameOf(from.userId) || world.boardGameOf(a.userId)) { world.closeBoardInvite(inv, 'busy', emit); return { ok: false, error: 'The table or a player is busy', code: 'BUSY' }; }
    const g = world.startBoardGame(inv, from, a, emit);
    return { ok: true, id: g.id };
  }

  @SubscribeMessage('office:board-cancel')
  boardCancel(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): BoardAck {
    const j = this.joined(client);
    if (!j) return { ok: false, error: 'Join the office first', code: 'NOT_JOINED' };
    const dto = parse(BoardIdDtoSchema, body);
    if (!dto) return { ok: false, error: 'Bad request', code: 'BAD_REQUEST' };
    const inv = j.world.boardInvites.get(dto.id);
    if (!inv || inv.from !== j.a.userId) return { ok: false, error: 'That invitation is no longer open', code: 'NOT_OPEN' };
    j.world.closeBoardInvite(inv, 'cancelled', this.personalEmitter);
    return { ok: true };
  }

  /** A move by the player whose turn it is, checked with the shared rules; both see the new board. */
  @SubscribeMessage('office:board-move')
  boardMove(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): BoardAck {
    const j = this.joined(client);
    if (!j) return { ok: false, error: 'Join the office first', code: 'NOT_JOINED' };
    const dto = parse(BoardMoveDtoSchema, body);
    if (!dto) return { ok: false, error: 'Bad request', code: 'BAD_REQUEST' };
    const { world, a } = j;
    const now = Date.now();
    const w = this.boardMoveWindow.get(a.userId);
    if (!w || now - w.at >= ACTION_WINDOW_MS) this.boardMoveWindow.set(a.userId, { at: now, n: 1 });
    else if (++w.n > BOARD_MOVES_PER_WINDOW) return { ok: false, error: 'Slow down a little', code: 'RATE_LIMITED' };
    const g = world.boardGames.get(dto.id);
    if (!g || (g.white.id !== a.userId && g.black.id !== a.userId)) return { ok: false, error: 'That game is not yours', code: 'NOT_FOUND' };
    const side = g.white.id === a.userId ? 'w' : 'b';
    if (g.state.turn !== side) return { ok: false, error: 'It is not your turn', code: 'NOT_YOUR_TURN' };
    const next = playMove(g.state, { from: dto.from, to: dto.to, ...(dto.promotion ? { promotion: dto.promotion } : {}) });
    if (!next) return { ok: false, error: 'That move is not allowed', code: 'ILLEGAL' };
    world.applyBoardState(g, next, this.personalEmitter);
    return { ok: true };
  }

  @SubscribeMessage('office:board-resign')
  boardResign(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): BoardAck {
    const j = this.joined(client);
    if (!j) return { ok: false, error: 'Join the office first', code: 'NOT_JOINED' };
    const dto = parse(BoardIdDtoSchema, body);
    if (!dto) return { ok: false, error: 'Bad request', code: 'BAD_REQUEST' };
    const g = j.world.boardGames.get(dto.id);
    if (!g || (g.white.id !== j.a.userId && g.black.id !== j.a.userId)) return { ok: false, error: 'That game is not yours', code: 'NOT_FOUND' };
    j.world.endBoardGame(g, { winner: g.white.id === j.a.userId ? 'b' : 'w', reason: 'resigned' }, this.personalEmitter);
    return { ok: true };
  }

  /** FR-VO-005: room-only mode keeps proximity from joining you to passers-by. */
  @SubscribeMessage('office:mode')
  mode(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): { ok: boolean } {
    const orgId = client.data?.officeOrg as string | undefined;
    const world = orgId ? this.registry.peek(orgId) : null;
    const a = world ? this.avatarOf(world, client) : null;
    const dto = parse(ModeDtoSchema, body);
    if (!a || !dto) return { ok: false };
    a.roomOnly = dto.roomOnly;
    return { ok: true };
  }
}
