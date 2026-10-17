/**
 * FR-ADM-002: the effective permissions of the signed-in user, from the database rather than
 * the token alone: built-in base role, plus a custom role's additions and removals. Also
 * refreshes role, team and status, so a role change or deactivation takes effect within the
 * cache lifetime (30 s) instead of at the next token refresh (15 min). Per API instance.
 */
import { Global, Injectable, Module, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from './prisma.service.ts';
import { effectivePermissions, requiresMfa } from '../../../../packages/shared/src/auth/types.ts';
import type { Permission, UserRole } from '../../../../packages/shared/src/auth/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';

export interface ResolvedAccess {
  role: UserRole;
  teamId: string | null;
  permissions: Permission[];
  customRoleId: string | null;
  customRoleName: string | null;
}

const TTL_MS = 30_000;

@Injectable()
export class PermissionResolver {
  private readonly cache = new Map<string, { at: number; value: ResolvedAccess }>();

  constructor(private readonly prisma: PrismaService) {}

  async resolve(user: Pick<AuthenticatedUser, 'id' | 'orgId'>): Promise<ResolvedAccess> {
    const key = `${user.orgId}:${user.id}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const row = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const res = await db.query<{ role: UserRole; team_id: string | null; status: string; mfa_enabled: boolean; custom_role_id: string | null; name: string | null; base_role: string | null; added: string[] | null; removed: string[] | null }>(
        `SELECT u.role, u.team_id, u.status, u.mfa_enabled, u.custom_role_id, r.name, r.base_role, r.added_permissions AS added, r.removed_permissions AS removed
         FROM users u LEFT JOIN org_roles r ON r.id = u.custom_role_id WHERE u.id = $1`,
        [user.id],
      );
      return res.rows[0];
    });
    if (!row || row.status !== 'ACTIVE') {
      this.cache.delete(key);
      throw new UnauthorizedException('Your account is not active');
    }
    const permissions = effectivePermissions(row.role, row.added ?? [], row.removed ?? []);
    // A role change can make 2FA mandatory (FR-AUTH-004); until it is enrolled the old token
    // stops working and the next sign-in leads to enrolment.
    if (requiresMfa(row.role, permissions) && !row.mfa_enabled) {
      this.cache.delete(key);
      throw new UnauthorizedException('Two-factor authentication is required for your role. Sign in again to set it up.');
    }
    const value: ResolvedAccess = {
      role: row.role,
      teamId: row.team_id,
      permissions,
      customRoleId: row.custom_role_id,
      customRoleName: row.name,
    };
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** After a role definition or assignment changes. */
  invalidateOrg(orgId: string): void {
    for (const k of this.cache.keys()) if (k.startsWith(`${orgId}:`)) this.cache.delete(k);
  }
}

@Global()
// One PrismaService (and so one pg pool) for the whole app: modules must not provide their own.
@Module({ providers: [PrismaService, PermissionResolver], exports: [PrismaService, PermissionResolver] })
export class PermissionsModule {}
