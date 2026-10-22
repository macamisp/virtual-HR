import { AttendanceGateway } from '../attendance/attendance.gateway.ts';
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
import { checkRoleDefinition, covers, mayAssign, ownerChangeProblem } from './role-rules.ts';
import { revokeSessionsOf } from '../auth/session-revocation.ts';
import { resolvePermissions } from '../common/permission-resolver.ts';
import { ROLE_LABEL } from '../../../../packages/shared/src/admin/types.ts';
import { PERMISSION_GROUPS, visibleAreas } from '../../../../packages/shared/src/auth/types.ts';
import type { EffectiveAccess, ProfileUpdateDto, UserStatusDto } from '../../../../packages/shared/src/auth/workspace.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';

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
    private readonly gateway: AttendanceGateway,
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
    return { role: access.role, customRoleName: access.customRoleName, permissions: access.permissions, isOwner: access.isOwner, jobTitle: access.jobTitle, signInMethods: access.signInMethods };
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
    const revokedUsers: string[] = [];
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
        for (const u of moved.rows) { await revokeSessionsOf(db, user.orgId, { userId: u.id }, 'ROLE_CHANGED'); revokedUsers.push(u.id); }
      }
      await appendAuditEntry(db, {
        orgId: user.orgId, actorId: user.id, action: 'ROLE_UPDATED', entityType: 'ORG_ROLE', entityId: id,
        before: { name: current.name, description: current.description, baseRole: current.base_role, added: current.added_permissions, removed: current.removed_permissions },
        after: def,
      });
      return (await db.query<RoleRow>(`${ROLE_SELECT} WHERE r.id = $1`, [id])).rows[0]!;
    });
    this.resolver.invalidateOrg(user.orgId);
    for (const userId of revokedUsers) await this.gateway.closeAttendanceOnRevocation(user.orgId, userId, null);
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

  private static readonly USER_SELECT = `
    SELECT u.id, u.email, u.display_name, u.role, u.status, u.custom_role_id, r.name, u.is_owner, u.job_title, u.mfa_enabled, u.email_verified_at
    FROM users u LEFT JOIN org_roles r ON r.id = u.custom_role_id`;

  private mapUser(r: { id: string; email: string; display_name: string | null; role: UserRole; status: string; custom_role_id: string | null; name: string | null; is_owner: boolean; job_title: string | null; mfa_enabled: boolean; email_verified_at: Date | null }): AdminUserRow {
    return { id: r.id, email: r.email, displayName: r.display_name, role: r.role, status: r.status, customRoleId: r.custom_role_id, customRoleName: r.name, isOwner: r.is_owner, jobTitle: r.job_title, mfaEnabled: r.mfa_enabled, emailVerified: !!r.email_verified_at };
  }

  async users(user: AuthenticatedUser): Promise<AdminUserRow[]> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) =>
      (await db.query<Parameters<AdminService['mapUser']>[0]>(`${AdminService.USER_SELECT} ORDER BY u.display_name NULLS LAST, u.email`)).rows.map((r) => this.mapUser(r)));
  }

  private async userRow(user: AuthenticatedUser, targetId: string): Promise<AdminUserRow> {
    const row = await this.prisma.runWithTenantContext(user.orgId, async (db) =>
      (await db.query<Parameters<AdminService['mapUser']>[0]>(`${AdminService.USER_SELECT} WHERE u.id = $1`, [targetId])).rows[0]);
    if (!row) throw new NotFoundException('User not found');
    return this.mapUser(row);
  }

  /** The only active owner left? (ADR 037: that one can never be demoted, suspended or removed.) */
  private async isLastOwner(db: import('pg').PoolClient, targetId: string): Promise<boolean> {
    const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE is_owner AND status = 'ACTIVE' AND id <> $1`, [targetId])).rows[0]!.n;
    return n === 0;
  }

  private ownerProblem(p: ReturnType<typeof ownerChangeProblem>): void {
    if (!p) return;
    throw p.status === 409 ? new ConflictException(p.error) : new ForbiddenException(p.error);
  }

  // ---------------------------------------------------------------- ADR 037: status, profile, effective access

  /**
   * Suspend (reversible), reactivate, or offboard (final; FR-ORG-009): sessions end at once, open
   * tasks move to someone else, team-lead and manager links are cleared. Nobody changes their own
   * status; an owner is changed only by an owner and never when they are the last one.
   */
  async setStatus(user: AuthenticatedUser, targetId: string, dto: UserStatusDto, ctx: RequestContext): Promise<AdminUserRow> {
    if (targetId === user.id) throw new ForbiddenException('You cannot change your own status');
    const actorIsOwner = this.actorPermissions(user).includes(Permission.ORG_OWNER);
    let changed = false;
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const target = (await db.query<{ status: string; is_owner: boolean; role: UserRole; team_id: string | null }>(`SELECT status, is_owner, role, team_id FROM users WHERE id = $1 FOR UPDATE`, [targetId])).rows[0];
      if (!target) throw new NotFoundException('User not found');
      if (target.status === 'OFFBOARDED') throw new ConflictException('An offboarded person cannot be changed; invite them again instead');
      if (target.status === dto.status) return;
      this.ownerProblem(ownerChangeProblem({ actorIsOwner, targetIsOwner: target.is_owner, targetIsLastOwner: target.is_owner && await this.isLastOwner(db, targetId), change: 'STATUS', newStatus: dto.status }));
      if (target.role === UserRole.SUPER_ADMIN && user.role !== UserRole.SUPER_ADMIN) throw new ForbiddenException('Only a super admin can change a super admin');
      let reassigned = 0;
      if (dto.status === 'OFFBOARDED') {
        if (dto.reassignTasksTo) {
          const to = (await db.query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [dto.reassignTasksTo])).rows[0];
          if (!to || to.status !== 'ACTIVE') throw new BadRequestException('Tasks can only be reassigned to an active person');
        }
        reassigned = (await db.query(`UPDATE tasks SET assignee_id = $2, updated_at = now() WHERE assignee_id = $1 AND status <> 'DONE'`, [targetId, dto.reassignTasksTo ?? null])).rowCount ?? 0;
        await db.query(`UPDATE teams SET lead_id = NULL WHERE lead_id = $1`, [targetId]);
        await db.query(`UPDATE users SET manager_id = NULL WHERE manager_id = $1`, [targetId]);
        await db.query(`UPDATE users SET status = 'OFFBOARDED', is_owner = false, team_id = NULL, manager_id = NULL WHERE id = $1`, [targetId]);
      } else {
        await db.query(`UPDATE users SET status = $2 WHERE id = $1`, [targetId, dto.status]);
      }
      if (dto.status !== 'ACTIVE') await revokeSessionsOf(db, user.orgId, { userId: targetId }, dto.status === 'SUSPENDED' ? 'USER_SUSPENDED' : 'USER_OFFBOARDED');
      const action = dto.status === 'SUSPENDED' ? 'USER_SUSPENDED' : dto.status === 'OFFBOARDED' ? 'USER_OFFBOARDED' : 'USER_REACTIVATED';
      await appendAuditEntry(db, {
        orgId: user.orgId, actorId: user.id, action, entityType: 'USER', entityId: targetId,
        before: { status: target.status }, after: { status: dto.status, ...(dto.status === 'OFFBOARDED' ? { tasksReassigned: reassigned, reassignTasksTo: dto.reassignTasksTo ?? null } : {}) },
        ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined,
      });
      changed = true;
    });
    this.resolver.invalidateOrg(user.orgId);
    if (changed && dto.status !== 'ACTIVE') await this.gateway.closeAttendanceOnRevocation(user.orgId, targetId, null);
    return await this.userRow(user, targetId);
  }

  /** Display name and job title. The job title is descriptive only and grants nothing. */
  async updateProfile(user: AuthenticatedUser, targetId: string, dto: ProfileUpdateDto, ctx: RequestContext): Promise<AdminUserRow> {
    if (dto.displayName === undefined && dto.jobTitle === undefined) throw new BadRequestException('Nothing to change');
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const before = (await db.query<{ display_name: string | null; job_title: string | null }>(`SELECT display_name, job_title FROM users WHERE id = $1 FOR UPDATE`, [targetId])).rows[0];
      if (!before) throw new NotFoundException('User not found');
      const jobTitle = dto.jobTitle === undefined ? before.job_title : (dto.jobTitle?.trim() || null);
      const displayName = dto.displayName ?? before.display_name;
      await db.query(`UPDATE users SET display_name = $2, job_title = $3 WHERE id = $1`, [targetId, displayName, jobTitle]);
      await appendAuditEntry(db, {
        orgId: user.orgId, actorId: user.id, action: 'USER_PROFILE_UPDATED', entityType: 'USER', entityId: targetId,
        before: { displayName: before.display_name, jobTitle: before.job_title }, after: { displayName, jobTitle },
        ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined,
      });
    });
    this.resolver.invalidateOrg(user.orgId);
    return await this.userRow(user, targetId);
  }

  /** One person's permissions with plain-language descriptions and what they open (FR-AUTH-006). */
  async effectiveAccess(user: AuthenticatedUser, targetId: string): Promise<EffectiveAccess> {
    const row = await this.prisma.runWithTenantContext(user.orgId, async (db) =>
      (await db.query<{ id: string; email: string; display_name: string | null; role: UserRole; status: EffectiveAccess['user']['status']; is_owner: boolean; job_title: string | null; mfa_enabled: boolean; name: string | null; added: Permission[] | null; removed: Permission[] | null }>(
        `SELECT u.id, u.email, u.display_name, u.role, u.status, u.is_owner, u.job_title, u.mfa_enabled, r.name, r.added_permissions AS added, r.removed_permissions AS removed
         FROM users u LEFT JOIN org_roles r ON r.id = u.custom_role_id WHERE u.id = $1`, [targetId])).rows[0]);
    if (!row) throw new NotFoundException('User not found');
    const permissions = resolvePermissions(row);
    return {
      user: { id: row.id, email: row.email, displayName: row.display_name, role: row.role, roleLabel: ROLE_LABEL[row.role], customRoleName: row.name, isOwner: row.is_owner, jobTitle: row.job_title, status: row.status, mfaEnabled: row.mfa_enabled },
      permissions,
      groups: PERMISSION_GROUPS.map((g) => ({ group: g.group, items: g.items.map((i) => ({ permission: i.permission, label: i.label, description: i.description, granted: permissions.includes(i.permission) })) })),
      areas: visibleAreas(permissions),
    };
  }

  async assignRole(user: AuthenticatedUser, targetId: string, dto: AssignRoleDto): Promise<AdminUserRow> {
    if (targetId === user.id) throw new ForbiddenException('You cannot change your own role');
    const actorIsOwner = this.actorPermissions(user).includes(Permission.ORG_OWNER);
    let revoked = false;
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const target = (await db.query<{ role: UserRole; custom_role_id: string | null; added: Permission[] | null; removed: Permission[] | null; mfa_enabled: boolean; is_owner: boolean }>(
        `SELECT u.role, u.custom_role_id, r.added_permissions AS added, r.removed_permissions AS removed, u.mfa_enabled, u.is_owner
         FROM users u LEFT JOIN org_roles r ON r.id = u.custom_role_id WHERE u.id = $1 FOR UPDATE OF u`,
        [targetId],
      )).rows[0];
      if (!target) throw new NotFoundException('User not found');
      // ADR 037: owners are changed only by owners, and the last owner keeps the owner role.
      this.ownerProblem(ownerChangeProblem({ actorIsOwner, targetIsOwner: target.is_owner, targetIsLastOwner: target.is_owner && await this.isLastOwner(db, targetId), change: 'ROLE', newRole: dto.customRoleId ? undefined : dto.role }));
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
      const stillOwner = target.is_owner && role === UserRole.SUPER_ADMIN;
      await db.query(`UPDATE users SET role = $2, custom_role_id = $3, is_owner = $4 WHERE id = $1`, [targetId, role, customRoleId, stillOwner]);
      // A new built-in role changes the role claim in tokens and sockets: those sessions end now
      // (FR-AUTH-009). A custom-role change keeps the sessions; the permission resolver applies it
      // to the next request. Sessions issued without 2FA must not carry a role that requires it.
      if (role !== target.role || (isMfaRequiredRole(role) && !target.mfa_enabled)) { await revokeSessionsOf(db, user.orgId, { userId: targetId }, 'ROLE_CHANGED'); revoked = true; }
      await appendAuditEntry(db, {
        orgId: user.orgId, actorId: user.id, action: 'USER_ROLE_CHANGED', entityType: 'USER', entityId: targetId,
        before: { role: target.role, customRoleId: target.custom_role_id, isOwner: target.is_owner }, after: { role, customRoleId, isOwner: stillOwner },
      });
    });
    this.resolver.invalidateOrg(user.orgId);
    if (revoked) await this.gateway.closeAttendanceOnRevocation(user.orgId, targetId, null);
    return await this.userRow(user, targetId);
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

  private mapDbError(err: unknown): unknown {
    const e = err as { code?: string; constraint?: string };
    if (e?.code === '23505') return new ConflictException('A role with this name already exists');
    if (e?.code === '23514') return new BadRequestException('The role definition is not valid');
    return err;
  }
}

