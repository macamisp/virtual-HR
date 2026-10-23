/**
 * ADR 039: what an e-mailed link can still do, and a fresh link when it no longer works.
 *
 * Every account e-mail (address confirmation, invitation, password reset) lands on a page that
 * first asks `status` so it can say plainly "already used", "expired" or "withdrawn" instead of
 * failing after the person filled in a form. `renew` sends a new link, always to the address the
 * old one was sent to (never to an address from the request), answers the same way whatever
 * happened, and is limited per IP by the `signup` bucket and per person by a cooldown.
 */
import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { AuthService } from './auth.service.ts';
import { WorkspaceService } from './workspace.service.ts';
import type { LinkStatus, LinkTokenDto } from '../../../../packages/shared/src/auth/workspace.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITATION_RENEW_COOLDOWN_SECONDS = 60;
const RENEW_MESSAGE = 'If this link can be renewed, a new one is on its way to the address it was sent to. It can take a minute to arrive.';

interface Meta { ip?: string; userAgent?: string }

@Injectable()
export class AccountLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly workspaces: WorkspaceService,
  ) {}

  async status(dto: LinkTokenDto): Promise<LinkStatus> {
    const none: LinkStatus = { state: 'invalid', email: null, workspace: null, alreadyVerified: false };
    const pool = this.prisma.getPool();
    const hash = sha256(dto.token);
    if (dto.kind === 'verify') {
      const row = (await pool.query<{ org_id: string; user_id: string; expires_at: Date; used_at: Date | null }>(`SELECT * FROM fn_lookup_email_verification($1)`, [hash])).rows[0];
      if (!row) return none;
      const who = await this.person(row.org_id, row.user_id);
      if (!who) return none;
      return { state: timeState(row.used_at, row.expires_at), email: who.email, workspace: who.workspace, alreadyVerified: who.verified };
    }
    if (dto.kind === 'invite') {
      const row = (await pool.query<{ org_id: string; email: string; accepted_at: Date | null; revoked_at: Date | null; expires_at: Date }>(`SELECT * FROM fn_lookup_invitation_for_signup($1)`, [hash])).rows[0];
      if (!row) return none;
      const state = row.revoked_at ? 'revoked' : timeState(row.accepted_at, row.expires_at);
      return { state, email: row.email, workspace: await this.auth.workspaceName(row.org_id), alreadyVerified: false };
    }
    const row = (await pool.query<{ org_id: string; user_id: string; expires_at: Date; used_at: Date | null; user_status: string }>(`SELECT * FROM fn_lookup_password_reset($1)`, [hash])).rows[0];
    if (!row) return none;
    const who = await this.person(row.org_id, row.user_id);
    if (!who) return none;
    return { state: row.user_status !== 'ACTIVE' ? 'revoked' : timeState(row.used_at, row.expires_at), email: who.email, workspace: who.workspace, alreadyVerified: false };
  }

  async renew(dto: LinkTokenDto, meta: Meta): Promise<{ success: true; message: string }> {
    const pool = this.prisma.getPool();
    const hash = sha256(dto.token);
    if (dto.kind === 'verify') {
      const row = (await pool.query<{ org_id: string; user_id: string }>(`SELECT * FROM fn_lookup_email_verification($1)`, [hash])).rows[0];
      const who = row ? await this.person(row.org_id, row.user_id) : null;
      if (row && who && !who.verified) await this.workspaces.resendForUser(row.org_id, row.user_id, who.workspace);
    } else if (dto.kind === 'invite') {
      await this.renewInvitation(hash, meta);
    } else {
      const row = (await pool.query<{ org_id: string; user_id: string; expires_at: Date; used_at: Date | null; user_status: string }>(`SELECT * FROM fn_lookup_password_reset($1)`, [hash])).rows[0];
      const who = row && row.user_status === 'ACTIVE' ? await this.person(row.org_id, row.user_id) : null;
      // Only a link that no longer works is renewed; a working one can simply be used.
      if (row && who && timeState(row.used_at, row.expires_at) !== 'valid') await this.auth.requestPasswordReset(who.email, meta.ip, meta.userAgent);
    }
    return { success: true, message: RENEW_MESSAGE };
  }

  /** An expired, still pending invitation gets a fresh link (same role and team), audited. */
  private async renewInvitation(hash: string, meta: Meta): Promise<void> {
    const row = (await this.prisma.getPool().query<{ id: string; org_id: string; email: string; invited_by: string; accepted_at: Date | null; revoked_at: Date | null; expires_at: Date }>(
      `SELECT * FROM fn_lookup_invitation_for_signup($1)`, [hash])).rows[0];
    if (!row || row.accepted_at || row.revoked_at || timeState(null, row.expires_at) !== 'expired') return;
    const token = randomBytes(32).toString('hex');
    const inviter = await this.prisma.runWithTenantContext(row.org_id, async (db) => {
      const claimed = await db.query(
        `UPDATE invitations SET token_hash = $2, expires_at = $3, last_sent_at = now()
         WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now()
           AND (last_sent_at IS NULL OR last_sent_at < now() - make_interval(secs => $4))
         RETURNING id`,
        [row.id, sha256(token), new Date(Date.now() + INVITATION_TTL_MS), INVITATION_RENEW_COOLDOWN_SECONDS]);
      if (claimed.rowCount === 0) return null;
      await appendAuditEntry(db, { orgId: row.org_id, actorId: row.invited_by, action: 'INVITATION_RESENT', entityType: 'INVITATION', entityId: row.id, after: { email: row.email, by: 'invitee_expired_link' }, ip: meta.ip, userAgent: meta.userAgent });
      const u = (await db.query<{ display_name: string | null; email: string }>(`SELECT display_name, email FROM users WHERE id = $1`, [row.invited_by])).rows[0];
      return u?.display_name ?? u?.email ?? 'Your HR contact';
    });
    if (inviter) await this.auth.sendInvitation(row.email, token, inviter, await this.auth.workspaceName(row.org_id));
  }

  private async person(orgId: string, userId: string): Promise<{ email: string; verified: boolean; workspace: string } | null> {
    const r = await this.prisma.runWithTenantContext(orgId, (db) => db.query<{ email: string; email_verified_at: Date | null; name: string }>(
      `SELECT u.email, u.email_verified_at, o.name FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = $1`, [userId]));
    const u = r.rows[0];
    return u ? { email: u.email, verified: !!u.email_verified_at, workspace: u.name } : null;
  }
}

function timeState(usedAt: Date | null, expiresAt: Date): 'valid' | 'used' | 'expired' {
  if (usedAt) return 'used';
  return new Date(expiresAt).getTime() <= Date.now() ? 'expired' : 'valid';
}
