import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { PlanningService } from '../planning/planning.service.ts';
import { addDaysIso, capacityFromSchedule } from '../planning/planning-rules.ts';
import { localDate } from '../notifications/reminder-rules.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import type { UserRef } from '../../../../packages/shared/src/tasks/types.ts';
import type {
  ApprovalEvent,
  ApproveTimesheetDto,
  Payable,
  RejectTimesheetDto,
  ReopenTimesheetDto,
  SubmitTimesheetDto,
  TimesheetDay,
  TimesheetDetail,
  TimesheetListQuery,
  TimesheetNotesDto,
  TimesheetStatus,
  TimesheetSummary,
} from '../../../../packages/shared/src/timesheets/types.ts';
import { toIso, userRef } from '../tasks/tasks.sql.ts';
import { computePayable, parseMoney, payableEntryRange } from './money.ts';
import type { RateType } from './money.ts';
import { datesBetween } from './periods.ts';
import { ensureTimesheet, isEditable, orgSettings, refreshDay, refreshTotals } from './timesheet-store.ts';
import type { OrgTimesheetSettings } from './timesheet-store.ts';
import { timesheetPermissions } from './timesheet-policy.ts';
import { actorOf, visibleOwnersSql } from './timesheets.sql.ts';
import { TimeEntriesService } from './time-entries.service.ts';
import { TimesheetEvents } from './timesheet-events.ts';
import type { TimesheetEventMap } from './timesheet-events.ts';

type Db = pg.PoolClient;
type PendingEvent = { [K in keyof TimesheetEventMap]: { name: K; payload: TimesheetEventMap[K] } }[keyof TimesheetEventMap];

const SUMMARY_SELECT = `
  SELECT t.id, t.user_id, to_char(t.period_start, 'YYYY-MM-DD') AS period_start, to_char(t.period_end, 'YYYY-MM-DD') AS period_end,
         t.status, t.attendance_minutes, t.logged_minutes, t.billable_minutes, t.variance_minutes, t.flagged_days,
         t.amount::text AS amount, t.currency, t.submitted_at, t.approved_at, t.version,
         t.notes, t.rejection_reason, t.reopen_reason, t.payable, t.approved_by,
         u.display_name, u.email, u.role, u.manager_id, u.team_id,
         ap.display_name AS ap_name, ap.email AS ap_email, ap.role AS ap_role
  FROM timesheets t
  JOIN users u ON u.id = t.user_id
  LEFT JOIN users ap ON ap.id = t.approved_by`;

interface SheetRow {
  id: string;
  user_id: string;
  period_start: string;
  period_end: string;
  status: TimesheetStatus;
  attendance_minutes: number;
  logged_minutes: number;
  billable_minutes: number;
  variance_minutes: number;
  flagged_days: number;
  amount: string | null;
  currency: string | null;
  submitted_at: Date | null;
  approved_at: Date | null;
  version: number;
  notes: string;
  rejection_reason: string | null;
  reopen_reason: string | null;
  payable: Payable | null;
  approved_by: string | null;
  display_name: string | null;
  email: string;
  role: string;
  manager_id: string | null;
  team_id: string | null;
  ap_name: string | null;
  ap_email: string | null;
  ap_role: string | null;
}

function mapSummary(r: SheetRow): TimesheetSummary {
  return {
    id: r.id,
    user: userRef(r.user_id, r.display_name, r.email, r.role),
    periodStart: r.period_start,
    periodEnd: r.period_end,
    status: r.status,
    attendanceMinutes: r.attendance_minutes,
    loggedMinutes: r.logged_minutes,
    billableMinutes: r.billable_minutes,
    varianceMinutes: r.variance_minutes,
    flaggedDays: r.flagged_days,
    amount: r.amount,
    currency: r.currency,
    submittedAt: toIso(r.submitted_at),
    approvedAt: toIso(r.approved_at),
    version: r.version,
  };
}

/** FR-TS-002 periodic timesheets, FR-TS-006 submission and approval, FR-TS-009 payable, FR-TS-011 reopen. */
@Injectable()
export class TimesheetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entries: TimeEntriesService,
    private readonly planning: PlanningService,
    private readonly events: TimesheetEvents,
  ) {}

  protected now(): Date {
    return new Date();
  }

  // ---------------------------------------------------------------- queries

  async list(user: AuthenticatedUser, q: TimesheetListQuery): Promise<{ items: TimesheetSummary[] }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const params: unknown[] = [user.orgId];
      const where = [`t.org_id = $1`, visibleOwnersSql(user, params, q.scope)];
      if (q.status) {
        params.push(q.status);
        where.push(`t.status = $${params.length}`);
      }
      if (q.userId) {
        params.push(q.userId);
        where.push(`t.user_id = $${params.length}`);
      }
      if (q.from) {
        params.push(q.from);
        where.push(`t.period_end >= $${params.length}::date`);
      }
      if (q.to) {
        params.push(q.to);
        where.push(`t.period_start <= $${params.length}::date`);
      }
      const res = await db.query<SheetRow>(`${SUMMARY_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.period_start DESC, u.display_name NULLS LAST, u.email LIMIT 300`, params);
      return { items: res.rows.map(mapSummary) };
    });
  }

  /** My timesheet for the current period, created on first view (FR-TS-002). */
  async current(user: AuthenticatedUser): Promise<TimesheetDetail> {
    const id = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const s = await orgSettings(db, user.orgId);
      return (await ensureTimesheet(db, user.orgId, user.id, localDate(this.now(), s.timezone), s)).id;
    });
    return await this.detail(user, id);
  }

  async detail(user: AuthenticatedUser, id: string): Promise<TimesheetDetail> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const settings = await orgSettings(db, user.orgId);
      let row = await this.load(db, user, id);
      // Keep today's attendance figure live while the period is open.
      const today = localDate(this.now(), settings.timezone);
      if (isEditable(row.status) && today >= row.period_start && today <= row.period_end) {
        await refreshDay(db, user.orgId, row.user_id, today, settings);
        row = await this.load(db, user, id);
      }
      return await this.build(db, user, row, settings);
    });
  }

  // ---------------------------------------------------------------- owner actions

  async updateNotes(user: AuthenticatedUser, id: string, dto: TimesheetNotesDto): Promise<TimesheetDetail> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const row = await this.load(db, user, id, true);
      if (!this.perms(user, row).canEdit) throw new ForbiddenException('Only the owner can edit an open timesheet');
      this.assertVersion(row, dto.version);
      await db.query(`UPDATE timesheets SET notes = $2, version = version + 1, updated_at = now() WHERE id = $1`, [id, dto.notes]);
      return await this.build(db, user, await this.load(db, user, id), await orgSettings(db, user.orgId));
    });
  }

  async submit(user: AuthenticatedUser, id: string, dto: SubmitTimesheetDto): Promise<TimesheetDetail> {
    const pending: PendingEvent[] = [];
    const out = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const settings = await orgSettings(db, user.orgId);
      const row = await this.load(db, user, id, true);
      if (!this.perms(user, row).canSubmit) {
        throw row.user_id === user.id ? new ConflictException(`A ${row.status.toLowerCase()} timesheet cannot be submitted`) : new ForbiddenException('Only the owner submits a timesheet');
      }
      this.assertVersion(row, dto.version);
      const today = localDate(this.now(), settings.timezone);
      if (today < row.period_end) throw new ConflictException(`This period runs until ${row.period_end}; submit it on or after its last day`);
      const running = await db.query(`SELECT 1 FROM time_entries WHERE timesheet_id = $1 AND ended_at IS NULL`, [id]);
      if ((running.rowCount ?? 0) > 0) throw new ConflictException('Stop the running timer before submitting');
      // Final reconciliation of every day of the period (FR-TS-005).
      for (const d of datesBetween(row.period_start, row.period_end)) await refreshDay(db, user.orgId, row.user_id, d, settings);
      await refreshTotals(db, id);
      await db.query(
        `UPDATE timesheets SET status = 'SUBMITTED', submitted_at = now(), rejection_reason = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
        [id],
      );
      await this.record(db, user, id, 'SUBMIT', '');
      pending.push({ name: 'timesheet.submitted', payload: { ...this.base(user, row), approverIds: await approversFor(db, row.user_id) } });
      return await this.build(db, user, await this.load(db, user, id), settings);
    });
    this.flush(pending);
    return out;
  }

  // ---------------------------------------------------------------- approver actions

  async approve(user: AuthenticatedUser, id: string, dto: ApproveTimesheetDto): Promise<TimesheetDetail> {
    const pending: PendingEvent[] = [];
    const out = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const settings = await orgSettings(db, user.orgId);
      const row = await this.load(db, user, id, true);
      this.assertCanApprove(user, row);
      this.assertVersion(row, dto.version);
      let payable: Payable | null;
      try {
        payable = await this.computePayable(db, user.orgId, row, true);
      } catch (err) {
        if (err instanceof Error && /too large/.test(err.message)) throw new ConflictException(err.message);
        throw err;
      }
      await db.query(
        `UPDATE timesheets SET status = 'APPROVED', approved_by = $2, approved_at = now(), amount = $3::numeric, currency = $4,
           payable = $5::jsonb, version = version + 1, updated_at = now() WHERE id = $1`,
        [id, user.id, payable?.amount ?? null, payable?.currency ?? null, payable ? JSON.stringify(payable) : null],
      );
      await this.record(db, user, id, 'APPROVE', dto.comment);
      await appendAuditEntry(db, {
        orgId: user.orgId, actorId: user.id, action: 'TIMESHEET_APPROVED', entityType: 'TIMESHEET', entityId: id,
        after: { ownerId: row.user_id, period: `${row.period_start}..${row.period_end}`, loggedMinutes: row.logged_minutes, amount: payable?.amount ?? null, currency: payable?.currency ?? null },
      });
      pending.push({ name: 'timesheet.approved', payload: this.base(user, row) });
      return await this.build(db, user, await this.load(db, user, id), settings);
    });
    this.flush(pending);
    return out;
  }

  async reject(user: AuthenticatedUser, id: string, dto: RejectTimesheetDto): Promise<TimesheetDetail> {
    const pending: PendingEvent[] = [];
    const out = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const settings = await orgSettings(db, user.orgId);
      const row = await this.load(db, user, id, true);
      this.assertCanApprove(user, row);
      this.assertVersion(row, dto.version);
      await db.query(
        `UPDATE timesheets SET status = 'REJECTED', rejected_by = $2, rejected_at = now(), rejection_reason = $3, version = version + 1, updated_at = now() WHERE id = $1`,
        [id, user.id, dto.comment],
      );
      await this.record(db, user, id, 'REJECT', dto.comment);
      await appendAuditEntry(db, {
        orgId: user.orgId, actorId: user.id, action: 'TIMESHEET_REJECTED', entityType: 'TIMESHEET', entityId: id,
        after: { ownerId: row.user_id, period: `${row.period_start}..${row.period_end}` },
      });
      pending.push({ name: 'timesheet.rejected', payload: { ...this.base(user, row), comment: dto.comment } });
      return await this.build(db, user, await this.load(db, user, id), settings);
    });
    this.flush(pending);
    return out;
  }

  /** FR-TS-011: only timesheet.reopen, always with a reason, always audited. */
  async reopen(user: AuthenticatedUser, id: string, dto: ReopenTimesheetDto): Promise<TimesheetDetail> {
    const pending: PendingEvent[] = [];
    const out = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const settings = await orgSettings(db, user.orgId);
      const row = await this.load(db, user, id, true);
      const p = this.perms(user, row);
      if (!p.canReopen) {
        throw row.status !== 'APPROVED' ? new ConflictException('Only an approved timesheet can be reopened') : new ForbiddenException('Reopening needs the timesheet.reopen permission');
      }
      await db.query(
        `UPDATE timesheets SET status = 'DRAFT', reopened_by = $2, reopened_at = now(), reopen_reason = $3,
           approved_by = NULL, approved_at = NULL, amount = NULL, currency = NULL, payable = NULL,
           version = version + 1, updated_at = now() WHERE id = $1`,
        [id, user.id, dto.reason],
      );
      await this.record(db, user, id, 'REOPEN', dto.reason);
      await appendAuditEntry(db, {
        orgId: user.orgId, actorId: user.id, action: 'TIMESHEET_REOPENED', entityType: 'TIMESHEET', entityId: id,
        before: { status: row.status, amount: row.amount, currency: row.currency, approvedBy: row.approved_by },
        after: { status: 'DRAFT', reason: dto.reason },
      });
      pending.push({ name: 'timesheet.reopened', payload: { ...this.base(user, row), reason: dto.reason } });
      return await this.build(db, user, await this.load(db, user, id), settings);
    });
    this.flush(pending);
    return out;
  }

  // ---------------------------------------------------------------- payable (FR-TS-009)

  /**
   * Payable amount for a subcontractor with a rate profile; null otherwise. `final` marks a
   * figure stored at approval rather than a live estimate.
   */
  async computePayable(db: Db, orgId: string, row: { user_id: string; period_start: string; period_end: string }, final: boolean): Promise<Payable | null> {
    const prof = await db.query<{ rate_type: RateType; rate: string; currency: string; overtime_multiplier: string; weekly_hours_cap: string | null }>(
      `SELECT p.rate_type, p.rate::text, p.currency, p.overtime_multiplier::text, p.weekly_hours_cap::text
       FROM subcontractor_profiles p JOIN users u ON u.id = p.user_id
       WHERE p.user_id = $1 AND u.role = 'SUBCONTRACTOR'`,
      [row.user_id],
    );
    const profile = prof.rows[0];
    if (!profile) return null;
    const overrides = await db.query<{ project_id: string; rate_override: string }>(
      `SELECT project_id, rate_override::text FROM project_members WHERE user_id = $1 AND rate_override IS NOT NULL`,
      [row.user_id],
    );
    const range = payableEntryRange(row.period_start, row.period_end);
    const entries = await db.query<{ id: string; work_date: string; started_at: Date | null; project_id: string | null; minutes: number }>(
      `SELECT id, to_char(work_date, 'YYYY-MM-DD') AS work_date, started_at, project_id, minutes FROM time_entries
       WHERE user_id = $1 AND work_date BETWEEN $2::date AND $3::date AND ended_at IS NOT NULL`,
      [row.user_id, range.from, range.to],
    );
    const capMinutes = profile.weekly_hours_cap
      ? Number((parseMoney(profile.weekly_hours_cap) * 60n) / 100n)
      : capacityFromSchedule(await this.planning.scheduleDays(db, orgId, row.user_id, row.period_start));
    const result = computePayable({
      rateType: profile.rate_type,
      rate: profile.rate,
      overtimeMultiplier: profile.overtime_multiplier,
      weeklyCapMinutes: capMinutes,
      projectRates: new Map(overrides.rows.map((o) => [o.project_id, o.rate_override])),
      periodStart: row.period_start,
      periodEnd: row.period_end,
      entries: entries.rows.map((e) => ({ id: e.id, workDate: e.work_date, startedAt: e.started_at, projectId: e.project_id, minutes: e.minutes })),
    });
    const ids = result.lines.map((l) => l.projectId).filter((x): x is string => x !== null);
    const names = ids.length
      ? new Map((await db.query<{ id: string; name: string }>(`SELECT id, name FROM projects WHERE id = ANY($1::uuid[])`, [ids])).rows.map((p) => [p.id, p.name]))
      : new Map<string, string>();
    return {
      rateType: profile.rate_type,
      currency: profile.currency,
      amount: result.amount,
      regularMinutes: result.regularMinutes,
      overtimeMinutes: result.overtimeMinutes,
      days: result.days,
      lines: result.lines.map((l) => ({ ...l, projectName: l.projectId ? (names.get(l.projectId) ?? null) : null })),
      final,
    };
  }

  // ---------------------------------------------------------------- helpers

  private async load(db: Db, user: AuthenticatedUser, id: string, forUpdate = false): Promise<SheetRow> {
    const res = await db.query<SheetRow>(`${SUMMARY_SELECT} WHERE t.id = $1 ${forUpdate ? 'FOR UPDATE OF t' : ''}`, [id]);
    const row = res.rows[0];
    // Invisible and missing look the same (no probing of other people's timesheets).
    if (!row || !this.perms(user, row).canView) throw new NotFoundException('Timesheet not found');
    return row;
  }

  private perms(user: AuthenticatedUser, row: SheetRow) {
    return timesheetPermissions(actorOf(user), { ownerId: row.user_id, ownerManagerId: row.manager_id, ownerTeamId: row.team_id, status: row.status });
  }

  private assertCanApprove(user: AuthenticatedUser, row: SheetRow): void {
    if (row.user_id === user.id) throw new ForbiddenException('Nobody approves their own timesheet');
    const p = this.perms(user, row);
    if (p.canApprove) return;
    if (row.status !== 'SUBMITTED') throw new ConflictException(`A ${row.status.toLowerCase()} timesheet cannot be approved or rejected`);
    throw new ForbiddenException('You do not approve this person\'s timesheets');
  }

  private assertVersion(row: SheetRow, version: number): void {
    if (row.version !== version) throw new ConflictException('This timesheet changed since you opened it; reload and try again');
  }

  private async record(db: Db, user: AuthenticatedUser, id: string, action: ApprovalEvent['action'], comment: string): Promise<void> {
    await db.query(`INSERT INTO timesheet_approvals (org_id, timesheet_id, actor_id, action, comment) VALUES ($1, $2, $3, $4, $5)`, [user.orgId, id, user.id, action, comment]);
  }

  private base(user: AuthenticatedUser, row: SheetRow) {
    return { orgId: user.orgId, timesheetId: row.id, ownerId: row.user_id, periodStart: row.period_start, periodEnd: row.period_end, actorId: user.id };
  }

  private flush(events: PendingEvent[]): void {
    for (const e of events) this.events.emit(e.name, e.payload as never);
  }

  private async build(db: Db, user: AuthenticatedUser, row: SheetRow, settings: OrgTimesheetSettings): Promise<TimesheetDetail> {
    const dayRows = await db.query<{ date: string; attendance_minutes: number; logged_minutes: number; manual_minutes: number; variance_minutes: number; variance_pct: number | null; flags: TimesheetDay['flags'] }>(
      `SELECT to_char(work_date, 'YYYY-MM-DD') AS date, attendance_minutes, logged_minutes, manual_minutes, variance_minutes, variance_pct, flags
       FROM timesheet_days WHERE timesheet_id = $1`,
      [row.id],
    );
    const byDate = new Map(dayRows.rows.map((d) => [d.date, d]));
    const days: TimesheetDay[] = datesBetween(row.period_start, row.period_end).map((date) => {
      const d = byDate.get(date);
      return {
        date,
        attendanceMinutes: d?.attendance_minutes ?? 0,
        loggedMinutes: d?.logged_minutes ?? 0,
        manualMinutes: d?.manual_minutes ?? 0,
        varianceMinutes: d?.variance_minutes ?? 0,
        variancePct: d?.variance_pct ?? null,
        flags: d?.flags ?? [],
      };
    });
    const approvals = await db.query<{ id: string; action: ApprovalEvent['action']; comment: string; created_at: Date; actor_id: string; display_name: string | null; email: string; role: string }>(
      `SELECT a.id, a.action, a.comment, a.created_at, a.actor_id, u.display_name, u.email, u.role
       FROM timesheet_approvals a JOIN users u ON u.id = a.actor_id WHERE a.timesheet_id = $1 ORDER BY a.created_at, a.id`,
      [row.id],
    );
    const stored = row.status === 'APPROVED' || row.status === 'LOCKED' || row.status === 'PAID';
    let payable: Payable | null = stored ? row.payable : null;
    let payableNote: string | null = null;
    if (!stored) {
      try {
        payable = await this.computePayable(db, user.orgId, row, false);
      } catch {
        payableNote = 'The amount could not be calculated (too large for a timesheet).';
      }
    }
    if (!payable && !payableNote) {
      payableNote = row.role === 'SUBCONTRACTOR' ? 'No rate profile yet: HR sets rates on the Rates page.' : 'Payable amounts apply to subcontractors only.';
    }
    const approvedBy: UserRef | null = row.approved_by && row.ap_email ? userRef(row.approved_by, row.ap_name, row.ap_email, row.ap_role) : null;
    return {
      ...mapSummary(row),
      notes: row.notes,
      rejectionReason: row.rejection_reason,
      reopenReason: row.reopen_reason,
      approvedBy,
      submitDueDate: addDaysIso(row.period_end, settings.submitDueDays),
      days,
      entries: await this.entries.entriesOf(db, row.id, user.id),
      approvals: approvals.rows.map((a) => ({ id: a.id, action: a.action, comment: a.comment, createdAt: toIso(a.created_at)!, actor: userRef(a.actor_id, a.display_name, a.email, a.role) })),
      payable,
      payableNote,
      permissions: this.perms(user, row),
      settings: { variancePct: settings.variancePct, manualLimitMinutes: settings.manualLimitMinutes },
    };
  }
}

/**
 * Who approves `ownerId`'s timesheets (FR-TS-006, 012): their manager; else the leads and
 * managers of their team; else HR.
 */
export async function approversFor(db: Db, ownerId: string): Promise<string[]> {
  const res = await db.query<{ id: string }>(
    `WITH o AS (SELECT id, manager_id, team_id FROM users WHERE id = $1)
     SELECT m.id FROM o JOIN users m ON m.id = o.manager_id AND m.status = 'ACTIVE'
     UNION
     SELECT u.id FROM o JOIN users u ON o.manager_id IS NULL AND u.team_id = o.team_id AND u.id <> o.id
       AND u.role IN ('TEAM_LEAD', 'MANAGER') AND u.status = 'ACTIVE'`,
    [ownerId],
  );
  if (res.rows.length > 0) return res.rows.map((r) => r.id);
  const hr = await db.query<{ id: string }>(`SELECT id FROM users WHERE role IN ('HR', 'HR_MANAGER') AND status = 'ACTIVE' AND id <> $1`, [ownerId]);
  return hr.rows.map((r) => r.id);
}

export function ensureRange(from: string, to: string, maxDays: number): void {
  if (to < from) throw new BadRequestException('"to" is before "from"');
  if (addDaysIso(from, maxDays) < to) throw new BadRequestException(`At most ${maxDays} days at a time`);
}
