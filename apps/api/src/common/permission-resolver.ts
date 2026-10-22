/**
 * FR-ADM-002: the effective permissions of the signed-in user, from the database rather than
 * the token alone: built-in base role, plus a custom role's additions and removals, plus
 * org.owner for workspace owners (ADR 037). Also refreshes role, team and status, so a role
 * change or deactivation takes effect within the cache lifetime (30 s) instead of at the next
 * token refresh (15 min). The token's session is checked at the same time, so a revoked session
 * (role or ownership change, suspension, admin revocation; FR-AUTH-009) stops working within the
 * cache lifetime, and at once when the change invalidates the cache of this instance and, with
 * COORDINATION=redis, of every other API instance too.
 */
import { Global, Injectable, Module, UnauthorizedException } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from './prisma.service.ts';
import { mfaEnforced } from './config.ts';
import { coordinationEnabled, newRedis, sharedRedis } from './coordination.ts';
import { effectivePermissions, Permission, requiresMfa } from '../../../../packages/shared/src/auth/types.ts';
import type { UserRole } from '../../../../packages/shared/src/auth/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';

export interface ResolvedAccess {
  role: UserRole;
  teamId: string | null;
  permissions: Permission[];
  customRoleId: string | null;
  customRoleName: string | null;
  isOwner: boolean;
  jobTitle: string | null;
  signInMethods: { password: boolean; google: boolean; googleEmail: string | null };
}

const TTL_MS = 30_000;
const CHANNEL = 'hrvo:access-invalidate';

/** Permissions of a person from their stored role, custom role and ownership flag. */
export function resolvePermissions(row: { role: string; added: string[] | null; removed: string[] | null; is_owner: boolean }): Permission[] {
  const permissions: Permission[] = effectivePermissions(row.role, row.added ?? [], row.removed ?? []).filter((p) => p !== Permission.ORG_OWNER);
  if (row.is_owner) permissions.push(Permission.ORG_OWNER);
  return permissions;
}

@Injectable()
export class PermissionResolver implements OnModuleInit, OnModuleDestroy {
  private readonly cache = new Map<string, { at: number; value: ResolvedAccess }>();
  private subscriber: Redis | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    if (!coordinationEnabled()) return;
    this.subscriber = newRedis();
    await this.subscriber.subscribe(CHANNEL);
    this.subscriber.on('message', (channel: string, orgId: string) => { if (channel === CHANNEL) this.forget(orgId); });
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.quit().catch(() => this.subscriber?.disconnect());
    this.subscriber = null;
  }

  async resolve(user: Pick<AuthenticatedUser, 'id' | 'orgId' | 'sessionId'>): Promise<ResolvedAccess> {
    const key = `${user.orgId}:${user.id}:${user.sessionId ?? ''}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const row = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const res = await db.query<{ role: UserRole; team_id: string | null; status: string; mfa_enabled: boolean; is_owner: boolean; job_title: string | null; custom_role_id: string | null; name: string | null; base_role: string | null; added: string[] | null; removed: string[] | null; session_revoked: boolean | null; login_method: string | null; mfa_for_sso: boolean; has_password: boolean; google_email: string | null }>(
        `SELECT u.role, u.team_id, u.status, u.mfa_enabled, u.is_owner, u.job_title, u.custom_role_id, r.name, r.base_role, r.added_permissions AS added, r.removed_permissions AS removed,
                (s.is_revoked AND s.revoked_reason IS DISTINCT FROM 'ROTATED') AS session_revoked,
                s.login_method, o.mfa_for_sso,
                (u.password_hash IS NOT NULL) AS has_password,
                (SELECT i.email FROM oauth_identities i WHERE i.user_id = u.id AND i.provider = 'GOOGLE' LIMIT 1) AS google_email
         FROM users u JOIN organizations o ON o.id = u.org_id LEFT JOIN org_roles r ON r.id = u.custom_role_id
         LEFT JOIN auth_sessions s ON s.id = $2::uuid AND s.user_id = u.id
         WHERE u.id = $1`,
        [user.id, user.sessionId ?? null],
      );
      return res.rows[0];
    });
    if (!row || row.status !== 'ACTIVE') {
      this.cache.delete(key);
      throw new UnauthorizedException('Your account is not active');
    }
    if (row.session_revoked) {
      this.cache.delete(key);
      throw new UnauthorizedException('Your session has ended. Sign in again.');
    }
    const permissions = resolvePermissions(row);
    // A role change can make 2FA mandatory (FR-AUTH-004); until it is enrolled the old token
    // stops working and the next sign-in leads to enrolment. A Google session is exempt where the
    // owner switched "2FA after Google" off (ADR 037): Google already verified the person.
    const googleExempt = row.login_method === 'GOOGLE' && !row.mfa_for_sso;
    if (requiresMfa(row.role, permissions) && !row.mfa_enabled && mfaEnforced() && !googleExempt) {
      this.cache.delete(key);
      throw new UnauthorizedException('Two-factor authentication is required for your role. Sign in again to set it up.');
    }
    const value: ResolvedAccess = {
      role: row.role,
      teamId: row.team_id,
      permissions,
      customRoleId: row.custom_role_id,
      customRoleName: row.name,
      isOwner: row.is_owner,
      jobTitle: row.job_title,
      signInMethods: { password: row.has_password, google: row.google_email !== null, googleEmail: row.google_email },
    };
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** After a role definition, assignment, ownership or status change: this instance now, the others via Redis. */
  invalidateOrg(orgId: string): void {
    this.forget(orgId);
    if (coordinationEnabled()) void sharedRedis().publish(CHANNEL, orgId).catch(() => undefined);
  }

  private forget(orgId: string): void {
    for (const k of this.cache.keys()) if (k.startsWith(`${orgId}:`)) this.cache.delete(k);
  }
}

@Global()
// One PrismaService (and so one pg pool) for the whole app: modules must not provide their own.
@Module({ providers: [PrismaService, PermissionResolver], exports: [PrismaService, PermissionResolver] })
export class PermissionsModule {}
