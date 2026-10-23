/**
 * Workspace profile and ownership (ADR 037; FR-ORG-001, FR-AUTH-006).
 *
 *  - Profile: name, time zone, work week, onboarding; the sign-in settings (Google auto-join
 *    domain, 2FA after SSO) are changed by owners only.
 *  - Ownership moves only when the new owner accepts a transfer that the current owner confirmed
 *    with their password or a 2FA code. Several owners are allowed; the last one can never be
 *    removed. Every change is audited and ends the affected sessions (FR-AUTH-009).
 */
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { lockOrgForWrite } from '../common/lock-order.ts';
import { PermissionResolver } from '../common/permission-resolver.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { AttendanceService } from '../attendance/attendance.service.ts';
import { AttendanceGateway } from '../attendance/attendance.gateway.ts';
import { MAIL_TRANSPORT } from '../common/mailer.ts';
import type { MailTransport } from '../common/mailer.ts';
import { appWebUrl, renderActionEmail } from '../common/email-layout.ts';
import { verifyReauth } from '../auth/reauth.ts';
import { revokeSessionsOf } from '../auth/session-revocation.ts';
import { autoJoinDomainProblem } from '../auth/workspace.service.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import { Permission, userCan } from '../../../../packages/shared/src/auth/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import type { OrgProfile, OrgProfileUpdateDto, OwnershipTransfer, OwnershipTransferDto } from '../../../../packages/shared/src/auth/workspace.ts';
import { OwnershipTransferDtoSchema } from '../../../../packages/shared/src/auth/workspace.ts';

export const OWNERSHIP_TRANSFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface TransferRow {
  id: string; keep_ownership: boolean; status: OwnershipTransfer['status']; expires_at: Date; decided_at: Date | null; created_at: Date;
  from_id: string; from_name: string | null; from_email: string; to_id: string; to_name: string | null; to_email: string;
}
const TRANSFER_SELECT = `
  SELECT t.id, t.keep_ownership, t.status, t.expires_at, t.decided_at, t.created_at,
         f.id AS from_id, f.display_name AS from_name, f.email AS from_email,
         o.id AS to_id, o.display_name AS to_name, o.email AS to_email
  FROM ownership_transfers t JOIN users f ON f.id = t.from_user_id JOIN users o ON o.id = t.to_user_id`;

const mapTransfer = (r: TransferRow): OwnershipTransfer => ({
  id: r.id, keepOwnership: r.keep_ownership,
  status: r.status === 'PENDING' && r.expires_at.getTime() <= Date.now() ? 'EXPIRED' : r.status,
  from: { id: r.from_id, displayName: r.from_name, email: r.from_email },
  to: { id: r.to_id, displayName: r.to_name, email: r.to_email },
  expiresAt: r.expires_at.toISOString(), decidedAt: r.decided_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(),
});

export function googleSignInConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
}

@Injectable()
export class OwnershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
    private readonly attendance: AttendanceService,
    private readonly gateway: AttendanceGateway,
    @Inject(MAIL_TRANSPORT) private readonly mailer: MailTransport,
  ) {}

  // ---------------------------------------------------------------- profile

  async profile(user: AuthenticatedUser): Promise<OrgProfile> {
    return await this.prisma.runWithTenantContext(user.orgId, (db) => this.readProfile(db, user.orgId));
  }

  private async readProfile(db: pg.PoolClient, orgId: string): Promise<OrgProfile> {
    const r = (await db.query<{ id: string; name: string; slug: string; timezone: string; work_week: number[]; onboarded_at: Date | null; sso_auto_join_domain: string | null; mfa_for_sso: boolean; owner_count: number }>(
      `SELECT o.id, o.name, o.slug, o.timezone, o.work_week, o.onboarded_at, o.sso_auto_join_domain, o.mfa_for_sso,
              (SELECT count(*)::int FROM users u WHERE u.org_id = o.id AND u.is_owner AND u.status = 'ACTIVE') AS owner_count
       FROM organizations o WHERE o.id = $1`, [orgId])).rows[0];
    if (!r) throw new NotFoundException('Organisation not found');
    return {
      id: r.id, name: r.name, slug: r.slug, timezone: r.timezone, workWeek: r.work_week, onboardedAt: r.onboarded_at?.toISOString() ?? null,
      ssoAutoJoinDomain: r.sso_auto_join_domain, mfaForSso: r.mfa_for_sso, ownerCount: r.owner_count, googleSignInAvailable: googleSignInConfigured(),
    };
  }

  async updateProfile(user: AuthenticatedUser, dto: OrgProfileUpdateDto, ctx: RequestContext): Promise<OrgProfile> {
    const ownerOnly = dto.ssoAutoJoinDomain !== undefined || dto.mfaForSso !== undefined;
    if (ownerOnly && !userCan(user, Permission.ORG_OWNER)) throw new ForbiddenException('Only an owner can change the sign-in settings');
    if (dto.ssoAutoJoinDomain) {
      const problem = autoJoinDomainProblem(dto.ssoAutoJoinDomain, user.email);
      if (problem) throw new BadRequestException(problem);
    }
    const after = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await lockOrgForWrite(db, user.orgId);
      const before = await this.readProfile(db, user.orgId);
      await db.query(
        `UPDATE organizations SET
           name = COALESCE($2, name), timezone = COALESCE($3, timezone), work_week = COALESCE($4::jsonb, work_week),
           onboarded_at = CASE WHEN $5 THEN COALESCE(onboarded_at, now()) ELSE onboarded_at END,
           sso_auto_join_domain = CASE WHEN $6 THEN $7 ELSE sso_auto_join_domain END,
           mfa_for_sso = COALESCE($8, mfa_for_sso)
         WHERE id = $1`,
        [user.orgId, dto.name ?? null, dto.timezone ?? null, dto.workWeek ? JSON.stringify([...dto.workWeek].sort()) : null, dto.onboarded === true,
          dto.ssoAutoJoinDomain !== undefined, dto.ssoAutoJoinDomain ?? null, dto.mfaForSso ?? null],
      );
      const after = await this.readProfile(db, user.orgId);
      const pick = (p: OrgProfile) => ({ name: p.name, timezone: p.timezone, workWeek: p.workWeek, onboardedAt: p.onboardedAt, ssoAutoJoinDomain: p.ssoAutoJoinDomain, mfaForSso: p.mfaForSso });
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'ORG_PROFILE_UPDATED', entityType: 'ORGANIZATION', entityId: user.orgId, before: pick(before), after: pick(after), ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
      return after;
    });
    // The time zone feeds attendance work dates (FR-ATT-014).
    this.attendance.invalidatePolicy(user.orgId);
    return after;
  }

  // ---------------------------------------------------------------- ownership transfers

  async createTransfer(user: AuthenticatedUser, input: OwnershipTransferDto, ctx: RequestContext): Promise<OwnershipTransfer> {
    const dto = OwnershipTransferDtoSchema.parse(input);
    if (dto.newOwnerId === user.id) throw new BadRequestException('You already own this workspace');
    const row = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await verifyReauth(db, user.id, { password: dto.password, totpCode: dto.totpCode });
      const target = (await db.query<{ status: string; is_owner: boolean; email_verified_at: Date | null; email: string; display_name: string | null }>(
        `SELECT status, is_owner, email_verified_at, email, display_name FROM users WHERE id = $1`, [dto.newOwnerId])).rows[0];
      if (!target) throw new NotFoundException('User not found');
      if (target.status !== 'ACTIVE') throw new BadRequestException('Only an active person can become an owner');
      if (target.is_owner) throw new ConflictException('This person is already an owner');
      const open = await db.query(`SELECT 1 FROM ownership_transfers WHERE to_user_id = $1 AND status = 'PENDING' AND expires_at > now()`, [dto.newOwnerId]);
      if (open.rowCount) throw new ConflictException('A transfer to this person is already waiting for their acceptance');
      const id = (await db.query<{ id: string }>(
        `INSERT INTO ownership_transfers (org_id, from_user_id, to_user_id, keep_ownership, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [user.orgId, user.id, dto.newOwnerId, dto.keepOwnership, new Date(Date.now() + OWNERSHIP_TRANSFER_TTL_MS)])).rows[0]!.id;
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'OWNERSHIP_TRANSFER_REQUESTED', entityType: 'OWNERSHIP_TRANSFER', entityId: id, after: { to: dto.newOwnerId, keepOwnership: dto.keepOwnership }, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
      return (await db.query<TransferRow>(`${TRANSFER_SELECT} WHERE t.id = $1`, [id])).rows[0]!;
    });
    await this.mailer.send({ to: row.to_email, ...renderActionEmail({
      subject: 'You have been asked to take ownership of an HRVO workspace',
      intro: `${row.from_name ?? row.from_email} wants to make you an owner of their HRVO workspace${row.keep_ownership ? '' : ' and step down to Admin'}.`,
      buttonLabel: 'Review the request',
      url: `${appWebUrl()}/admin/users?transfer=${row.id}`,
      footer: ['You need to be signed in. The request is valid for 7 days. Nothing changes until you accept.'],
    }) });
    return mapTransfer(row);
  }

  /** Owners see every transfer; everyone else the ones addressed to or started by them. */
  async listTransfers(user: AuthenticatedUser): Promise<OwnershipTransfer[]> {
    const owner = userCan(user, Permission.ORG_OWNER);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => (await db.query<TransferRow>(
      `${TRANSFER_SELECT} WHERE ($2 OR t.to_user_id = $1 OR t.from_user_id = $1) ORDER BY t.created_at DESC`, [user.id, owner])).rows.map(mapTransfer));
  }

  async acceptTransfer(user: AuthenticatedUser, id: string, ctx: RequestContext): Promise<OwnershipTransfer> {
    const affected: string[] = [];
    const row = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext('ownership:' || $1::text))`, [user.orgId]);
      const t = (await db.query<{ from_user_id: string; to_user_id: string; keep_ownership: boolean; status: string; expires_at: Date }>(
        `SELECT from_user_id, to_user_id, keep_ownership, status, expires_at FROM ownership_transfers WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!t) throw new NotFoundException('Transfer not found');
      if (t.to_user_id !== user.id) throw new ForbiddenException('Only the person named in the transfer can accept it');
      if (t.status !== 'PENDING' || t.expires_at.getTime() <= Date.now()) throw new ConflictException('This transfer is no longer open');
      const from = (await db.query<{ is_owner: boolean; status: string }>(`SELECT is_owner, status FROM users WHERE id = $1 FOR NO KEY UPDATE`, [t.from_user_id])).rows[0];
      if (!from || !from.is_owner || from.status !== 'ACTIVE') throw new ConflictException('The person who started this transfer is no longer an owner');
      await db.query(`UPDATE users SET role = 'SUPER_ADMIN', custom_role_id = NULL, is_owner = true WHERE id = $1`, [t.to_user_id]);
      if (!t.keep_ownership) await db.query(`UPDATE users SET is_owner = false, role = 'ADMIN' WHERE id = $1`, [t.from_user_id]);
      await db.query(`UPDATE ownership_transfers SET status = 'ACCEPTED', decided_at = now() WHERE id = $1`, [id]);
      for (const uid of t.keep_ownership ? [t.to_user_id] : [t.to_user_id, t.from_user_id]) {
        await revokeSessionsOf(db, user.orgId, { userId: uid }, 'OWNERSHIP_CHANGED');
        affected.push(uid);
      }
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'OWNERSHIP_TRANSFER_ACCEPTED', entityType: 'OWNERSHIP_TRANSFER', entityId: id, after: { from: t.from_user_id, to: t.to_user_id, keepOwnership: t.keep_ownership }, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
      return (await db.query<TransferRow>(`${TRANSFER_SELECT} WHERE t.id = $1`, [id])).rows[0]!;
    });
    this.resolver.invalidateOrg(user.orgId);
    for (const uid of affected) await this.gateway.closeAttendanceOnRevocation(user.orgId, uid, null);
    return mapTransfer(row);
  }

  async cancelTransfer(user: AuthenticatedUser, id: string, ctx: RequestContext): Promise<OwnershipTransfer> {
    const owner = userCan(user, Permission.ORG_OWNER);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const t = (await db.query<{ from_user_id: string; status: string }>(`SELECT from_user_id, status FROM ownership_transfers WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!t) throw new NotFoundException('Transfer not found');
      if (!owner && t.from_user_id !== user.id) throw new ForbiddenException('Only an owner can cancel this transfer');
      if (t.status !== 'PENDING') throw new ConflictException('This transfer is no longer open');
      await db.query(`UPDATE ownership_transfers SET status = 'CANCELLED', decided_at = now() WHERE id = $1`, [id]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'OWNERSHIP_TRANSFER_CANCELLED', entityType: 'OWNERSHIP_TRANSFER', entityId: id, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
      return mapTransfer((await db.query<TransferRow>(`${TRANSFER_SELECT} WHERE t.id = $1`, [id])).rows[0]!);
    });
  }

  /** Takes ownership away (the person stays a super admin). Never from the last owner. */
  async removeOwner(user: AuthenticatedUser, targetId: string, proof: { password?: string; totpCode?: string }, ctx: RequestContext): Promise<{ removed: true }> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext('ownership:' || $1::text))`, [user.orgId]);
      await verifyReauth(db, user.id, proof);
      const target = (await db.query<{ is_owner: boolean }>(`SELECT is_owner FROM users WHERE id = $1 FOR NO KEY UPDATE`, [targetId])).rows[0];
      if (!target) throw new NotFoundException('User not found');
      if (!target.is_owner) throw new ConflictException('This person is not an owner');
      const others = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE is_owner AND status = 'ACTIVE' AND id <> $1`, [targetId])).rows[0]!.n;
      if (others === 0) throw new ConflictException('The last owner cannot be removed or demoted. Transfer ownership first.');
      await db.query(`UPDATE users SET is_owner = false WHERE id = $1`, [targetId]);
      await revokeSessionsOf(db, user.orgId, { userId: targetId }, 'OWNERSHIP_CHANGED');
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'OWNERSHIP_REMOVED', entityType: 'USER', entityId: targetId, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
    });
    this.resolver.invalidateOrg(user.orgId);
    await this.gateway.closeAttendanceOnRevocation(user.orgId, targetId, null);
    return { removed: true };
  }
}
