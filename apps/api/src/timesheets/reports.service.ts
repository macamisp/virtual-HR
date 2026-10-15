import { ForbiddenException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { toCsv, toXlsx } from '../common/export-format.ts';
import type { Cell } from '../common/export-format.ts';
import { Permission, userCan } from '../../../../packages/shared/src/auth/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import type { Payable, ReportRow, TimesheetReport, TimesheetReportQuery, TimesheetStatus } from '../../../../packages/shared/src/timesheets/types.ts';
import { formatMoney, parseAmount } from './money.ts';
import { ensureRange } from './timesheets.service.ts';
import { visibleOwnersSql } from './timesheets.sql.ts';

const MAX_REPORT_DAYS = 366;
const APPROVED: readonly TimesheetStatus[] = ['APPROVED', 'LOCKED', 'PAID'];

interface SheetFact {
  id: string;
  user_id: string;
  display_name: string | null;
  email: string;
  team_id: string | null;
  team_name: string | null;
  period_start: string;
  period_end: string;
  status: TimesheetStatus;
  attendance_minutes: number;
  logged_minutes: number;
  variance_minutes: number;
  flagged_days: number;
  amount: string | null;
  currency: string | null;
  payable: Payable | null;
  approval_hours: string | null;
}

interface Acc {
  key: string;
  label: string;
  sheets: Set<string>;
  attendance: number;
  logged: number;
  approved: number;
  variance: number;
  flagged: number;
  cost: Map<string, bigint>;
  approvalHours: number[];
}

function acc(key: string, label: string): Acc {
  return { key, label, sheets: new Set(), attendance: 0, logged: 0, approved: 0, variance: 0, flagged: 0, cost: new Map(), approvalHours: [] };
}

function addCost(a: Acc, currency: string | null, amount: string | null): void {
  if (!currency || amount === null) return;
  a.cost.set(currency, (a.cost.get(currency) ?? 0n) + parseAmount(amount));
}

const hours = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;

/**
 * FR-TS-013 reports by subcontractor (person), project, team and period: hours, approved
 * hours, variance, cost and approval turnaround. Timesheets whose period overlaps the range
 * count in full. Cost is approved amounts only, kept per currency (never summed across).
 */
@Injectable()
export class TimesheetReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async report(user: AuthenticatedUser, q: TimesheetReportQuery): Promise<TimesheetReport> {
    ensureRange(q.from, q.to, MAX_REPORT_DAYS);
    const seesAll = userCan(user, Permission.TIMESHEETS_READ_ALL) || userCan(user, Permission.TIMESHEETS_APPROVE_ALL);
    if (!seesAll && !userCan(user, Permission.TIMESHEETS_APPROVE_TEAM)) throw new ForbiddenException('Reports need approval or read-all access');

    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const params: unknown[] = [user.orgId, q.from, q.to];
      const where = [`t.org_id = $1`, `t.period_start <= $3::date`, `t.period_end >= $2::date`, visibleOwnersSql(user, params, seesAll ? 'all' : 'team')];
      if (q.userId) {
        params.push(q.userId);
        where.push(`t.user_id = $${params.length}`);
      }
      if (q.teamId) {
        params.push(q.teamId);
        where.push(`u.team_id = $${params.length}`);
      }
      if (q.projectId) {
        params.push(q.projectId);
        where.push(`EXISTS (SELECT 1 FROM time_entries pe WHERE pe.timesheet_id = t.id AND pe.project_id = $${params.length})`);
      }
      const sheets = await db.query<SheetFact>(
        `SELECT t.id, t.user_id, u.display_name, u.email, u.team_id, tm.name AS team_name,
                to_char(t.period_start, 'YYYY-MM-DD') AS period_start, to_char(t.period_end, 'YYYY-MM-DD') AS period_end,
                t.status, t.attendance_minutes, t.logged_minutes, t.variance_minutes, t.flagged_days,
                t.amount::text AS amount, t.currency, t.payable,
                (EXTRACT(EPOCH FROM (t.approved_at - t.submitted_at)) / 3600)::numeric(10,2)::text AS approval_hours
         FROM timesheets t JOIN users u ON u.id = t.user_id LEFT JOIN teams tm ON tm.id = u.team_id
         WHERE ${where.join(' AND ')}`,
        params,
      );

      const groups = new Map<string, Acc>();
      const group = (key: string, label: string): Acc => {
        let a = groups.get(key);
        if (!a) groups.set(key, (a = acc(key, label)));
        return a;
      };
      const approvedOf = (s: SheetFact) => APPROVED.includes(s.status);

      if (q.groupBy === 'project') {
        const ids = sheets.rows.map((s) => s.id);
        const byId = new Map(sheets.rows.map((s) => [s.id, s]));
        const lines = ids.length
          ? await db.query<{ timesheet_id: string; project_id: string | null; project_name: string | null; minutes: number }>(
              `SELECT e.timesheet_id, e.project_id, p.name AS project_name, SUM(e.minutes)::int AS minutes
               FROM time_entries e LEFT JOIN projects p ON p.id = e.project_id
               WHERE e.timesheet_id = ANY($1::uuid[]) AND e.ended_at IS NOT NULL ${q.projectId ? 'AND e.project_id = $2' : ''}
               GROUP BY e.timesheet_id, e.project_id, p.name`,
              q.projectId ? [ids, q.projectId] : [ids],
            )
          : { rows: [] };
        for (const l of lines.rows) {
          const s = byId.get(l.timesheet_id)!;
          const a = group(l.project_id ?? 'none', l.project_name ?? 'No project');
          a.sheets.add(s.id);
          a.logged += l.minutes;
          if (approvedOf(s)) {
            a.approved += l.minutes;
            const line = s.payable?.lines.find((x) => x.projectId === l.project_id);
            if (s.payable && line) addCost(a, s.payable.currency, line.amount);
            // One line per (timesheet, project), so each approved timesheet counts once here.
            if (s.approval_hours !== null) a.approvalHours.push(Number(s.approval_hours));
          }
        }
      } else {
        for (const s of sheets.rows) {
          const a =
            q.groupBy === 'user' ? group(s.user_id, s.display_name ?? s.email)
            : q.groupBy === 'team' ? group(s.team_id ?? 'none', s.team_name ?? 'No team')
            : group(s.period_start, `${s.period_start} – ${s.period_end}`);
          a.sheets.add(s.id);
          a.attendance += s.attendance_minutes;
          a.logged += s.logged_minutes;
          a.variance += s.variance_minutes;
          a.flagged += s.flagged_days;
          if (approvedOf(s)) {
            a.approved += s.logged_minutes;
            addCost(a, s.currency, s.amount);
            if (s.approval_hours !== null) a.approvalHours.push(Number(s.approval_hours));
          }
        }
      }

      const rows: ReportRow[] = [...groups.values()]
        .sort((x, y) => (q.groupBy === 'period' ? x.key.localeCompare(y.key) : x.label.localeCompare(y.label)))
        .map((a) => ({
          key: a.key,
          label: a.label,
          timesheets: a.sheets.size,
          attendanceMinutes: a.attendance,
          loggedMinutes: a.logged,
          approvedMinutes: a.approved,
          varianceMinutes: a.variance,
          flaggedDays: a.flagged,
          cost: Object.fromEntries([...a.cost.entries()].sort().map(([c, v]) => [c, formatMoney(v)])),
          avgApprovalHours: a.approvalHours.length ? Math.round((a.approvalHours.reduce((x, y) => x + y, 0) / a.approvalHours.length) * 10) / 10 : null,
        }));
      return { groupBy: q.groupBy, from: q.from, to: q.to, rows };
    });
  }

  /** CSV or XLSX of the same report; formula-injection safe; every export is audited. */
  async export(user: AuthenticatedUser, q: TimesheetReportQuery): Promise<{ body: Buffer | string; contentType: string; filename: string }> {
    const r = await this.report(user, q);
    const currencies = [...new Set(r.rows.flatMap((row) => Object.keys(row.cost)))].sort();
    const header = [
      { user: 'Person', project: 'Project', team: 'Team', period: 'Period' }[r.groupBy],
      'Timesheets', 'Attendance (h)', 'Logged (h)', 'Approved (h)', 'Variance (h)', 'Flagged days',
      ...currencies.map((c) => `Cost ${c}`),
      'Avg approval (h)',
    ];
    const rows: Cell[][] = r.rows.map((row) => [
      row.label, row.timesheets, hours(row.attendanceMinutes), hours(row.loggedMinutes), hours(row.approvedMinutes),
      hours(row.varianceMinutes), row.flaggedDays,
      // Money is exact text until here; the spreadsheet cell is a display number.
      ...currencies.map((c) => (row.cost[c] !== undefined ? Number(row.cost[c]) : null)),
      row.avgApprovalHours,
    ]);
    const base = `timesheets-by-${r.groupBy}-${r.from}-to-${r.to}`;
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await appendAuditEntry(db, {
        orgId: user.orgId, actorId: user.id, action: 'TIMESHEET_REPORT_EXPORTED', entityType: 'EXPORT', entityId: randomUUID(),
        after: { format: q.format, groupBy: q.groupBy, from: q.from, to: q.to, teamId: q.teamId ?? null, projectId: q.projectId ?? null, userId: q.userId ?? null, rowCount: rows.length },
      });
    });
    if (q.format === 'xlsx') {
      return { body: await toXlsx('Timesheets', header, rows), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `${base}.xlsx` };
    }
    return { body: toCsv(header, rows), contentType: 'text/csv; charset=utf-8', filename: `${base}.csv` };
  }
}
