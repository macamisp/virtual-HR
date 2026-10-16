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
  JoinDtoSchema, ModeDtoSchema, MoveDtoSchema, RoomAnswerDtoSchema, RoomKnockDtoSchema, TeleportDtoSchema,
} from '../../../../packages/shared/src/office/index.ts';
import type { JoinAck, ManualStatus, MoveAck, TeleportAck } from '../../../../packages/shared/src/office/index.ts';
import { OfficeRegistry } from './office-registry.ts';
import type { Avatar, OfficeWorld } from './office-world.ts';

interface SocketAuth { user: JwtPayload }

const MOVE_RATE_PER_S = 15;
const PASSWORD_ATTEMPTS_PER_MIN = 5;
const KNOCK_COOLDOWN_MS = 10_000;

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

  constructor(
    private readonly registry: OfficeRegistry,
    private readonly resolver: PermissionResolver,
    private readonly prisma: PrismaService,
    private readonly attendanceGateway: AttendanceGateway,
    private readonly attendance: AttendanceService,
  ) {}

  onModuleInit(): void {
    this.registry.start({
      positions: (userId, msg) => this.server?.to(`vo:${userId}:pos`).emit('office:positions', msg),
      proximity: (userId, msg) => this.server?.to(`vo:${userId}`).emit('office:proximity', msg),
      roster: (orgId, entry) => this.server?.to(`vo-org:${orgId}`).emit('office:presence', entry),
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
    if (!a) {
      const u = await this.prisma.runWithTenantContext(orgId, async (db) => (await db.query<{ display_name: string | null; email: string; vo_status: ManualStatus; vo_status_message: string }>(
        `SELECT display_name, email, vo_status, vo_status_message FROM users WHERE id = $1`, [userId])).rows[0]);
      if (!u) return { ok: false, error: 'Unauthorized' };
      let attendanceState: string | null = null;
      try { attendanceState = (await this.attendance.getMyToday(orgId, userId)).state; } catch { attendanceState = null; }
      const start = world.startPoint(userId, dto.floorId);
      a = {
        userId, name: u.display_name ?? u.email, floorId: start.floorId, x: 0, y: 0, dir: 0, roomId: null, lastMoveAt: 0, version: 0,
        attendance: attendanceState, manual: u.vo_status, message: u.vo_status_message, roomOnly: false,
        isAdmin: access.permissions.includes(Permission.ORG_MANAGE), sockets: new Map(), ct: null,
      };
      world.avatars.set(userId, a);
      world.place(a, start.floorId, start.p, Date.now());
      world.rosterChanged = true;
      world.changedRoster.add(userId);
    }
    a.sockets.set(client.id, { positions: dto.positions });
    client.data.officeOrg = orgId;
    await client.join([`vo-org:${orgId}`, `vo:${userId}`]);
    if (dto.positions) await client.join(`vo:${userId}:pos`);
    return { ok: true, self: { x: a.x, y: a.y, floorId: a.floorId, roomId: a.roomId }, roster: world.roster() };
  }

  @SubscribeMessage('office:leave')
  async leave(@ConnectedSocket() client: Socket): Promise<{ ok: true }> {
    await this.detach(client);
    return { ok: true };
  }

  async handleDisconnect(client: Socket): Promise<void> {
    await this.detach(client);
  }

  private async detach(client: Socket): Promise<void> {
    const auth = this.auth(client);
    const orgId = client.data?.officeOrg as string | undefined;
    if (!auth || !orgId) return;
    const world = this.registry.peek(orgId);
    const a = world?.avatars.get(auth.user.sub);
    this.moveWindow.delete(client.id);
    if (!world || !a) return;
    a.sockets.delete(client.id);
    for (const room of [`vo-org:${orgId}`, `vo:${a.userId}`, `vo:${a.userId}:pos`]) void client.leave(room);
    if (a.sockets.size === 0) {
      world.remove(a.userId);
      this.server?.to(`vo-org:${orgId}`).emit('office:presence', { id: a.userId, gone: true });
    }
  }

  @SubscribeMessage('office:move')
  move(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): MoveAck {
    const orgId = client.data?.officeOrg as string | undefined;
    const world = orgId ? this.registry.peek(orgId) : null;
    const a = world ? this.avatarOf(world, client) : null;
    if (!world || !a) return { ok: false, reason: 'NOT_JOINED', x: 0, y: 0, floorId: '' };
    const now = Date.now();
    const win = this.moveWindow.get(client.id);
    if (!win || now - win.at >= 1000) this.moveWindow.set(client.id, { at: now, n: 1 });
    else if ((win.n += 1) > MOVE_RATE_PER_S) return { ok: false, reason: 'RATE_LIMITED', x: a.x, y: a.y, floorId: a.floorId };
    const dto = parse(MoveDtoSchema, body);
    if (!dto) return { ok: false, reason: 'BAD_REQUEST', x: a.x, y: a.y, floorId: a.floorId };
    const r = world.move(a, { x: dto.x, y: dto.y }, dto.dir, now, dto.ct ?? null);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason, x: a.x, y: a.y, floorId: a.floorId };
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
