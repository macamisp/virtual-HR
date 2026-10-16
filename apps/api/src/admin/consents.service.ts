import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AgentService } from '../agent/agent.service.ts';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { CONSENT_NOTICES, CONSENT_TYPES } from '../../../../packages/shared/src/admin/types.ts';
import type { ConsentDto, ConsentOverview, ConsentRecord, ConsentType } from '../../../../packages/shared/src/admin/types.ts';

/**
 * FR-AUD-004: consent records for the monitoring notice, recording and AI features, each with
 * the notice version and the server time. monitoring_consents is append-only for the app:
 * withdrawing adds a row with granted = false, so the history is never rewritten.
 */
@Injectable()
export class ConsentsService {
  constructor(private readonly prisma: PrismaService, private readonly agents: AgentService) {}

  async overview(orgId: string, userId: string): Promise<ConsentOverview[]> {
    const rows = await this.prisma.runWithTenantContext(orgId, async (db) => {
      const user = await db.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
      if (!user.rows[0]) throw new NotFoundException('User not found');
      return (await db.query<{ id: string; consent_type: ConsentType; granted: boolean; notice_version: string; accepted_at: Date }>(
        `SELECT id, consent_type, granted, notice_version, accepted_at FROM monitoring_consents
         WHERE user_id = $1 ORDER BY accepted_at DESC, created_at DESC`,
        [userId],
      )).rows;
    });
    return CONSENT_TYPES.map((type) => {
      const history: ConsentRecord[] = rows
        .filter((r) => r.consent_type === type)
        .map((r) => ({ id: r.id, type, granted: r.granted, noticeVersion: r.notice_version, at: r.accepted_at.toISOString() }));
      const currentVersion = CONSENT_NOTICES[type].version;
      const latest = history.find((h) => h.noticeVersion === currentVersion);
      return { type, currentVersion, granted: latest ? latest.granted : null, history };
    });
  }

  async record(user: AuthenticatedUser, dto: ConsentDto, ctx: RequestContext): Promise<ConsentOverview[]> {
    if (dto.noticeVersion !== CONSENT_NOTICES[dto.type].version) throw new ConflictException('The notice has changed. Reload and read the current version.');
    if (dto.type === 'DESKTOP_AGENT' && dto.granted) throw new BadRequestException('The desktop agent consent is given in the agent itself when you pair it.');
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      // ADR 018: withdrawing the agent consent stops every agent of this user at once.
      if (dto.type === 'DESKTOP_AGENT') await this.agents.revokeAllForUser(db, user, { ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null });
      const res = await db.query<{ id: string }>(
        `INSERT INTO monitoring_consents (org_id, user_id, notice_version, consent_type, granted, accepted_at, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, now(), $6, $7) RETURNING id`,
        [user.orgId, user.id, dto.noticeVersion, dto.type, dto.granted, ctx.ip, ctx.userAgent],
      );
      await appendAuditEntry(db, {
        orgId: user.orgId, actorId: user.id, action: dto.granted ? 'CONSENT_GIVEN' : 'CONSENT_WITHDRAWN', entityType: 'CONSENT', entityId: res.rows[0]!.id,
        after: { type: dto.type, noticeVersion: dto.noticeVersion, granted: dto.granted }, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined,
      });
    });
    return await this.overview(user.orgId, user.id);
  }
}
