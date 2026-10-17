import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { PermissionResolver } from '../common/permission-resolver.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { AttendanceService } from '../attendance/attendance.service.ts';
import {
  effectivePermissions,
  isMfaRequiredRole,
  Permission,
  ROLE_PERMISSIONS,
  UserRole,
} from '../../../../packages/shared/src/auth/types.ts';
import type { AuthenticatedUser, RecordingSettings } from '../../../../packages/shared/src/index.ts';
import type {
  AdminUserRow,
  AssignRoleDto,
  AttendanceGuards,
  CustomRole,
  CustomRoleDto,
  MyAccess,
  OrgPolicy,
  RetentionOverview,
  RetentionSettings,
  RolesOverview,
} from '../../../../packages/shared/src/admin/types.ts';
import { readAttendanceGuards, readOrgPolicy, writeAttendanceGuards, writeOrgPolicy } from './policy-store.ts';
import { parseCidr } from '../attendance/anti-spoofing.ts';
import { validateAttendancePolicy } from './policy-rules.ts';
import { checkRoleDefinition, covers, mayAssign } from './role-rules.ts';

interface RoleRow {
  id: string;
  name: string;
  description: string;
  base_role: UserRole;
  added_permissions: Permission[];
  removed_permissions: Permission[];
  version: number;
  updated_at: Date;
  user_count: number;
}

function mapRole(r: RoleRow): CustomRole {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    baseRole: r.base_role,
    addedPermissions: r.added_permissions ?? [],
    removedPermissions: r.removed_permissions ?? [],
    permissions: effectivePermissions(r.base_role, r.added_permissions ?? [], r.removed_permissions ?? []),
    userCount: Number(r.user_count),
    version: r.version,
    updatedAt: r.updated_at.toISOString(),
  };
}

const ROLE_SELECT = `
  SELECT r.id, r.name, r.description, r.base_role, r.added_permissions, r.removed_permissions, r.version, r.updated_at,
         (SELECT count(*) FROM users u WHERE u.custom_role_id = r.id)::int AS user_count
  FROM org_roles r`;

function withoutTimezone(p: OrgPolicy & { timezone: string; presenceRetentionDays: number }): OrgPolicy {
  const { timezone, presenceRetentionDays, ...policy } = p;
  void timezone;
  void presenceRetentionDays;
  return policy;
}

/** Data types in FR-ADM-004 that this release does not store yet. */
const NOT_AVAILABLE = ['Chat messages'];

/**
 * FR-ADM-001 policy, FR-ADM-002 roles and permissions, FR-ADM-004 retention (ADR 011). Every
 * change is audited with before and after values.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attendance: AttendanceService,
    private readonly resolver: PermissionResolver,
  ) {}

  // ---------------------------------------------------------------- FR-ADM-001

  async policy(user: AuthenticatedUser): Promise<OrgPolicy> {
    return withoutTimezone(await this.prisma.runWithTenantContext(user.orgId, (db) => readOrgPolicy(db, user.orgId)));
  }

  async updatePolicy(user: AuthenticatedUser, dto: OrgPolicy): Promise<OrgPolicy> {
    const problems = validateAttendancePolicy(dto);
    if (problems.length > 0) throw new BadRequestException(problems.join('; '));
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, [user.orgId]);
      const before = withoutTimezone(await readOrgPolicy(db, user.orgId));
      await writeOrgPolicy(db, user.orgId, dto);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'ORG_POLICY_UPDATED', entityType: 'ORGANIZATION', entityId: user.orgId, before, after: dto });
    });
    this.attendance.invalidatePolicy(user.orgId);
    return await this.policy(user);
  }

  // ---------------------------------------------------------------- ADR 019 attendance safeguards

  async guards(user: AuthenticatedUser): Promise<AttendanceGuards> {
    return await this.prisma.runWithTenantContext(user.orgId, (db) => readAttendanceGuards(db, user.orgId));
  }

  async updateGuards(user: AuthenticatedUser, dto: AttendanceGuards): Promise<AttendanceGuards> {
    const bad = dto.allowedCidrs.filter((c) => !parseCidr(c));
    if (bad.length) throw new BadRequestException(`Not a valid IP range: ${bad.join(', ')}`);
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, [user.orgId]);
      const before = await readAttendanceGuards(db, user.orgId);
      await writeAttendanceGuards(db, user.orgId, dto);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'ATTENDANCE_GUARDS_UPDATED', entityType: 'ORGANIZATION', entityId: user.orgId, before, after: dto });
    });
    this.attendance.invalidatePolicy(user.orgId);
    return await this.guards(user);
  }

  // ---------------------------------------------------------------- FR-ADM-004

  async retention(user: AuthenticatedUser): Promise<RetentionOverview> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const org = await db.query<{ retention_presence_days: number; retention_notifications_days: number; retention_recordings_days: number }>(
        `SELECT retention_presence_days, retention_notifications_days, retention_recordings_days FROM organizations WHERE id = $1`,
        [user.orgId],
      );
      const rules = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM document_retention_rules`);
      return {
        presenceDays: org.rows[0]!.retention_presence_days,
        notificationsDays: org.rows[0]!.retention_notifications_days,
        recordingsDays: org.rows[0]!.retention_recordings_days,
        documentRules: rules.rows[0]!.n,
        notAvailable: NOT_AVAILABLE,
      };
    });
  }

  async updateRetention(user: AuthenticatedUser, dto: RetentionSettings): Promise<RetentionOverview> {
    const before = await this.retention(user);
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`UPDATE organizations SET retention_presence_days = $2, retention_notifications_days = $3, retention_recordings_days = COALESCE($4, retention_recordings_days) WHERE id = $1`,
        [user.orgId, dto.presenceDays, dto.notificationsDays, dto.recordingsDays ?? null]);
      await appendAuditEntry(db, {
        orgId: user.orgId, actorId: user.id, action: 'RETENTION_SETTINGS_UPDATED', entityType: 'ORGANIZATION', entityId: user.orgId,
        before: { presenceDays: before.presenceDays, notificationsDays: before.notificationsDays, recordingsDays: before.recordingsDays }, after: dto,
      });
    });
    this.attendance.invalidatePolicy(user.orgId);
    return await this.retention(user);
  }

  // ---------------------------------------------------------------- FR-MEET-007 recording switch (ADR 024)

  async recordingSettings(user: AuthenticatedUser): Promise<RecordingSettings> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => ({
      enabled: (await db.query<{ recording_enabled: boolean }>(`SELECT recording_enabled FROM organizations WHERE id = $1`, [user.orgId])).rows[0]!.recording_enabled,
    }));
  }

  async updateRecordingSettings(user: AuthenticatedUser, dto: RecordingSettings): Promise<RecordingSettings> {
    const before = await this.recordingSettings(user);
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`UPDATE organizations SET recording_enabled = $2 WHERE id = $1`, [user.orgId, dto.enabled]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'RECORDING_SETTINGS_UPDATED', entityType: 'ORGANIZATION', entityId: user.orgId, before, after: dto });
    });
    return await this.recordingSettings(user);
  }

  // ---------------------------------------------------------------- FR-ADM-002

  async myAccess(user: AuthenticatedUser): Promise<MyAccess> {
    const access = await this.resolver.resolve(user);
    return { role: access.role, customRoleName: access.customRoleName, permissions: access.permissions };
  }

  async roles(user: AuthenticatedUser): Promise<RolesOverview> {
    const custom = await this.prisma.runWithTenantContext(user.orgId, async (db) => (await db.query<RoleRow>(`${ROLE_SELECT} ORDER BY r.name`)).rows);
    return {
      builtIn: (Object.keys(ROLE_PERMISSIONS) as UserRole[]).map((role) => ({ role, permissions: ROLE_PERMISSIONS[role] })),
      custom: custom.map(mapRole),
      grantable: this.actorPermissions(user),
    };
  }

  async createRole(user: AuthenticatedUser, dto: CustomRoleDto): Promise<CustomRole> {
    const def = this.normalise(user, dto);
    const created = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      try {
        const res = await db.query<{ id: string }>(
          `INSERT INTO org_roles (org_id, name, description, base_role, added_permissions, removed_permissions, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [user.orgId, def.name, def.description, def.baseRole, def.added, def.removed, user.id],
        );
        const id = res.rows[0]!.id;
        await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'ROLE_CREATED', entityType: 'ORG_ROLE', entityId: id, after: def });
        return (await db.query<RoleRow>(`${ROLE_SELECT} WHERE r.id = $1`, [id])).rows[0]!;
      } catch (err) {
        throw this.mapDbError(err);
      }
    });
    return mapRole(created);
  }

  async updateRole(user: AuthenticatedUser, id: string, dto: CustomRoleDto): Promise<CustomRole> {
    const def = this.normalise(user, dto);
    const updated = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const current = (await db.query<RoleRow>(`${ROLE_SELECT} WHERE r.id = $1 FOR UPDATE OF r`, [id])).rows[0];
      if (!current) throw new NotFoundException('Role not found');
      if (dto.version !== undefined && dto.version !== current.version) throw new ConflictException('Someone else changed this role. Reload and try again.');
      // The admin must be able to hold the role's current permissions as well as the new ones.
      this.assertGrantable(user, mapRole(current).permissions);
      try {
        await db.query(
          `UPDATE org_roles SET name = $2, description = $3, base_role = $4, added_permissions = $5, removed_permissions = $6,
             version = version + 1, updated_at = now() WHERE id = $1`,
          [id, def.name, def.description, def.baseRole, def.added, def.removed],
        );
      } catch (err) {
        throw this.mapDbError(err);
      }
      // A user's built-in role always equals their custom role's base (ADR 011).
      if (def.baseRole !== current.base_role) {
        const moved = await db.query<{ id: string }>(`UPDATE users SET role = $2 WHERE custom_role_id = $1 RETURNING id`, [id, def.baseRole]);
        if (isMfaRequiredRole(def.baseRole)) for (const u of moved.rows) await this.revokeSessions(db, u.id);
      }
      await appendAuditEntry(db, {
        orgId: user.orgId, actorId: user.id, action: 'ROLE_UPDATED', entityType: 'ORG_ROLE', entityId: id,
        before: { name: current.name, description: current.description, baseRole: current.base_role, added: current.added_permissions, removed: current.removed_permissions },
        after: def,
      });
      return (await db.query<RoleRow>(`${ROLE_SELECT} WHERE r.id = $1`, [id])).rows[0]!;
    });
    this.resolver.invalidateOrg(user.orgId);
    return mapRole(updated);
  }

  /** Refused while users hold the role: deleting it would silently give them the full base role. */
  async deleteRole(user: AuthenticatedUser, id: string): Promise<void> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const current = (await db.query<RoleRow>(`${ROLE_SELECT} WHERE r.id = $1 FOR UPDATE OF r`, [id])).rows[0];
      if (!current) throw new NotFoundException('Role not found');
      if (Number(current.user_count) > 0) throw new ConflictException(`Assign its ${current.user_count} user(s) another role first`);
      this.assertGrantable(user, mapRole(current).permissions);
      await db.query(`DELETE FROM org_roles WHERE id = $1`, [id]);
      await appendAuditEntry(db, {
        orgId: user.orgId, actorId: user.id, action: 'ROLE_DELETED', entityType: 'ORG_ROLE', entityId: id,
        before: { name: current.name, baseRole: current.base_role, added: current.added_permissions, removed: current.removed_permissions },
      });
    });
    this.resolver.invalidateOrg(user.orgId);
  }

  async users(user: AuthenticatedUser): Promise<AdminUserRow[]> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const res = await db.query<{ id: string; email: string; display_name: string | null; role: UserRole; status: string; custom_role_id: string | null; name: string | null }>(
        `SELECT u.id, u.email, u.display_name, u.role, u.status, u.custom_role_id, r.name
         FROM users u LEFT JOIN org_roles r ON r.id = u.custom_role_id
         ORDER BY u.display_name NULLS LAST, u.email`,
      );
      return res.rows.map((r) => ({ id: r.id, email: r.email, displayName: r.display_name, role: r.role, status: r.status, customRoleId: r.custom_role_id, customRoleName: r.name }));
    });
  }

  async assignRole(user: AuthenticatedUser, targetId: string, dto: AssignRoleDto): Promise<AdminUserRow> {
    if (targetId === user.id) throw new ForbiddenException('You cannot change your own role');
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const target = (await db.query<{ role: UserRole; custom_role_id: string | null; added: Permission[] | null; removed: Permission[] | null; mfa_enabled: boolean }>(
        `SELECT u.role, u.custom_role_id, r.added_permissions AS added, r.removed_permissions AS removed, u.mfa_enabled
         FROM users u LEFT JOIN org_roles r ON r.id = u.custom_role_id WHERE u.id = $1 FOR UPDATE OF u`,
        [targetId],
      )).rows[0];
      if (!target) throw new NotFoundException('User not found');
      let role = dto.role;
      let added: Permission[] = [];
      let removed: Permission[] = [];
      const customRoleId = dto.customRoleId ?? null;
      if (customRoleId) {
        const custom = (await db.query<RoleRow>(`${ROLE_SELECT} WHERE r.id = $1`, [customRoleId])).rows[0];
        if (!custom) throw new NotFoundException('Role not found');
        role = custom.base_role;
        added = custom.added_permissions ?? [];
        removed = custom.removed_permissions ?? [];
      }
      const problem = mayAssign({
        actor: { id: user.id, role: user.role, permissions: this.actorPermissions(user) },
        currentPermissions: effectivePermissions(target.role, target.added ?? [], target.removed ?? []),
        currentRole: target.role,
        newRole: role,
        newPermissions: effectivePermissions(role, added, removed),
      });
      if (problem) throw new ForbiddenException(problem);
      await db.query(`UPDATE users SET role = $2, custom_role_id = $3 WHERE id = $1`, [targetId, role, customRoleId]);
      // Sessions issued without 2FA must not carry a role that requires it.
      if (isMfaRequiredRole(role) && !isMfaRequiredRole(target.role) && !target.mfa_enabled) await this.revokeSessions(db, targetId);
      await appendAuditEntry(db, {
        orgId: user.orgId, actorId: user.id, action: 'USER_ROLE_CHANGED', entityType: 'USER', entityId: targetId,
        before: { role: target.role, customRoleId: target.custom_role_id }, after: { role, customRoleId },
      });
    });
    this.resolver.invalidateOrg(user.orgId);
    const row = (await this.users(user)).find((u) => u.id === targetId);
    if (!row) throw new NotFoundException('User not found');
    return row;
  }

  // ---------------------------------------------------------------- helpers

  private actorPermissions(user: AuthenticatedUser): Permission[] {
    return user.permissions ?? ROLE_PERMISSIONS[user.role] ?? [];
  }

  private normalise(user: AuthenticatedUser, dto: CustomRoleDto) {
    const result = checkRoleDefinition({
      baseRole: dto.baseRole,
      added: dto.addedPermissions ?? [],
      removed: dto.removedPermissions ?? [],
      grantable: this.actorPermissions(user),
      actorIsSuperAdmin: user.role === UserRole.SUPER_ADMIN,
    });
    if ('error' in result) throw new ForbiddenException(result.error);
    return { name: dto.name.trim(), description: (dto.description ?? '').trim(), baseRole: dto.baseRole, added: result.added, removed: result.removed };
  }

  private assertGrantable(user: AuthenticatedUser, permissions: readonly Permission[]): void {
    if (user.role === UserRole.SUPER_ADMIN) return;
    const mine = this.actorPermissions(user);
    if (permissions.some((p) => !covers(mine, p))) throw new ForbiddenException('This role has permissions you do not hold');
  }

  private async revokeSessions(db: import('pg').PoolClient, userId: string): Promise<void> {
    await db.query(
      `UPDATE auth_sessions SET is_revoked = true, revoked_reason = 'ROLE_CHANGED', updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND (NOT is_revoked OR revoked_reason IS NULL OR revoked_reason = 'ROTATED')`,
      [userId],
    );
  }

  private mapDbError(err: unknown): unknown {
    const e = err as { code?: string; constraint?: string };
    if (e?.code === '23505') return new ConflictException('A role with this name already exists');
    if (e?.code === '23514') return new BadRequestException('The role definition is not valid');
    return err;
  }
}

