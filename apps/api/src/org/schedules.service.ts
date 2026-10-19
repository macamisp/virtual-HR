/**
 * Work schedule editor (FR-ORG-005; ADR 032). Versions per scope (organisation default, team,
 * person) never overlap: a change starts on a date (today or later), replaces versions that
 * would start on or after it, and ends the running version the day before. Past days keep the
 * schedule they were computed with, so the nightly replay (NFR-ACC-004) stays stable.
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { formatInTimeZone } from 'date-fns-tz';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import { AttendanceService } from '../attendance/attendance.service.ts';
import { scopeKey } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser, Schedule, ScheduleDto, ScheduleEndDto, ScheduleOverview, ScheduleScope } from '../../../../packages/shared/src/index.ts';

interface Row {
  id: string; user_id: string | null; team_id: string | null; days: Schedule['days']; flexible: boolean; grace_minutes: number;
  early_leave_grace_minutes: number | null; break_allowance_minutes: number | null; effective_from: string; effective_to: string | null;
}
const COLUMNS = `id, user_id, team_id, days, flexible, grace_minutes, early_leave_grace_minutes, break_allowance_minutes,
  to_char(effective_from, 'YYYY-MM-DD') AS effective_from, to_char(effective_to, 'YYYY-MM-DD') AS effective_to`;
const toSchedule = (r: Row): Schedule => ({
  id: r.id,
  scope: r.user_id ? { kind: 'USER', userId: r.user_id } : r.team_id ? { kind: 'TEAM', teamId: r.team_id } : { kind: 'ORG' },
  days: r.days, flexible: r.flexible, lateGraceMinutes: r.grace_minutes, earlyLeaveGraceMinutes: r.early_leave_grace_minutes,
  breakAllowanceMinutes: r.break_allowance_minutes, effectiveFrom: r.effective_from, effectiveTo: r.effective_to,
});
/** SQL condition selecting exactly one scope's rows ($1 = the scope's id, or null for the organisation). */
const scopeWhere = (s: ScheduleScope) => (s.kind === 'USER' ? 'user_id = $1' : s.kind === 'TEAM' ? 'team_id = $1' : '($1::uuid IS NULL AND user_id IS NULL AND team_id IS NULL)');
const scopeId = (s: ScheduleScope) => (s.kind === 'USER' ? s.userId : s.kind === 'TEAM' ? s.teamId : null);
const summary = (r: Row | undefined) => (r ? { id: r.id, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, flexible: r.flexible, lateGraceMinutes: r.grace_minutes, earlyLeaveGraceMinutes: r.early_leave_grace_minutes, breakAllowanceMinutes: r.break_allowance_minutes, days: r.days } : null);

@Injectable()
export class SchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attendance: AttendanceService,
  ) {}

  async overview(user: AuthenticatedUser): Promise<ScheduleOverview> {
    return this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const today = await this.today(db, user.orgId);
      const schedules = (await db.query<Row>(`SELECT ${COLUMNS} FROM work_schedules WHERE effective_to IS NULL OR effective_to >= $1::date ORDER BY effective_from`, [today])).rows.map(toSchedule);
      const teams = (await db.query<{ id: string; name: string }>(`SELECT id, name FROM teams ORDER BY lower(name)`)).rows;
      const people = (await db.query<{ id: string; display_name: string | null; email: string; team_id: string | null }>(
        `SELECT id, display_name, email, team_id FROM users WHERE anonymised_at IS NULL AND status <> 'OFFBOARDED' ORDER BY lower(coalesce(display_name, email))`,
      )).rows.map((p) => ({ id: p.id, displayName: p.display_name, email: p.email, teamId: p.team_id }));
      return { today, schedules, teams, people };
    });
  }

  async set(user: AuthenticatedUser, dto: ScheduleDto, ctx: RequestContext): Promise<Schedule> {
    return this.change(user, dto.scope, dto.effectiveFrom, async (db, before) => {
      const row = (await db.query<Row>(
        `INSERT INTO work_schedules (org_id, user_id, team_id, days, flexible, grace_minutes, early_leave_grace_minutes, break_allowance_minutes, effective_from)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
        [user.orgId, dto.scope.kind === 'USER' ? dto.scope.userId : null, dto.scope.kind === 'TEAM' ? dto.scope.teamId : null, JSON.stringify(dto.days),
          dto.flexible, dto.lateGraceMinutes, dto.earlyLeaveGraceMinutes ?? null, dto.breakAllowanceMinutes ?? null, dto.effectiveFrom],
      )).rows[0]!;
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'SCHEDULE_SET', entityType: 'WORK_SCHEDULE', entityId: row.id,
        before: { scope: scopeKey(dto.scope), schedule: summary(before) }, after: { scope: scopeKey(dto.scope), schedule: summary(row) }, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
      return toSchedule(row);
    });
  }

  async end(user: AuthenticatedUser, dto: ScheduleEndDto, ctx: RequestContext): Promise<{ ended: true }> {
    return this.change(user, dto.scope, dto.effectiveFrom, async (db, before, touched) => {
      if (!touched) throw new NotFoundException('This scope has no schedule in force on or after that date');
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'SCHEDULE_ENDED', entityType: 'WORK_SCHEDULE', entityId: before?.id ?? user.orgId,
        before: { scope: scopeKey(dto.scope), schedule: summary(before) }, after: { scope: scopeKey(dto.scope), endsBefore: dto.effectiveFrom }, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
      return { ended: true as const };
    });
  }

  // ---------------------------------------------------------------- helpers

  /**
   * One scope's versions from `from` on are replaced: later versions are removed and the running
   * one ends the day before. `fn` adds the new version (or, for an end, nothing).
   */
  private async change<T>(user: AuthenticatedUser, scope: ScheduleScope, from: string, fn: (db: pg.PoolClient, before: Row | undefined, touched: boolean) => Promise<T>): Promise<T> {
    let today = '';
    const result = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext('schedule:' || $1::text || ':' || $2::text))`, [user.orgId, scopeKey(scope)]);
      today = await this.today(db, user.orgId);
      if (from < today) throw new BadRequestException(`A schedule change starts today (${today}) or later; past days keep their schedule`);
      await this.assertScope(db, scope);
      const id = scopeId(scope);
      const before = (await db.query<Row>(
        `SELECT ${COLUMNS} FROM work_schedules WHERE ${scopeWhere(scope)} AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
         ORDER BY effective_from DESC LIMIT 1`, [id, from])).rows[0];
      const removed = (await db.query(`DELETE FROM work_schedules WHERE ${scopeWhere(scope)} AND effective_from >= $2::date`, [id, from])).rowCount ?? 0;
      const ended = (await db.query(`UPDATE work_schedules SET effective_to = $2::date - 1 WHERE ${scopeWhere(scope)} AND effective_from < $2::date AND (effective_to IS NULL OR effective_to >= $2::date)`, [id, from])).rowCount ?? 0;
      return fn(db, before, removed + ended > 0);
    });
    if (from === today) await this.refreshToday(user.orgId, scope, today);
    return result;
  }

  private async assertScope(db: pg.PoolClient, scope: ScheduleScope): Promise<void> {
    if (scope.kind === 'TEAM' && !(await db.query(`SELECT 1 FROM teams WHERE id = $1`, [scope.teamId])).rowCount) throw new NotFoundException('Team not found');
    if (scope.kind === 'USER' && !(await db.query(`SELECT 1 FROM users WHERE id = $1 AND anonymised_at IS NULL`, [scope.userId])).rowCount) throw new NotFoundException('Person not found');
  }

  /** A change from today reaches today's stored days at once (expected hours, late flags). */
  private async refreshToday(orgId: string, scope: ScheduleScope, today: string): Promise<void> {
    const ids = await this.prisma.runWithTenantContext(orgId, async (db) =>
      (await db.query<{ user_id: string }>(
        `SELECT d.user_id FROM attendance_daily d JOIN users u ON u.id = d.user_id WHERE d.work_date = $1::text
           AND ($2::text = 'ORG' OR ($2 = 'TEAM' AND u.team_id = $3::uuid) OR ($2 = 'USER' AND u.id = $3::uuid))`,
        [today, scope.kind, scopeId(scope)])).rows.map((r) => r.user_id));
    for (const id of ids) await this.attendance.recomputeDailySummaryForUser(orgId, id, today);
  }

  private async today(db: pg.PoolClient, orgId: string): Promise<string> {
    const tz = (await db.query<{ timezone: string }>(`SELECT timezone FROM organizations WHERE id = $1`, [orgId])).rows[0]?.timezone ?? 'UTC';
    return formatInTimeZone(new Date(), tz, 'yyyy-MM-dd');
  }
}

