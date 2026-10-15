import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { hasPermission, Permission } from '../../../../packages/shared/src/auth/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import type {
  ProjectRateDto,
  RateProfileDto,
  RateTypeName,
  RatesList,
  TimesheetSettings,
  TimesheetSettingsDto,
} from '../../../../packages/shared/src/timesheets/types.ts';
import { toIso, userRef } from '../tasks/tasks.sql.ts';
import { orgSettings } from './timesheet-store.ts';

/**
 * FR-ORG-002 rate fields and FR-ORG-004 project overrides (minimal, for FR-TS-009), plus the
 * org timesheet settings (SRS 6.4). Rate changes are audited: they change what people are paid.
 */
@Injectable()
export class RatesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser): Promise<RatesList> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const people = await db.query<{ id: string; display_name: string | null; email: string; role: string; rate_type: RateTypeName | null; rate: string | null; currency: string | null; overtime_multiplier: string | null; weekly_hours_cap: string | null; updated_at: Date | null }>(
        `SELECT u.id, u.display_name, u.email, u.role, p.rate_type, p.rate::text, p.currency, p.overtime_multiplier::text,
                p.weekly_hours_cap::text, p.updated_at
         FROM users u LEFT JOIN subcontractor_profiles p ON p.user_id = u.id
         WHERE u.role = 'SUBCONTRACTOR' AND u.status = 'ACTIVE'
         ORDER BY u.display_name NULLS LAST, u.email`,
      );
      const overrides = await db.query<{ project_id: string; name: string; user_id: string; display_name: string | null; email: string; role: string; rate_override: string | null }>(
        `SELECT m.project_id, pr.name, m.user_id, u.display_name, u.email, u.role, m.rate_override::text
         FROM project_members m JOIN projects pr ON pr.id = m.project_id JOIN users u ON u.id = m.user_id
         WHERE u.role = 'SUBCONTRACTOR' AND u.status = 'ACTIVE'
         ORDER BY pr.name, u.display_name NULLS LAST, u.email`,
      );
      return {
        items: people.rows.map((r) => ({
          user: userRef(r.id, r.display_name, r.email, r.role),
          profile: r.rate_type && r.rate && r.currency && r.overtime_multiplier
            ? { rateType: r.rate_type, rate: r.rate, currency: r.currency, overtimeMultiplier: r.overtime_multiplier, weeklyHoursCap: r.weekly_hours_cap, updatedAt: toIso(r.updated_at)! }
            : null,
        })),
        projectRates: overrides.rows.map((o) => ({ projectId: o.project_id, projectName: o.name, user: userRef(o.user_id, o.display_name, o.email, o.role), rateOverride: o.rate_override })),
        canManage: hasPermission(user.role, Permission.RATES_MANAGE),
      };
    });
  }

  async upsert(user: AuthenticatedUser, userId: string, dto: RateProfileDto): Promise<RatesList> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const target = await db.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [userId]);
      if (!target.rows[0]) throw new NotFoundException('User not found');
      if (target.rows[0].role !== 'SUBCONTRACTOR') throw new BadRequestException('Rates apply to subcontractors only');
      const before = await db.query(`SELECT rate_type, rate::text, currency, overtime_multiplier::text, weekly_hours_cap::text FROM subcontractor_profiles WHERE user_id = $1`, [userId]);
      await db.query(
        `INSERT INTO subcontractor_profiles (user_id, org_id, rate_type, rate, currency, overtime_multiplier, weekly_hours_cap, updated_by, updated_at)
         VALUES ($1, $2, $3, $4::numeric, $5, $6::numeric, $7::numeric, $8, now())
         ON CONFLICT (user_id) DO UPDATE SET rate_type = EXCLUDED.rate_type, rate = EXCLUDED.rate, currency = EXCLUDED.currency,
           overtime_multiplier = EXCLUDED.overtime_multiplier, weekly_hours_cap = EXCLUDED.weekly_hours_cap,
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [userId, user.orgId, dto.rateType, dto.rate, dto.currency, dto.overtimeMultiplier, dto.weeklyHoursCap, user.id],
      );
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'RATE_PROFILE_SET', entityType: 'USER', entityId: userId, before: before.rows[0] ?? null, after: dto });
    });
    return await this.list(user);
  }

  async setProjectRate(user: AuthenticatedUser, projectId: string, userId: string, dto: ProjectRateDto): Promise<RatesList> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const res = await db.query<{ rate_override: string | null }>(
        `SELECT m.rate_override::text FROM project_members m JOIN users u ON u.id = m.user_id
         WHERE m.project_id = $1 AND m.user_id = $2 AND u.role = 'SUBCONTRACTOR' FOR UPDATE OF m`,
        [projectId, userId],
      );
      if (!res.rows[0]) throw new NotFoundException('This subcontractor is not a member of the project');
      await db.query(`UPDATE project_members SET rate_override = $3::numeric WHERE project_id = $1 AND user_id = $2`, [projectId, userId, dto.rateOverride]);
      await appendAuditEntry(db, {
        orgId: user.orgId, actorId: user.id, action: 'PROJECT_RATE_SET', entityType: 'PROJECT', entityId: projectId,
        before: { userId, rateOverride: res.rows[0].rate_override }, after: { userId, rateOverride: dto.rateOverride },
      });
    });
    return await this.list(user);
  }

  async settings(user: AuthenticatedUser): Promise<TimesheetSettings> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const s = await orgSettings(db, user.orgId);
      return { period: s.period, periodAnchor: s.periodAnchor, manualLimitMinutes: s.manualLimitMinutes, variancePct: s.variancePct, submitDueDays: s.submitDueDays };
    });
  }

  /** Period changes apply to timesheets created from now on; existing ones keep their dates. */
  async updateSettings(user: AuthenticatedUser, dto: TimesheetSettingsDto): Promise<TimesheetSettings> {
    const [y, m, d] = dto.periodAnchor.split('-').map(Number);
    if (new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() !== 1) throw new BadRequestException('The bi-weekly anchor must be a Monday');
    const before = await this.settings(user);
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(
        `UPDATE organizations SET timesheet_period = $2, timesheet_period_anchor = $3::date, manual_time_limit_minutes = $4,
           timesheet_variance_pct = $5, timesheet_submit_due_days = $6 WHERE id = $1`,
        [user.orgId, dto.period, dto.periodAnchor, dto.manualLimitMinutes, dto.variancePct, dto.submitDueDays],
      );
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'TIMESHEET_SETTINGS_UPDATED', entityType: 'ORGANIZATION', entityId: user.orgId, before, after: dto });
    });
    return await this.settings(user);
  }
}
