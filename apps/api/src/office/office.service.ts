import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import argon2 from 'argon2';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { Permission, userCan } from '../../../../packages/shared/src/auth/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { displayStatus } from '../../../../packages/shared/src/office/index.ts';
import type {
  DeskAssignDto, ManualStatus, OfficeDefinition, OfficeSnapshot, PeopleQuery, Person, RoomInvitesDto, RoomUpdateDto, StatusDto,
} from '../../../../packages/shared/src/office/index.ts';
import { ensureOffice, syncLayout } from './office-store.ts';
import { OfficeRegistry } from './office-registry.ts';

/**
 * Virtual office REST side (FR-VO-001, 003, 004, 007, 008, 012; ADR 015): the map and layout,
 * people search with live location, status, desks, and room settings. Live movement is on the
 * socket (office.gateway.ts).
 */
@Injectable()
export class OfficeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: OfficeRegistry,
  ) {}

  private canManage(user: AuthenticatedUser): boolean {
    return userCan(user, Permission.ORG_MANAGE);
  }

  async snapshot(user: AuthenticatedUser): Promise<OfficeSnapshot> {
    const world = await this.registry.world(user.orgId);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const office = await ensureOffice(db, user.orgId);
      const me = (await db.query<{ vo_status: ManualStatus; vo_status_message: string }>(`SELECT vo_status, vo_status_message FROM users WHERE id = $1`, [user.id])).rows[0];
      const names = await db.query<{ id: string; display_name: string | null }>(`SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])`, [world.desks.map((d) => d.assignedUserId).filter(Boolean)]);
      const nameOf = new Map(names.rows.map((r) => [r.id, r.display_name]));
      const admin = this.canManage(user);
      return {
        office: { id: office.id, name: office.name, proximityRadius: office.proximityRadius, version: office.version },
        floors: office.definition.floors.map((f) => ({ id: f.id, name: f.name, map: f.map })),
        rooms: world.rooms.map((r) => ({
          id: r.id, floorId: r.floorId, name: r.name, type: r.type, capacity: r.capacity, accessMode: r.accessMode, bounds: r.bounds,
          canEnter: world.mayEnter(user.id, r, admin, true) === null, occupants: world.occupants(r.id).length,
        })),
        desks: world.desks.map((d) => ({ id: d.id, floorId: d.floorId, label: d.label, bounds: d.bounds, assignee: d.assignedUserId ? { id: d.assignedUserId, displayName: nameOf.get(d.assignedUserId) ?? null } : null })),
        me: { id: user.id, deskId: world.desks.find((d) => d.assignedUserId === user.id)?.id ?? null, manualStatus: me?.vo_status ?? 'AUTO', statusMessage: me?.vo_status_message ?? '' },
        canManage: admin,
      };
    });
  }

  /** FR-VO-008: everyone in the organisation, with where they are now. */
  async people(user: AuthenticatedUser, q: PeopleQuery): Promise<{ items: Person[] }> {
    const world = await this.registry.world(user.orgId);
    const rows = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const params: unknown[] = [];
      let where = `u.status = 'ACTIVE'`;
      if (q.q) {
        params.push(`%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
        where += ` AND (u.display_name ILIKE $1 OR u.email ILIKE $1 OR t.name ILIKE $1)`;
      }
      return (await db.query<{ id: string; display_name: string | null; email: string; role: string; team_name: string | null; vo_status: ManualStatus; vo_status_message: string }>(
        `SELECT u.id, u.display_name, u.email, u.role, t.name AS team_name, u.vo_status, u.vo_status_message
         FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE ${where} ORDER BY COALESCE(u.display_name, u.email) LIMIT 500`,
        params,
      )).rows;
    });
    const items: Person[] = [];
    for (const r of rows) {
      const a = world.avatars.get(r.id);
      if (q.onlineOnly && !a) continue;
      const room = a?.roomId ? world.rooms.find((x) => x.id === a.roomId) : null;
      items.push({
        id: r.id, displayName: r.display_name, email: r.email, role: r.role, teamName: r.team_name, online: !!a,
        status: a ? world.status(a) : displayStatus(null, r.vo_status, false),
        statusMessage: r.vo_status_message,
        floorId: a?.floorId ?? null, roomId: room?.id ?? null, roomName: room?.name ?? null,
        deskLabel: world.desks.find((d) => d.assignedUserId === r.id)?.label ?? null,
      });
    }
    return { items };
  }

  async setStatus(user: AuthenticatedUser, dto: StatusDto): Promise<{ status: ManualStatus; message: string }> {
    const message = (dto.message ?? '').trim();
    await this.prisma.runWithTenantContext(user.orgId, (db) => db.query(`UPDATE users SET vo_status = $2, vo_status_message = $3 WHERE id = $1`, [user.id, dto.status, message]));
    const world = await this.registry.world(user.orgId);
    const a = world.avatars.get(user.id);
    if (a) {
      a.manual = dto.status;
      a.message = message;
      a.version += 1;
      world.rosterChanged = true;
      world.changedRoster.add(user.id);
    }
    return { status: dto.status, message };
  }

  // ---------------------------------------------------------------- FR-VO-007 desks

  async claimDesk(user: AuthenticatedUser, deskId: string): Promise<OfficeSnapshot> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const desk = (await db.query<{ assigned_user_id: string | null; label: string }>(`SELECT assigned_user_id, label FROM desks WHERE id = $1 FOR UPDATE`, [deskId])).rows[0];
      if (!desk) throw new NotFoundException('Desk not found');
      if (desk.assigned_user_id && desk.assigned_user_id !== user.id) throw new ConflictException('This desk belongs to someone else');
      await db.query(`UPDATE desks SET assigned_user_id = NULL, updated_at = now() WHERE assigned_user_id = $1 AND id <> $2`, [user.id, deskId]);
      await db.query(`UPDATE desks SET assigned_user_id = $2, updated_at = now() WHERE id = $1`, [deskId, user.id]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'DESK_CLAIMED', entityType: 'DESK', entityId: deskId, after: { label: desk.label } });
    });
    await this.registry.reload(user.orgId);
    return await this.snapshot(user);
  }

  async releaseDesk(user: AuthenticatedUser, deskId: string): Promise<OfficeSnapshot> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const res = await db.query(`UPDATE desks SET assigned_user_id = NULL, updated_at = now() WHERE id = $1 AND assigned_user_id = $2`, [deskId, user.id]);
      if (res.rowCount === 0) throw new NotFoundException('This is not your desk');
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'DESK_RELEASED', entityType: 'DESK', entityId: deskId });
    });
    await this.registry.reload(user.orgId);
    return await this.snapshot(user);
  }

  async assignDesk(user: AuthenticatedUser, deskId: string, dto: DeskAssignDto): Promise<OfficeSnapshot> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const desk = (await db.query<{ assigned_user_id: string | null; label: string }>(`SELECT assigned_user_id, label FROM desks WHERE id = $1 FOR UPDATE`, [deskId])).rows[0];
      if (!desk) throw new NotFoundException('Desk not found');
      if (dto.userId) {
        const u = await db.query(`SELECT 1 FROM users WHERE id = $1 AND status = 'ACTIVE'`, [dto.userId]);
        if (!u.rows[0]) throw new NotFoundException('User not found');
        await db.query(`UPDATE desks SET assigned_user_id = NULL, updated_at = now() WHERE assigned_user_id = $1 AND id <> $2`, [dto.userId, deskId]);
      }
      await db.query(`UPDATE desks SET assigned_user_id = $2, updated_at = now() WHERE id = $1`, [deskId, dto.userId]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'DESK_ASSIGNED', entityType: 'DESK', entityId: deskId, before: { userId: desk.assigned_user_id }, after: { userId: dto.userId, label: desk.label } });
    });
    await this.registry.reload(user.orgId);
    return await this.snapshot(user);
  }

  // ---------------------------------------------------------------- FR-VO-004 rooms

  async updateRoom(user: AuthenticatedUser, roomId: string, dto: RoomUpdateDto): Promise<OfficeSnapshot> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const room = (await db.query<{ name: string; capacity: number; access_mode: string; password_hash: string | null }>(`SELECT name, capacity, access_mode, password_hash FROM rooms WHERE id = $1 FOR UPDATE`, [roomId])).rows[0];
      if (!room) throw new NotFoundException('Room not found');
      const mode = dto.accessMode ?? room.access_mode;
      let hash = room.password_hash;
      if (mode !== 'PASSWORD') hash = null;
      else if (dto.password) hash = await argon2.hash(dto.password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
      else if (dto.password === null || !hash) throw new BadRequestException('A password room needs a password');
      await db.query(`UPDATE rooms SET name = $2, capacity = $3, access_mode = $4, password_hash = $5, updated_at = now() WHERE id = $1`,
        [roomId, dto.name ?? room.name, dto.capacity ?? room.capacity, mode, hash]);
      await appendAuditEntry(db, {
        orgId: user.orgId, actorId: user.id, action: 'ROOM_UPDATED', entityType: 'ROOM', entityId: roomId,
        before: { name: room.name, capacity: room.capacity, accessMode: room.access_mode, hasPassword: !!room.password_hash },
        after: { name: dto.name ?? room.name, capacity: dto.capacity ?? room.capacity, accessMode: mode, hasPassword: !!hash, passwordChanged: !!dto.password },
      });
    });
    await this.registry.reload(user.orgId);
    // Changing the password or mode withdraws earlier password and knock grants for that room.
    const world = await this.registry.world(user.orgId);
    for (const g of world.grants.values()) g.delete(roomId);
    return await this.snapshot(user);
  }

  async invites(user: AuthenticatedUser, roomId: string): Promise<{ userIds: string[] }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const room = await db.query(`SELECT 1 FROM rooms WHERE id = $1`, [roomId]);
      if (!room.rows[0]) throw new NotFoundException('Room not found');
      return { userIds: (await db.query<{ user_id: string }>(`SELECT user_id FROM room_invites WHERE room_id = $1 ORDER BY created_at`, [roomId])).rows.map((r) => r.user_id) };
    });
  }

  async setInvites(user: AuthenticatedUser, roomId: string, dto: RoomInvitesDto): Promise<{ userIds: string[] }> {
    const before = await this.invites(user, roomId);
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`DELETE FROM room_invites WHERE room_id = $1`, [roomId]);
      const ids = [...new Set(dto.userIds)];
      if (ids.length) {
        const found = await db.query<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1::uuid[])`, [ids]);
        if (found.rows.length !== ids.length) throw new NotFoundException('Some users were not found');
        await db.query(`INSERT INTO room_invites (org_id, room_id, user_id, invited_by) SELECT $1, $2, u, $3 FROM unnest($4::uuid[]) AS u`, [user.orgId, roomId, user.id, ids]);
      }
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'ROOM_INVITES_UPDATED', entityType: 'ROOM', entityId: roomId, before, after: { userIds: ids } });
    });
    await this.registry.reload(user.orgId);
    return await this.invites(user, roomId);
  }

  /** Replace the office map (Tiled JSON, validated by the DTO). People stay where they are when possible. */
  async replaceMap(user: AuthenticatedUser, def: OfficeDefinition): Promise<OfficeSnapshot> {
    if (!this.canManage(user)) throw new ForbiddenException();
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const office = await ensureOffice(db, user.orgId);
      await db.query(`UPDATE offices SET name = $2, map_json = $3, version = version + 1, updated_at = now() WHERE id = $1`, [office.id, def.name, JSON.stringify(def)]);
      await syncLayout(db, user.orgId, office.id, def);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'OFFICE_MAP_REPLACED', entityType: 'OFFICE', entityId: office.id, after: { name: def.name, floors: def.floors.map((f) => f.id) } });
    });
    await this.registry.reload(user.orgId);
    return await this.snapshot(user);
  }
}
