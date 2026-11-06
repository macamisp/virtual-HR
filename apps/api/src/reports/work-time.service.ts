/**
 * ADR 049 §5 (FR-WT-019..021): work-time analytics from server records only.
 *
 * - Attendance and meeting time come from attendance sessions (adjusted and cancelled ones left out).
 * - Task time comes from finished time entries (timer, manual, approved onsite).
 * - Focused task time is task time minus its overlap with the person's IN_MEETING segments, so a
 *   timer left running in a call is counted once (as "task time during meetings").
 * - Insights are planning prompts about estimates and meeting load, never ratings of people.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import type { Cell } from '../common/export-format.ts';
import { WORK_CATEGORY_LABEL, WORK_TYPE_LABEL } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser, WorkCategory, WorkType } from '../../../../packages/shared/src/index.ts';
import type { WorkTimeReport, WorkTimeReportQuery, WorkTimeTaskRow } from '../../../../packages/shared/src/reports/types.ts';
import { ensureRange, exportTable, hours, reportScope, scopeSql } from './report-scope.ts';
import type { ExportFile } from './report-scope.ts';

const MAX_DAYS = 366;
type Db = pg.PoolClient;

/** Monday of the ISO week of a YYYY-MM-DD date. */
export function weekOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

interface Trend { attendance: number; meeting: number; task: number; focused: number }
const emptyTrend = (): Trend => ({ attendance: 0, meeting: 0, task: 0, focused: 0 });
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part * 100) / whole) : 0);

/** Plain-language prompts for planning (FR-WT-021): about work and estimates, never about worth. */
export function workTimeInsights(r: Pick<WorkTimeReport, 'totals' | 'overEstimate' | 'categories'>): string[] {
  const out: string[] = [];
  const t = r.totals;
  if (t.attendanceMinutes > 0 && t.meetingMinutes > 0) {
    const share = pct(t.meetingMinutes, t.attendanceMinutes);
    out.push(share >= 40
      ? `Meetings took ${share}% of attended time. If focus time is short, consider whether some meetings could be shorter, combined or made asynchronous.`
      : `Meetings took ${share}% of attended time.`);
  }
  const unrecorded = t.attendanceMinutes - (t.taskMinutes - t.onsiteMinutes) - t.meetingMinutes;
  if (t.attendanceMinutes > 0 && unrecorded > 0 && pct(unrecorded, t.attendanceMinutes) >= 30) {
    out.push(`About ${hours(unrecorded)} h of attended time has no task or meeting recorded. Recording it against tasks makes project totals more accurate.`);
  }
  const o = r.overEstimate;
  if (o.completedTasks >= 3 && o.completedOverEstimate * 2 >= o.completedTasks) {
    out.push(`${o.completedOverEstimate} of ${o.completedTasks} completed tasks took longer than estimated. Estimates for similar work may need more time, or the tasks may need splitting.`);
  }
  if (t.taskMinutes > 0 && pct(t.manualMinutes, t.taskMinutes) >= 25) {
    out.push(`${pct(t.manualMinutes, t.taskMinutes)}% of task time was added by hand. Timers keep start and end times, which makes reports more precise.`);
  }
  if (t.taskDuringMeetingsMinutes > 0) {
    out.push(`${hours(t.taskDuringMeetingsMinutes)} h of task time ran during meetings; it is counted once, as meeting time, in the focus figures.`);
  }
  return out;
}

@Injectable()
export class WorkTimeService {
  constructor(private readonly prisma: PrismaService) {}

  /** Whose time the caller sees: themselves, one person in report scope, or everyone in scope. */
  private async people(db: Db, user: AuthenticatedUser, q: WorkTimeReportQuery): Promise<string[]> {
    if (q.scope === 'me' || (q.scope === 'person' && q.userId === user.id)) return [user.id];
    const scope = reportScope(user);
    const params: unknown[] = [user.orgId];
    const where = scopeSql(user, scope, params, q.scope === 'person' ? { userId: q.userId } : {});
    const rows = (await db.query<{ id: string }>(`SELECT u.id FROM users u WHERE ${where} AND u.status = 'ACTIVE'`, params)).rows.map((r) => r.id);
    if (q.scope === 'person' && rows.length === 0) throw new NotFoundException('Person not found');
    return rows;
  }

  async report(user: AuthenticatedUser, q: WorkTimeReportQuery): Promise<WorkTimeReport> {
    ensureRange(q.from, q.to, MAX_DAYS);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const uids = await this.people(db, user, q);
      const weekly = new Map<string, Trend>();
      const monthly = new Map<string, Trend>();
      const bump = (date: string, f: (t: Trend) => void) => {
        for (const [m, k] of [[weekly, weekOf(date)], [monthly, date.slice(0, 7)]] as const) {
          const t = m.get(k) ?? emptyTrend();
          f(t);
          m.set(k, t);
        }
      };

      // Attendance and meeting time (verified calls, ADR 049 §1) per day.
      const att = await db.query<{ work_date: string; net: string; meet: string }>(
        `SELECT work_date, SUM(net_seconds)::text AS net, SUM(meeting_seconds)::text AS meet FROM attendance_sessions
         WHERE user_id = ANY($1::uuid[]) AND work_date BETWEEN $2 AND $3 AND status NOT IN ('ADJUSTED', 'CANCELLED') GROUP BY work_date`,
        [uids, q.from, q.to]);
      let attendance = 0;
      let meeting = 0;
      for (const r of att.rows) {
        const a = Math.floor(Number(r.net) / 60);
        const m = Math.min(a, Math.floor(Number(r.meet) / 60));
        attendance += a;
        meeting += m;
        bump(r.work_date, (t) => { t.attendance += a; t.meeting += m; });
      }

      // Task time, with each timed entry's overlap with the person's meeting segments.
      const params: unknown[] = [uids, q.from, q.to];
      let projectFilter = '';
      if (q.projectId) { params.push(q.projectId); projectFilter = ` AND e.project_id = $${params.length}`; }
      const entries = await db.query<{ work_date: string; minutes: number; source: string; category: WorkCategory | null; work_type: WorkType | null;
        project_id: string | null; project_name: string | null; task_id: string | null; overlap_s: number }>(
        `SELECT to_char(e.work_date, 'YYYY-MM-DD') AS work_date, e.minutes, e.source, e.category, e.work_type, e.project_id,
                COALESCE(e.project_name, p.name) AS project_name, e.task_id,
                COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (LEAST(e.ended_at, COALESCE(s.ended_at, now())) - GREATEST(e.started_at, s.started_at))))
                          FROM attendance_segments s JOIN attendance_sessions ss ON ss.id = s.session_id
                          WHERE ss.user_id = e.user_id AND s.state = 'IN_MEETING' AND ss.status NOT IN ('ADJUSTED', 'CANCELLED')
                            AND e.started_at IS NOT NULL AND s.started_at < e.ended_at AND COALESCE(s.ended_at, now()) > e.started_at), 0)::int AS overlap_s
         FROM time_entries e LEFT JOIN projects p ON p.id = e.project_id
         WHERE e.user_id = ANY($1::uuid[]) AND e.work_date BETWEEN $2::date AND $3::date AND e.ended_at IS NOT NULL${projectFilter}`,
        params);
      let task = 0;
      let during = 0;
      let manual = 0;
      let onsite = 0;
      const projects = new Map<string, { label: string; minutes: number }>();
      const categories = new Map<string, number>();
      const workTypes = new Map<string, number>();
      const inRangeByTask = new Map<string, number>();
      for (const e of entries.rows) {
        const overlap = Math.min(e.minutes, Math.floor(e.overlap_s / 60));
        task += e.minutes;
        during += overlap;
        if (e.source === 'MANUAL') manual += e.minutes;
        if (e.source === 'ONSITE') onsite += e.minutes;
        bump(e.work_date, (t) => { t.task += e.minutes; t.focused += e.minutes - overlap; });
        const pk = e.project_id ?? 'none';
        const pb = projects.get(pk) ?? { label: e.project_name ?? 'No project', minutes: 0 };
        pb.minutes += e.minutes;
        projects.set(pk, pb);
        categories.set(e.category ?? 'NONE', (categories.get(e.category ?? 'NONE') ?? 0) + e.minutes);
        workTypes.set(e.work_type ?? 'NONE', (workTypes.get(e.work_type ?? 'NONE') ?? 0) + e.minutes);
        if (e.task_id) inRangeByTask.set(e.task_id, (inRangeByTask.get(e.task_id) ?? 0) + e.minutes);
      }

      // Tasks touched in the range, and tasks of these people completed in the range.
      const tparams: unknown[] = [[...inRangeByTask.keys()], uids, q.from, q.to];
      let tProject = '';
      if (q.projectId) { tparams.push(q.projectId); tProject = ` AND t.project_id = $${tparams.length}`; }
      const tasks = await db.query<{ id: string; title: string; status: string; estimate_minutes: number | null; project_name: string | null; done_in_range: boolean; actual: number }>(
        `SELECT t.id, t.title, t.status, t.estimate_minutes, p.name AS project_name,
                (t.status = 'DONE' AND t.completed_at::date BETWEEN $3::date AND $4::date) AS done_in_range,
                (SELECT COALESCE(SUM(x.minutes), 0) FROM time_entries x WHERE x.task_id = t.id AND x.ended_at IS NOT NULL)::int AS actual
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.deleted_at IS NULL${tProject} AND (t.id = ANY($1::uuid[])
           OR (t.assignee_id = ANY($2::uuid[]) AND t.status = 'DONE' AND t.completed_at::date BETWEEN $3::date AND $4::date))`,
        tparams);
      const toRow = (t: (typeof tasks.rows)[number]): WorkTimeTaskRow => ({
        taskId: t.id, title: t.title, projectName: t.project_name, status: t.status, estimateMinutes: t.estimate_minutes,
        minutesInRange: inRangeByTask.get(t.id) ?? 0, actualMinutes: t.actual,
        remainingMinutes: t.estimate_minutes === null ? null : Math.max(0, t.estimate_minutes - t.actual),
        percentOfEstimate: t.estimate_minutes ? Math.round((t.actual * 100) / t.estimate_minutes) : null,
      });
      const taskRows = tasks.rows.filter((t) => inRangeByTask.has(t.id)).map(toRow).sort((a, b) => b.minutesInRange - a.minutesInRange);
      const completed = tasks.rows.filter((t) => t.done_in_range && t.estimate_minutes);
      const over = tasks.rows.map(toRow).filter((t) => t.estimateMinutes !== null && t.actualMinutes > t.estimateMinutes)
        .sort((a, b) => (b.percentOfEstimate ?? 0) - (a.percentOfEstimate ?? 0));

      const label = (m: Map<string, number>, names: Record<string, string>) => [...m.entries()]
        .map(([key, minutes]) => ({ key, label: names[key] ?? 'Not specified', minutes })).sort((a, b) => b.minutes - a.minutes);
      const trend = (m: Map<string, Trend>) => [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([period, t]) => ({ period, attendanceMinutes: t.attendance, meetingMinutes: t.meeting, taskMinutes: t.task, focusedTaskMinutes: t.focused }));

      const base = {
        from: q.from, to: q.to, scope: q.scope, people: uids.length,
        totals: { attendanceMinutes: attendance, meetingMinutes: meeting, taskMinutes: task, focusedTaskMinutes: task - during, taskDuringMeetingsMinutes: during, manualMinutes: manual, onsiteMinutes: onsite },
        tasks: taskRows,
        projects: [...projects.entries()].map(([key, v]) => ({ key, label: v.label, minutes: v.minutes })).sort((a, b) => b.minutes - a.minutes),
        categories: label(categories, WORK_CATEGORY_LABEL),
        workTypes: label(workTypes, WORK_TYPE_LABEL),
        weekly: trend(weekly),
        monthly: trend(monthly),
        overEstimate: { completedTasks: completed.length, completedOverEstimate: completed.filter((t) => t.actual > t.estimate_minutes!).length, tasks: over.slice(0, 20) },
      };
      return { ...base, insights: workTimeInsights(base) };
    });
  }

  /** CSV / XLSX of the same figures, one table with a Section column; audited (REPORT_EXPORTED). */
  async export(user: AuthenticatedUser, q: WorkTimeReportQuery & { format: 'csv' | 'xlsx' }): Promise<ExportFile> {
    const r = await this.report(user, q);
    const h = (m: number | null) => (m === null ? null : hours(m));
    const rows: Cell[][] = [
      ['Summary', 'Attended', h(r.totals.attendanceMinutes), null, null, null],
      ['Summary', 'In meetings', h(r.totals.meetingMinutes), null, null, null],
      ['Summary', 'Task time', h(r.totals.taskMinutes), null, null, null],
      ['Summary', 'Focused task time (outside meetings)', h(r.totals.focusedTaskMinutes), null, null, null],
      ['Summary', 'Task time during meetings', h(r.totals.taskDuringMeetingsMinutes), null, null, null],
      ...r.tasks.map((t): Cell[] => ['Task', t.title, h(t.minutesInRange), h(t.estimateMinutes), h(t.actualMinutes), h(t.remainingMinutes)]),
      ...r.projects.map((p): Cell[] => ['Project', p.label, h(p.minutes), null, null, null]),
      ...r.categories.map((c): Cell[] => ['Category', c.label, h(c.minutes), null, null, null]),
      ...r.workTypes.map((c): Cell[] => ['Work type', c.label, h(c.minutes), null, null, null]),
      ...r.weekly.map((w): Cell[] => ['Week', `Week of ${w.period}`, h(w.taskMinutes), null, null, null]),
    ];
    return await this.prisma.runWithTenantContext(user.orgId, (db) => exportTable(db, user, {
      report: 'work-time', title: 'Work-time report', subtitle: `${q.from} to ${q.to}`,
      header: ['Section', 'Item', 'Hours in range', 'Estimate (h)', 'Actual all time (h)', 'Remaining (h)'],
      rows, format: q.format, filters: { from: q.from, to: q.to, scope: q.scope, userId: q.userId ?? null, projectId: q.projectId ?? null },
    }));
  }
}
