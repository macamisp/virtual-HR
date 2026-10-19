import { Injectable } from '@nestjs/common';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import type { Cell } from '../common/export-format.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import type {
  AttendanceReport,
  AttendanceReportQuery,
  AttendanceReportRow,
  CostReport,
  CostReportQuery,
  CostReportRow,
  TaskReport,
  TaskReportQuery,
  TaskReportRow,
} from '../../../../packages/shared/src/reports/types.ts';
import { ensureRange, exportTable, hours, personLabel, reportScope, scopeSql, USER_REF_SELECT, userRef } from './report-scope.ts';
import type { ExportFile, Scope } from './report-scope.ts';
import { orgToday } from './report-scope.ts';

const MAX_DAYS = 366;
const APPROVED = ['APPROVED', 'LOCKED', 'PAID'];

/** Exact money as integer cents; amounts are "123.45" text from the database. */
function toCents(amount: string): bigint {
  const neg = amount.startsWith('-');
  const [whole = '0', frac = ''] = amount.replace('-', '').split('.');
  const cents = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  return neg ? -cents : cents;
}
function fromCents(c: bigint): string {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

interface AttendanceAgg {
  key: string;
  label: string;
  people: number;
  days_present: number;
  days_late: number;
  late_minutes: number;
  days_early: number;
  early_minutes: number;
  days_absent: number;
  days_leave: number;
  net_seconds: string;
  expected_seconds: string;
  overtime_minutes: string;
}

function attendanceRow(r: AttendanceAgg): AttendanceReportRow {
  return {
    key: r.key, label: r.label, people: Number(r.people),
    daysPresent: Number(r.days_present), daysLate: Number(r.days_late), lateMinutes: Number(r.late_minutes),
    daysEarlyLeave: Number(r.days_early), earlyLeaveMinutes: Number(r.early_minutes),
    daysAbsent: Number(r.days_absent), daysOnLeave: Number(r.days_leave),
    netMinutes: Math.round(Number(r.net_seconds) / 60), expectedMinutes: Math.round(Number(r.expected_seconds) / 60), overtimeMinutes: Number(r.overtime_minutes),
  };
}

/** FR-REP-002 attendance, FR-REP-003 hours and cost, FR-REP-004 tasks and workload; all within FR-REP-008 scope. */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- FR-REP-002

  async attendance(user: AuthenticatedUser, q: AttendanceReportQuery): Promise<AttendanceReport> {
    ensureRange(q.from, q.to, MAX_DAYS);
    const scope = reportScope(user);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const { rows, totals } = await this.attendanceRows(db, user, scope, q);
      return { groupBy: q.groupBy, from: q.from, to: q.to, scope, rows, totals };
    });
  }

  private async attendanceRows(db: pg.PoolClient, user: AuthenticatedUser, scope: Scope, q: AttendanceReportQuery): Promise<{ rows: AttendanceReportRow[]; totals: AttendanceReportRow }> {
    const params: unknown[] = [user.orgId];
    const where = `${scopeSql(user, scope, params, { teamId: q.teamId, userId: q.userId })} AND d.work_date BETWEEN $${params.push(q.from)} AND $${params.push(q.to)}`;
    const key = {
      user: `u.id::text`,
      team: `COALESCE(u.team_id::text, 'none')`,
      day: `d.work_date`,
      week: `to_char(date_trunc('week', d.work_date::date), 'YYYY-MM-DD')`,
      month: `substr(d.work_date, 1, 7)`,
    }[q.groupBy];
    const label = {
      user: `min(COALESCE(u.display_name, u.email))`,
      team: `min(COALESCE(t.name, 'No team'))`,
      day: `min(d.work_date)`,
      week: `'Week of ' || min(to_char(date_trunc('week', d.work_date::date), 'YYYY-MM-DD'))`,
      month: `min(substr(d.work_date, 1, 7))`,
    }[q.groupBy];
    const agg = `
      count(DISTINCT d.user_id)::int AS people,
      count(*) FILTER (WHERE d.day_status IN ('PRESENT', 'LATE', 'EARLY_LEAVE', 'HALF_DAY'))::int AS days_present,
      count(*) FILTER (WHERE d.late_minutes > 0)::int AS days_late, COALESCE(sum(d.late_minutes), 0)::int AS late_minutes,
      count(*) FILTER (WHERE d.early_leave_minutes > 0)::int AS days_early, COALESCE(sum(d.early_leave_minutes), 0)::int AS early_minutes,
      count(*) FILTER (WHERE d.day_status = 'ABSENT')::int AS days_absent,
      count(*) FILTER (WHERE d.day_status = 'LEAVE')::int AS days_leave,
      COALESCE(sum(d.net_seconds), 0)::text AS net_seconds, COALESCE(sum(d.expected_seconds), 0)::text AS expected_seconds,
      COALESCE(sum(d.overtime_minutes), 0)::text AS overtime_minutes`;
    const from = `FROM attendance_daily d JOIN users u ON u.id = d.user_id LEFT JOIN teams t ON t.id = u.team_id WHERE d.org_id = $1 AND ${where}`;
    const grouped = await db.query<AttendanceAgg>(`SELECT ${key} AS key, ${label} AS label, ${agg} ${from} GROUP BY 1 ORDER BY 2`, params);
    const total = await db.query<AttendanceAgg>(`SELECT 'total' AS key, 'Total' AS label, ${agg} ${from}`, params);
    return { rows: grouped.rows.map(attendanceRow), totals: attendanceRow(total.rows[0]!) };
  }

  async exportAttendance(user: AuthenticatedUser, q: AttendanceReportQuery & { format: 'csv' | 'xlsx' | 'pdf' }): Promise<ExportFile> {
    const r = await this.attendance(user, q);
    const header = [{ user: 'Person', team: 'Team', day: 'Day', week: 'Week', month: 'Month' }[q.groupBy], 'People', 'Days present', 'Days late', 'Late (min)', 'Early leaves', 'Early (min)', 'Absent', 'On leave', 'Net (h)', 'Expected (h)', 'Overtime (min)'];
    const line = (x: AttendanceReportRow): Cell[] => [x.label, x.people, x.daysPresent, x.daysLate, x.lateMinutes, x.daysEarlyLeave, x.earlyLeaveMinutes, x.daysAbsent, x.daysOnLeave, hours(x.netMinutes), hours(x.expectedMinutes), x.overtimeMinutes];
    return await this.prisma.runWithTenantContext(user.orgId, (db) => exportTable(db, user, {
      report: `attendance-by-${q.groupBy}`, title: 'Attendance report', subtitle: `${q.from} to ${q.to} · by ${q.groupBy} · ${r.scope === 'all' ? 'whole organisation' : 'my team'}`,
      header, rows: [...r.rows.map(line), line(r.totals)], format: q.format, filters: { groupBy: q.groupBy, from: q.from, to: q.to, teamId: q.teamId ?? null, userId: q.userId ?? null },
    }));
  }

  // ---------------------------------------------------------------- FR-REP-003

  /**
   * Hours come from time entries in the range. Cost comes from the payable stored on approved
   * timesheets whose period overlaps the range (counted in full), per currency, never summed
   * across currencies. Projects use the payable's per-project lines.
   */
  async cost(user: AuthenticatedUser, q: CostReportQuery): Promise<CostReport> {
    ensureRange(q.from, q.to, MAX_DAYS);
    const scope = reportScope(user);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const params: unknown[] = [user.orgId];
      const who = scopeSql(user, scope, params, { teamId: q.teamId, userId: q.userId });
      const fromIdx = params.push(q.from);
      const toIdx = params.push(q.to);
      const projIdx = q.projectId ? params.push(q.projectId) : null;
      const key = { user: `u.id::text`, project: `COALESCE(e.project_id::text, 'none')`, month: `to_char(e.work_date, 'YYYY-MM')` }[q.groupBy];
      const label = { user: `min(COALESCE(u.display_name, u.email))`, project: `min(COALESCE(pr.name, 'No project'))`, month: `min(to_char(e.work_date, 'YYYY-MM'))` }[q.groupBy];
      const entries = await db.query<{ key: string; label: string; people: number; logged: number; billable: number; approved: number }>(
        `SELECT ${key} AS key, ${label} AS label, count(DISTINCT e.user_id)::int AS people,
                COALESCE(sum(e.minutes), 0)::int AS logged,
                COALESCE(sum(e.minutes) FILTER (WHERE e.billable), 0)::int AS billable,
                COALESCE(sum(e.minutes) FILTER (WHERE ts.status = ANY('{${APPROVED.join(',')}}')), 0)::int AS approved
         FROM time_entries e JOIN timesheets ts ON ts.id = e.timesheet_id JOIN users u ON u.id = e.user_id
         LEFT JOIN teams t ON t.id = u.team_id LEFT JOIN projects pr ON pr.id = e.project_id
         WHERE e.org_id = $1 AND ${who} AND e.work_date BETWEEN $${fromIdx}::date AND $${toIdx}::date AND e.ended_at IS NOT NULL
           ${projIdx ? `AND e.project_id = $${projIdx}` : ''}
         GROUP BY 1 ORDER BY 2`,
        params,
      );
      const sheets = await db.query<{ user_id: string; month: string; currency: string | null; payable: { lines?: Array<{ projectId: string | null; amount: string }>; amount?: string } | null }>(
        `SELECT ts.user_id, to_char(ts.period_start, 'YYYY-MM') AS month, ts.currency, ts.payable
         FROM timesheets ts JOIN users u ON u.id = ts.user_id
         WHERE ts.org_id = $1 AND ${who} AND ts.status = ANY('{${APPROVED.join(',')}}') AND ts.payable IS NOT NULL
           AND ts.period_start <= $${toIdx}::date AND ts.period_end >= $${fromIdx}::date`,
        params,
      );
      const cost = new Map<string, Map<string, bigint>>();
      const add = (k: string, currency: string, amount: string) => {
        const m = cost.get(k) ?? new Map<string, bigint>();
        m.set(currency, (m.get(currency) ?? 0n) + toCents(amount));
        cost.set(k, m);
      };
      for (const s of sheets.rows) {
        if (!s.currency || !s.payable) continue;
        const lines = s.payable.lines ?? [];
        if (q.groupBy === 'project') {
          for (const l of lines) if (!q.projectId || l.projectId === q.projectId) add(l.projectId ?? 'none', s.currency, l.amount);
        } else {
          const amount = q.projectId ? lines.filter((l) => l.projectId === q.projectId).reduce((a, l) => a + toCents(l.amount), 0n) : toCents(s.payable.amount ?? '0');
          if (amount !== 0n) add(q.groupBy === 'user' ? s.user_id : s.month, s.currency, fromCents(amount));
        }
      }
      const rows: CostReportRow[] = entries.rows.map((r) => ({
        key: r.key, label: r.label, people: r.people, loggedMinutes: r.logged, billableMinutes: r.billable, approvedMinutes: r.approved,
        cost: Object.fromEntries([...(cost.get(r.key) ?? new Map()).entries()].map(([c, v]) => [c, fromCents(v)])),
      }));
      // Groups with approved cost but no entries in the range (period overlap) still show their cost.
      for (const [k, m] of cost) {
        if (!rows.some((r) => r.key === k)) rows.push({ key: k, label: k === 'none' ? 'No project' : k, people: 0, loggedMinutes: 0, billableMinutes: 0, approvedMinutes: 0, cost: Object.fromEntries([...m.entries()].map(([c, v]) => [c, fromCents(v)])) });
      }
      if (q.groupBy === 'user') {
        const names = await db.query<{ id: string; label: string }>(`SELECT id, COALESCE(display_name, email) AS label FROM users WHERE id = ANY($1::uuid[])`, [rows.filter((r) => r.label === r.key).map((r) => r.key)]);
        for (const n of names.rows) { const row = rows.find((r) => r.key === n.id); if (row) row.label = n.label; }
      }
      rows.sort((a, b) => a.label.localeCompare(b.label));
      return { groupBy: q.groupBy, from: q.from, to: q.to, scope, rows };
    });
  }

  async exportCost(user: AuthenticatedUser, q: CostReportQuery & { format: 'csv' | 'xlsx' | 'pdf' }): Promise<ExportFile> {
    const r = await this.cost(user, q);
    const currencies = [...new Set(r.rows.flatMap((x) => Object.keys(x.cost)))].sort();
    const header = [{ user: 'Person', project: 'Project', month: 'Month' }[q.groupBy], 'People', 'Logged (h)', 'Billable (h)', 'Approved (h)', ...currencies.map((c) => `Cost ${c}`)];
    const rows: Cell[][] = r.rows.map((x) => [x.label, x.people, hours(x.loggedMinutes), hours(x.billableMinutes), hours(x.approvedMinutes), ...currencies.map((c) => (x.cost[c] !== undefined ? Number(x.cost[c]) : null))]);
    return await this.prisma.runWithTenantContext(user.orgId, (db) => exportTable(db, user, {
      report: `hours-cost-by-${q.groupBy}`, title: 'Hours and cost report', subtitle: `${q.from} to ${q.to} · by ${q.groupBy} · approved cost per currency`,
      header, rows, format: q.format, filters: { groupBy: q.groupBy, from: q.from, to: q.to, teamId: q.teamId ?? null, userId: q.userId ?? null, projectId: q.projectId ?? null },
    }));
  }

  // ---------------------------------------------------------------- FR-REP-004

  /** `today` defaults to the organisation's local date: "overdue" is a local-calendar fact, not a UTC one. */
  async tasks(user: AuthenticatedUser, q: TaskReportQuery, todayOverride?: string): Promise<TaskReport> {
    ensureRange(q.from, q.to, MAX_DAYS);
    const scope = reportScope(user);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const today = todayOverride ?? await orgToday(db, user.orgId);
      const params: unknown[] = [user.orgId];
      const who = scopeSql(user, scope, params, { teamId: q.teamId, userId: q.userId });
      const fromIdx = params.push(q.from);
      const toIdx = params.push(q.to);
      const todayIdx = params.push(today);
      const projIdx = q.projectId ? params.push(q.projectId) : null;
      const res = await db.query<{ user_id: string; display_name: string | null; email: string; team_name: string | null; open: number; in_progress: number; blocked: number; completed: number; on_time: number; overdue: number; remaining: number; estimate: number; actual: number }>(
        `SELECT ${USER_REF_SELECT()},
                count(tk.id) FILTER (WHERE tk.status <> 'DONE')::int AS open,
                count(tk.id) FILTER (WHERE tk.status = 'IN_PROGRESS')::int AS in_progress,
                count(tk.id) FILTER (WHERE tk.status = 'BLOCKED')::int AS blocked,
                count(tk.id) FILTER (WHERE tk.status = 'DONE' AND tk.completed_at::date BETWEEN $${fromIdx}::date AND $${toIdx}::date)::int AS completed,
                count(tk.id) FILTER (WHERE tk.status = 'DONE' AND tk.completed_at::date BETWEEN $${fromIdx}::date AND $${toIdx}::date AND (tk.due_date IS NULL OR tk.completed_at::date <= tk.due_date))::int AS on_time,
                count(tk.id) FILTER (WHERE tk.status <> 'DONE' AND tk.due_date < $${todayIdx}::date)::int AS overdue,
                COALESCE(sum(tk.estimate_minutes) FILTER (WHERE tk.status <> 'DONE'), 0)::int AS remaining,
                COALESCE(sum(tk.estimate_minutes) FILTER (WHERE tk.status = 'DONE' AND tk.completed_at::date BETWEEN $${fromIdx}::date AND $${toIdx}::date), 0)::int AS estimate,
                COALESCE(sum(tk.actual_minutes) FILTER (WHERE tk.status = 'DONE' AND tk.completed_at::date BETWEEN $${fromIdx}::date AND $${toIdx}::date), 0)::int AS actual
         FROM users u LEFT JOIN teams t ON t.id = u.team_id
         LEFT JOIN tasks tk ON tk.assignee_id = u.id AND tk.deleted_at IS NULL ${projIdx ? `AND tk.project_id = $${projIdx}` : ''}
         WHERE u.status = 'ACTIVE' AND ${who}
         GROUP BY u.id, u.display_name, u.email, t.name
         ORDER BY COALESCE(u.display_name, u.email)`,
        params,
      );
      const avg = res.rows.length ? res.rows.reduce((a, r) => a + r.remaining, 0) / res.rows.length : 0;
      const rows: TaskReportRow[] = res.rows.map((r) => ({
        user: userRef(r), open: r.open, inProgress: r.in_progress, blocked: r.blocked, completed: r.completed, completedOnTime: r.on_time, overdue: r.overdue,
        remainingEstimateMinutes: r.remaining, estimateMinutes: r.estimate, actualMinutes: r.actual,
        loadIndex: avg > 0 ? Math.round((r.remaining / avg) * 100) / 100 : 0,
      }));
      return { from: q.from, to: q.to, scope, rows, averageRemainingEstimateMinutes: Math.round(avg) };
    });
  }

  async exportTasks(user: AuthenticatedUser, q: TaskReportQuery & { format: 'csv' | 'xlsx' | 'pdf' }): Promise<ExportFile> {
    const r = await this.tasks(user, q);
    const header = ['Person', 'Team', 'Open', 'In progress', 'Blocked', 'Completed', 'On time', 'Overdue', 'Remaining estimate (h)', 'Estimate (h)', 'Actual (h)', 'Load index'];
    const rows: Cell[][] = r.rows.map((x) => [personLabel({ display_name: x.user.displayName, email: x.user.email }), x.user.teamName, x.open, x.inProgress, x.blocked, x.completed, x.completedOnTime, x.overdue, hours(x.remainingEstimateMinutes), hours(x.estimateMinutes), hours(x.actualMinutes), x.loadIndex]);
    return await this.prisma.runWithTenantContext(user.orgId, (db) => exportTable(db, user, {
      report: 'tasks-workload', title: 'Tasks and workload report', subtitle: `${q.from} to ${q.to} · load index 1.0 = average remaining estimate`,
      header, rows, format: q.format, filters: { from: q.from, to: q.to, teamId: q.teamId ?? null, userId: q.userId ?? null, projectId: q.projectId ?? null },
    }));
  }
}
