/**
 * HR attendance analytics (FR-REP-009, ADR 059). Three measures from server records, never added
 * together:
 *
 * - Verified work attendance: attendance sessions per person and day, adjusted and cancelled ones
 *   left out, summed as the daily summary does (computeDailySummary); status, late and early leave
 *   from the daily summary. Meeting time is capped at work time, as in the work-time report.
 * - Office connected time: office_presence_intervals merged (several tabs or a reconnect count
 *   once), cut at organisation-local midnights, open intervals ending at their last observation.
 * - Confirmed meeting time: the in-meeting time inside work (above); per meeting, the person's
 *   LiveKit connections merged, in the person's detail only (titles only to the person).
 *
 * Scope is the existing report scope (reports.all: the organisation; reports.team: the viewer,
 * direct reports and own team). Exports need attendance.export and are audited.
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { formatInTimeZone } from 'date-fns-tz';
import { PrismaService } from '../common/prisma.service.ts';
import type { Cell } from '../common/export-format.ts';
import { Permission, userCan } from '../../../../packages/shared/src/auth/types.ts';
import { ANALYTICS_MAX_DAYS, ANALYTICS_STATUS_LABEL } from '../../../../packages/shared/src/reports/attendance-analytics.ts';
import type {
  AnalyticsGroup, AnalyticsRow, AnalyticsStatus, AnalyticsSummary, AttendanceAnalytics, AttendanceAnalyticsQuery, PersonAnalytics, PersonAnalyticsQuery, PersonWork,
} from '../../../../packages/shared/src/reports/attendance-analytics.ts';
import type { AuthenticatedUser, ReportUserRef } from '../../../../packages/shared/src/index.ts';
import { ensureRange, exportTable, orgToday, reportScope, scopeSql } from './report-scope.ts';
import type { ExportFile, Scope } from './report-scope.ts';
import { weekOf } from './work-time.service.ts';
import { localDayBounds, mergeIntervals, officeIntervalEnd, secondsByLocalDay } from './presence-days.ts';
import type { Interval } from './presence-days.ts';

type Db = pg.PoolClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Detail lists are capped: a year of one person's segments stays well under this. */
const DETAIL_LIMIT = 5_000;
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

interface Person extends ReportUserRef { teamId: string | null }
interface Org { timezone: string; retentionDays: number }

/** One person and one local day, before grouping. */
interface DayFacts {
  userId: string;
  date: string;
  hasAttendance: boolean;
  firstIn: Date | null;
  lastOut: Date | null;
  work: number;
  active: number;
  brk: number;
  meeting: number;
  office: number;
  late: number;
  early: number;
  status: AnalyticsStatus | null;
  /** FR-REP-010: seconds recorded on tasks (timer and manual) and tasks completed that day. */
  task: number;
  done: number;
}

const emptyDay = (userId: string, date: string): DayFacts => ({ userId, date, hasAttendance: false, firstIn: null, lastOut: null, work: 0, active: 0, brk: 0, meeting: 0, office: 0, late: 0, early: 0, status: null, task: 0, done: 0 });

/** Groups one person's days into a day, week or month row. Exported for the unit tests. */
export function groupDays(person: ReportUserRef, days: DayFacts[], groupBy: AnalyticsGroup | 'total', label?: string): AnalyticsRow[] {
  const key = (d: DayFacts) => (groupBy === 'day' ? d.date : groupBy === 'week' ? weekOf(d.date) : groupBy === 'month' ? d.date.slice(0, 7) : (label ?? 'total'));
  const out = new Map<string, AnalyticsRow & { lastOutMs: number; firstInMs: number }>();
  for (const d of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    const k = key(d);
    let r = out.get(k);
    if (!r) {
      r = { user: person, period: k, daysWorked: 0, firstIn: null, lastOut: null, workSeconds: 0, activeSeconds: 0, breakSeconds: 0, meetingSeconds: 0, officeSeconds: 0,
        lateMinutes: 0, earlyLeaveMinutes: 0, taskSeconds: 0, tasksDone: 0, status: null, statusCounts: {}, lastOutMs: -Infinity, firstInMs: Infinity };
      out.set(k, r);
    }
    if (d.hasAttendance) r.daysWorked += 1;
    if (d.firstIn && d.firstIn.getTime() < r.firstInMs) { r.firstInMs = d.firstIn.getTime(); r.firstIn = d.firstIn.toISOString(); }
    if (d.lastOut && d.lastOut.getTime() > r.lastOutMs) { r.lastOutMs = d.lastOut.getTime(); r.lastOut = d.lastOut.toISOString(); }
    r.workSeconds += d.work;
    r.activeSeconds += d.active;
    r.breakSeconds += d.brk;
    r.meetingSeconds += d.meeting;
    r.officeSeconds += d.office;
    r.lateMinutes += d.late;
    r.earlyLeaveMinutes += d.early;
    r.taskSeconds += d.task;
    r.tasksDone += d.done;
    if (d.status) r.statusCounts[d.status] = (r.statusCounts[d.status] ?? 0) + 1;
    if (groupBy === 'day') r.status = d.status;
  }
  return [...out.values()].map(({ lastOutMs: _l, firstInMs: _f, ...r }) => r);
}

export function summarise(people: number, days: DayFacts[]): AnalyticsSummary {
  const worked = days.filter((d) => d.hasAttendance);
  const work = days.reduce((s, d) => s + d.work, 0);
  const meeting = days.reduce((s, d) => s + d.meeting, 0);
  const statusCounts: Record<string, number> = {};
  for (const d of days) if (d.status) statusCounts[d.status] = (statusCounts[d.status] ?? 0) + 1;
  return {
    people,
    peoplePresent: new Set(worked.map((d) => d.userId)).size,
    daysWorked: worked.length,
    workSeconds: work,
    averageWorkSeconds: worked.length ? Math.round(work / worked.length) : 0,
    meetingSeconds: meeting,
    meetingSharePct: work > 0 ? Math.round((meeting * 100) / work) : 0,
    officeSeconds: days.reduce((s, d) => s + d.office, 0),
    taskSeconds: days.reduce((s, d) => s + d.task, 0),
    tasksDone: days.reduce((s, d) => s + d.done, 0),
    statusCounts,
  };
}

@Injectable()
export class AttendanceAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- the dashboard

  async report(user: AuthenticatedUser, q: AttendanceAnalyticsQuery, now: Date = new Date()): Promise<AttendanceAnalytics> {
    const { all, ...r } = await this.build(user, q, now);
    const start = (q.page - 1) * q.pageSize;
    return { ...r, rows: all.slice(start, start + q.pageSize), page: q.page, pageSize: q.pageSize, totalRows: all.length };
  }

  /** Every row of the report (sorted), and everything else it says. */
  private async build(user: AuthenticatedUser, q: AttendanceAnalyticsQuery, now: Date): Promise<Omit<AttendanceAnalytics, 'rows' | 'page' | 'pageSize' | 'totalRows'> & { all: AnalyticsRow[] }> {
    ensureRange(q.from, q.to, ANALYTICS_MAX_DAYS);
    const scope = reportScope(user);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const org = await this.org(db, user.orgId);
      const all = await this.people(db, user, scope, {});
      const people = q.teamId || q.userId ? await this.people(db, user, scope, { teamId: q.teamId, userId: q.userId }) : all;
      const days = await this.days(db, people.map((p) => p.id), q.from, q.to, org.timezone, now);
      const byId = new Map(people.map((p) => [p.id, p]));
      const rows: AnalyticsRow[] = [];
      for (const [uid, list] of groupBy(days, (d) => d.userId)) rows.push(...groupDays(byId.get(uid)!, list, q.groupBy));
      sortRows(rows, q.sort, q.dir);
      const teams = new Map<string, string>();
      for (const p of all) if (p.teamId && p.teamName) teams.set(p.teamId, p.teamName);
      return {
        from: q.from, to: q.to, timezone: org.timezone, ...(await this.retention(db, user.orgId, q.from, org, now)),
        groupBy: q.groupBy, scope, canExport: userCan(user, Permission.ATTENDANCE_EXPORT),
        summary: summarise(people.length, days),
        all: rows,
        people: all.map(({ id, displayName, email, teamName, teamId }) => ({ id, displayName, email, teamName, teamId })),
        teams: [...teams].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      };
    });
  }

  async export(user: AuthenticatedUser, q: AttendanceAnalyticsQuery & { format: 'csv' | 'xlsx' | 'pdf' }, now: Date = new Date()): Promise<ExportFile> {
    // Only people allowed to export attendance (HR, administrators, auditors); never by scope alone.
    if (!userCan(user, Permission.ATTENDANCE_EXPORT)) throw new ForbiddenException('Exporting attendance needs the attendance export permission');
    const { all: full, ...r } = await this.build(user, q, now);
    const t = (s: string | null) => (s ? formatInTimeZone(new Date(s), r.timezone, 'yyyy-MM-dd HH:mm') : '');
    const h = (s: number) => Math.round((s / 3600) * 100) / 100;
    const header = ['Person', 'Team', { day: 'Day', week: 'Week of', month: 'Month' }[q.groupBy], 'Days worked', 'First check-in', 'Last check-out',
      'Verified work (h)', 'Active (h)', 'Break (h)', 'Confirmed meetings (h)', 'Office connected (h)', 'Recorded task time (h)', 'Tasks completed', 'Late (min)', 'Early leave (min)', 'Status'];
    const status = (x: AnalyticsRow) => (x.status ? ANALYTICS_STATUS_LABEL[x.status] : Object.entries(x.statusCounts).map(([k, n]) => `${ANALYTICS_STATUS_LABEL[k as AnalyticsStatus] ?? k} ${n}`).join(', '));
    const rows: Cell[][] = full.map((x) => [x.user.displayName ?? x.user.email, x.user.teamName ?? '', x.period, x.daysWorked, t(x.firstIn), t(x.lastOut),
      h(x.workSeconds), h(x.activeSeconds), h(x.breakSeconds), h(x.meetingSeconds), h(x.officeSeconds), h(x.taskSeconds), x.tasksDone, x.lateMinutes, x.earlyLeaveMinutes, status(x)]);
    return await this.prisma.runWithTenantContext(user.orgId, (db) => exportTable(db, user, {
      report: `attendance-analytics-by-${q.groupBy}`,
      title: 'Attendance analytics',
      subtitle: `${q.from} to ${q.to} · ${r.timezone} · ${r.scope === 'all' ? 'whole organisation' : 'my team'} · office connected time and recorded task time are not verified work time`,
      header, rows, format: q.format, filters: { groupBy: q.groupBy, from: q.from, to: q.to, teamId: q.teamId ?? null, userId: q.userId ?? null },
    }));
  }

  // ---------------------------------------------------------------- one person

  /**
   * One person's detail. The person themselves always; someone else with attendance.read.all, or
   * attendance.read.team for a direct report or a member of the viewer's team. Anyone else, or
   * nobody by that id, is "not found" (an invisible person and a missing one look the same).
   */
  async person(user: AuthenticatedUser, userId: string, q: PersonAnalyticsQuery, now: Date = new Date()): Promise<PersonAnalytics> {
    ensureRange(q.from, q.to, ANALYTICS_MAX_DAYS);
    if (!UUID.test(userId)) throw new NotFoundException('Person not found');
    const self = userId === user.id;
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const target = (await db.query<{ id: string; display_name: string | null; email: string; team_id: string | null; team_name: string | null; manager_id: string | null }>(
        `SELECT u.id, u.display_name, u.email, u.team_id, t.name AS team_name, u.manager_id FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = $1`, [userId])).rows[0];
      if (!target) throw new NotFoundException('Person not found');
      if (!self) {
        const all = userCan(user, Permission.ATTENDANCE_READ_ALL);
        const team = userCan(user, Permission.ATTENDANCE_READ_TEAM) && (target.manager_id === user.id || (!!user.teamId && target.team_id === user.teamId));
        if (!all && !team) throw new NotFoundException('Person not found');
      } else if (!userCan(user, Permission.ATTENDANCE_READ_OWN)) {
        throw new NotFoundException('Person not found');
      }
      const org = await this.org(db, user.orgId);
      const ref: ReportUserRef = { id: target.id, displayName: target.display_name, email: target.email, teamName: target.team_name };
      const days = await this.days(db, [userId], q.from, q.to, org.timezone, now);
      const range = { start: localDayBounds(q.from, org.timezone).start, end: localDayBounds(q.to, org.timezone).end };
      return {
        from: q.from, to: q.to, timezone: org.timezone, ...(await this.retention(db, user.orgId, q.from, org, now)),
        user: ref, self,
        days: groupDays(ref, days, 'day').sort((a, b) => b.period.localeCompare(a.period)),
        weeks: groupDays(ref, days, 'week').sort((a, b) => b.period.localeCompare(a.period)),
        months: groupDays(ref, days, 'month').sort((a, b) => b.period.localeCompare(a.period)),
        total: groupDays(ref, days.length ? days : [emptyDay(userId, q.from)], 'total', `${q.from}..${q.to}`)[0]!,
        segments: await this.segments(db, userId, q, now),
        office: await this.officeList(db, userId, range, now),
        meetings: await this.meetings(db, userId, range, self, now),
        corrections: (await db.query<{ id: string; requested_in: Date; requested_out: Date; status: string; created_at: Date; reviewed_at: Date | null }>(
          `SELECT id, requested_in, requested_out, status, created_at, reviewed_at FROM attendance_corrections
           WHERE user_id = $1 AND requested_in < $3 AND requested_out > $2 ORDER BY requested_in DESC LIMIT ${DETAIL_LIMIT}`,
          [userId, new Date(range.start), new Date(range.end)])).rows
          .map((c) => ({ id: c.id, requestedIn: c.requested_in.toISOString(), requestedOut: c.requested_out.toISOString(), status: c.status, createdAt: c.created_at.toISOString(), reviewedAt: iso(c.reviewed_at) })),
        work: await this.work(db, user, target, q, range, now),
      };
    });
  }

  // ---------------------------------------------------------------- building blocks

  private async org(db: Db, orgId: string): Promise<Org> {
    const r = (await db.query<{ timezone: string; retention_presence_days: number }>(`SELECT timezone, retention_presence_days FROM organizations WHERE id = $1`, [orgId])).rows[0];
    return { timezone: r?.timezone ?? 'UTC', retentionDays: r?.retention_presence_days ?? 90 };
  }

  /** The first day office data can exist for (presence retention), and the retention itself. */
  private async retention(db: Db, orgId: string, from: string, org: Org, now: Date): Promise<{ officeDataFrom: string; retentionDays: number }> {
    const today = await orgToday(db, orgId, now);
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - org.retentionDays);
    const kept = d.toISOString().slice(0, 10);
    return { officeDataFrom: kept > from ? kept : from, retentionDays: org.retentionDays };
  }

  /** The people in the viewer's report scope (optionally narrowed), with their team. */
  private async people(db: Db, user: AuthenticatedUser, scope: Scope, filters: { teamId?: string; userId?: string }): Promise<Person[]> {
    const params: unknown[] = [user.orgId];
    const where = scopeSql(user, scope, params, filters);
    const rows = await db.query<{ id: string; display_name: string | null; email: string; team_id: string | null; team_name: string | null }>(
      `SELECT u.id, u.display_name, u.email, u.team_id, t.name AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id
       WHERE ${where} ORDER BY COALESCE(u.display_name, u.email)`, params);
    return rows.rows.map((r) => ({ id: r.id, displayName: r.display_name, email: r.email, teamName: r.team_name, teamId: r.team_id }));
  }

  /** Every person-day with attendance, a daily summary or office time, in the range. */
  private async days(db: Db, uids: string[], from: string, to: string, timezone: string, now: Date): Promise<DayFacts[]> {
    if (!uids.length) return [];
    const facts = new Map<string, DayFacts>();
    const get = (userId: string, date: string) => {
      const k = `${userId}|${date}`;
      let d = facts.get(k);
      if (!d) { d = emptyDay(userId, date); facts.set(k, d); }
      return d;
    };
    // Verified work: the sessions of the day, as computeDailySummary sums them.
    const sessions = await db.query<{ user_id: string; work_date: string; first_in: Date; last_out: Date | null; open: boolean; net: string; active: string; brk: string; meet: string }>(
      `SELECT user_id, work_date, min(clock_in_at) AS first_in, (array_agg(clock_out_at ORDER BY clock_in_at DESC))[1] AS last_out,
              bool_or(clock_out_at IS NULL) AS open, sum(net_seconds)::text AS net, sum(active_seconds)::text AS active,
              sum(break_seconds)::text AS brk, sum(meeting_seconds)::text AS meet
       FROM attendance_sessions WHERE user_id = ANY($1::uuid[]) AND work_date BETWEEN $2 AND $3 AND status NOT IN ('ADJUSTED', 'CANCELLED')
       GROUP BY user_id, work_date`, [uids, from, to]);
    const open = new Set<string>();
    for (const s of sessions.rows) {
      const d = get(s.user_id, s.work_date);
      d.hasAttendance = true;
      d.firstIn = s.first_in;
      d.lastOut = s.open ? null : s.last_out;
      d.work = Number(s.net);
      d.active = Number(s.active);
      d.brk = Number(s.brk);
      d.meeting = Math.min(Number(s.meet), d.work);
      if (s.open) open.add(`${s.user_id}|${s.work_date}`);
    }
    // Status, lateness and early leave from the daily summary (and days with a status but no session: absent, leave, holiday).
    const daily = await db.query<{ user_id: string; work_date: string; day_status: string; late_minutes: number; early_leave_minutes: number }>(
      `SELECT user_id, work_date, day_status, late_minutes, early_leave_minutes FROM attendance_daily
       WHERE user_id = ANY($1::uuid[]) AND work_date BETWEEN $2 AND $3`, [uids, from, to]);
    const summarised = new Set<string>();
    for (const r of daily.rows) {
      const d = get(r.user_id, r.work_date);
      summarised.add(`${r.user_id}|${r.work_date}`);
      d.status = r.day_status as AnalyticsStatus;
      d.late = r.late_minutes;
      d.early = r.early_leave_minutes;
    }
    for (const [k, d] of facts) {
      if (open.has(k)) d.status = 'IN_PROGRESS';
      else if (d.hasAttendance && !summarised.has(k)) d.status = 'NOT_SUMMARISED';
    }
    // Office connected time, merged and cut at local midnights.
    const range = { start: localDayBounds(from, timezone).start, end: localDayBounds(to, timezone).end };
    const office = await db.query<{ user_id: string; started_at: Date; ended_at: Date | null; last_seen_at: Date }>(
      `SELECT user_id, started_at, ended_at, last_seen_at FROM office_presence_intervals
       WHERE user_id = ANY($1::uuid[]) AND started_at < $3 AND COALESCE(ended_at, last_seen_at) > $2`,
      [uids, new Date(range.start), new Date(range.end)]);
    const byUser = new Map<string, Interval[]>();
    for (const r of office.rows) {
      const list = byUser.get(r.user_id) ?? [];
      list.push({ start: r.started_at.getTime(), end: officeIntervalEnd({ startedAt: r.started_at, endedAt: r.ended_at, lastSeenAt: r.last_seen_at }, now.getTime()) });
      byUser.set(r.user_id, list);
    }
    for (const [uid, list] of byUser) for (const [date, seconds] of secondsByLocalDay(list, from, to, timezone)) get(uid, date).office = seconds;
    // FR-REP-010: recorded task time (a running timer counts up to now) and tasks completed, per local day.
    const entries = await db.query<{ user_id: string; work_date: string; seconds: string }>(
      `SELECT user_id, work_date::text AS work_date,
              sum(CASE WHEN ended_at IS NULL AND started_at IS NOT NULL THEN GREATEST(0, floor(extract(epoch FROM ($4::timestamptz - started_at))))
                       ELSE COALESCE(minutes, 0) * 60 END)::text AS seconds
       FROM time_entries WHERE user_id = ANY($1::uuid[]) AND work_date BETWEEN $2 AND $3 GROUP BY user_id, work_date`, [uids, from, to, now]);
    for (const e of entries.rows) get(e.user_id, e.work_date).task = Number(e.seconds);
    const done = await db.query<{ assignee_id: string; day: string; n: string }>(
      `SELECT assignee_id, (completed_at AT TIME ZONE $4)::date::text AS day, count(*)::text AS n FROM tasks
       WHERE assignee_id = ANY($1::uuid[]) AND deleted_at IS NULL AND status = 'DONE' AND completed_at >= $2 AND completed_at < $3
       GROUP BY assignee_id, day`, [uids, new Date(range.start), new Date(range.end), timezone]);
    for (const t of done.rows) get(t.assignee_id, t.day).done = Number(t.n);
    return [...facts.values()];
  }

  /**
   * FR-REP-010: one person's work items. Task titles only for the person, someone who may read all
   * tasks, or a team lead (tasks.read.team) for their own team or direct report.
   */
  private async work(db: Db, user: AuthenticatedUser, target: { id: string; team_id: string | null; manager_id: string | null }, q: PersonAnalyticsQuery, range: Interval, now: Date): Promise<PersonWork> {
    const self = target.id === user.id;
    const titles = self || userCan(user, Permission.TASKS_READ_ALL)
      || (userCan(user, Permission.TASKS_READ_TEAM) && (target.manager_id === user.id || (!!user.teamId && target.team_id === user.teamId)));
    const today = await orgToday(db, user.orgId, now);
    const time = (await db.query<{ timer: string; manual: string; n: string }>(
      `SELECT COALESCE(sum(CASE WHEN source = 'TIMER' THEN CASE WHEN ended_at IS NULL AND started_at IS NOT NULL THEN GREATEST(0, floor(extract(epoch FROM ($4::timestamptz - started_at)))) ELSE COALESCE(minutes, 0) * 60 END END), 0)::text AS timer,
              COALESCE(sum(CASE WHEN source <> 'TIMER' THEN COALESCE(minutes, 0) * 60 END), 0)::text AS manual, count(*)::text AS n
       FROM time_entries WHERE user_id = $1 AND work_date BETWEEN $2 AND $3`, [target.id, q.from, q.to, now])).rows[0]!;
    const counts = (await db.query<{ open: string; completed: string; overdue: string; due: string }>(
      `SELECT count(*) FILTER (WHERE status <> 'DONE')::text AS open,
              count(*) FILTER (WHERE status = 'DONE' AND completed_at >= $2 AND completed_at < $3)::text AS completed,
              count(*) FILTER (WHERE status <> 'DONE' AND due_date < $4::date)::text AS overdue,
              count(*) FILTER (WHERE due_date BETWEEN $5::date AND $6::date)::text AS due
       FROM tasks WHERE assignee_id = $1 AND deleted_at IS NULL`, [target.id, new Date(range.start), new Date(range.end), today, q.from, q.to])).rows[0]!;
    const list = await db.query<{ id: string; title: string; status: string; priority: string | null; due_date: string | null; completed_at: Date | null; recorded: string }>(
      `SELECT t.id, t.title, t.status, t.priority, t.due_date::text AS due_date, t.completed_at,
              COALESCE((SELECT sum(COALESCE(e.minutes, 0) * 60) FROM time_entries e WHERE e.task_id = t.id AND e.user_id = $1 AND e.work_date BETWEEN $4 AND $5), 0)::text AS recorded
       FROM tasks t WHERE t.assignee_id = $1 AND t.deleted_at IS NULL
         AND (t.status <> 'DONE' OR (t.completed_at >= $2 AND t.completed_at < $3) OR (t.created_at >= $2 AND t.created_at < $3))
       ORDER BY (t.status <> 'DONE' AND t.due_date < $6::date) DESC, t.due_date NULLS LAST, t.created_at DESC LIMIT 200`,
      [target.id, new Date(range.start), new Date(range.end), q.from, q.to, today]);
    const sheets = await db.query<{ id: string; period_start: string; period_end: string; status: string; submitted_at: Date | null; approved_at: Date | null; logged_minutes: number | null; attendance_minutes: number | null }>(
      `SELECT id, period_start::text AS period_start, period_end::text AS period_end, status, submitted_at, approved_at, logged_minutes, attendance_minutes
       FROM timesheets WHERE user_id = $1 AND period_start <= $3::date AND period_end >= $2::date ORDER BY period_start DESC LIMIT 60`, [target.id, q.from, q.to]);
    const activity = await db.query<{ type: string; n: string }>(
      `SELECT type, count(*)::text AS n FROM task_activity WHERE actor_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY type`,
      [target.id, new Date(range.start), new Date(range.end)]);
    const byType: Record<string, number> = {};
    for (const a of activity.rows) byType[a.type] = Number(a.n);
    return {
      taskTime: { timerSeconds: Number(time.timer), manualSeconds: Number(time.manual), entries: Number(time.n) },
      tasks: { open: Number(counts.open), completed: Number(counts.completed), overdue: Number(counts.overdue), dueInRange: Number(counts.due) },
      taskList: list.rows.map((t) => ({
        id: t.id, title: titles ? t.title : null, status: t.status, priority: t.priority, dueDate: t.due_date, completedAt: iso(t.completed_at),
        overdue: t.status !== 'DONE' && !!t.due_date && t.due_date < today, recordedSeconds: Number(t.recorded),
      })),
      timesheets: sheets.rows.map((s) => ({
        id: s.id, periodStart: s.period_start, periodEnd: s.period_end, status: s.status, submittedAt: iso(s.submitted_at), approvedAt: iso(s.approved_at),
        loggedMinutes: s.logged_minutes ?? 0, attendanceMinutes: s.attendance_minutes ?? 0,
      })),
      activity: { total: Object.values(byType).reduce((s, n) => s + n, 0), byType },
    };
  }

  private async segments(db: Db, userId: string, q: PersonAnalyticsQuery, now: Date): Promise<PersonAnalytics['segments']> {
    const r = await db.query<{ work_date: string; state: string; started_at: Date; ended_at: Date | null; duration_seconds: number }>(
      `SELECT s.work_date, g.state, g.started_at, g.ended_at, g.duration_seconds FROM attendance_segments g JOIN attendance_sessions s ON s.id = g.session_id
       WHERE s.user_id = $1 AND s.work_date BETWEEN $2 AND $3 AND s.status NOT IN ('ADJUSTED', 'CANCELLED')
       ORDER BY g.started_at DESC LIMIT ${DETAIL_LIMIT}`, [userId, q.from, q.to]);
    return r.rows.map((g) => ({
      workDate: g.work_date, state: g.state, startedAt: g.started_at.toISOString(), endedAt: iso(g.ended_at),
      seconds: g.ended_at ? g.duration_seconds : Math.max(0, Math.floor((now.getTime() - g.started_at.getTime()) / 1000)),
    }));
  }

  private async officeList(db: Db, userId: string, range: Interval, now: Date): Promise<PersonAnalytics['office']> {
    const r = await db.query<{ started_at: Date; ended_at: Date | null; last_seen_at: Date; end_reason: string | null }>(
      `SELECT started_at, ended_at, last_seen_at, end_reason FROM office_presence_intervals
       WHERE user_id = $1 AND started_at < $3 AND COALESCE(ended_at, last_seen_at) > $2 ORDER BY started_at DESC LIMIT ${DETAIL_LIMIT}`,
      [userId, new Date(range.start), new Date(range.end)]);
    return r.rows.map((o) => {
      const end = officeIntervalEnd({ startedAt: o.started_at, endedAt: o.ended_at, lastSeenAt: o.last_seen_at }, now.getTime());
      const seconds = Math.floor(Math.max(0, Math.min(end, range.end) - Math.max(o.started_at.getTime(), range.start)) / 1000);
      return { startedAt: o.started_at.toISOString(), endedAt: iso(o.ended_at), seconds, open: o.ended_at === null, endReason: o.end_reason };
    });
  }

  /** Per meeting: the union of the person's connections (reconnects once), within the range. */
  private async meetings(db: Db, userId: string, range: Interval, self: boolean, now: Date): Promise<PersonAnalytics['meetings']> {
    const r = await db.query<{ meeting_id: string; title: string; type: string; joined_at: Date; left_at: Date | null; ended_at: Date | null }>(
      `SELECT p.meeting_id, m.title, m.type, p.joined_at, p.left_at, m.ended_at FROM meeting_participants p JOIN meetings m ON m.id = p.meeting_id
       WHERE p.user_id = $1 AND p.joined_at < $3 AND COALESCE(p.left_at, m.ended_at, $4) > $2 ORDER BY p.joined_at LIMIT ${DETAIL_LIMIT}`,
      [userId, new Date(range.start), new Date(range.end), now]);
    const out = new Map<string, { title: string; type: string; first: number; last: number | null; open: boolean; list: Interval[] }>();
    for (const p of r.rows) {
      const m = out.get(p.meeting_id) ?? { title: p.title, type: p.type, first: p.joined_at.getTime(), last: null, open: false, list: [] };
      // A connection whose end the server never saw ends with the meeting, or now.
      const end = p.left_at?.getTime() ?? p.ended_at?.getTime() ?? now.getTime();
      if (!p.left_at) m.open = true;
      else m.last = Math.max(m.last ?? 0, p.left_at.getTime());
      m.first = Math.min(m.first, p.joined_at.getTime());
      m.list.push({ start: Math.max(p.joined_at.getTime(), range.start), end: Math.min(Math.max(end, p.joined_at.getTime()), range.end) });
      out.set(p.meeting_id, m);
    }
    return [...out].map(([meetingId, m]) => ({
      meetingId, title: self ? m.title : null, kind: m.type, firstJoinedAt: new Date(m.first).toISOString(), lastLeftAt: m.open || m.last === null ? null : new Date(m.last).toISOString(),
      seconds: Math.floor(mergeIntervals(m.list).reduce((s, i) => s + (i.end - i.start), 0) / 1000), open: m.open,
    })).sort((a, b) => b.firstJoinedAt.localeCompare(a.firstJoinedAt));
  }
}

function groupBy<T>(list: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const t of list) { const k = key(t); out.set(k, [...(out.get(k) ?? []), t]); }
  return out;
}

function sortRows(rows: AnalyticsRow[], sort: AttendanceAnalyticsQuery['sort'], dir: 'asc' | 'desc'): void {
  const name = (r: AnalyticsRow) => (r.user.displayName ?? r.user.email).toLowerCase();
  const sign = dir === 'asc' ? 1 : -1;
  const by: Record<typeof sort, (a: AnalyticsRow, b: AnalyticsRow) => number> = {
    date: (a, b) => sign * a.period.localeCompare(b.period) || name(a).localeCompare(name(b)),
    name: (a, b) => sign * name(a).localeCompare(name(b)) || b.period.localeCompare(a.period),
    work: (a, b) => sign * (a.workSeconds - b.workSeconds) || name(a).localeCompare(name(b)),
    office: (a, b) => sign * (a.officeSeconds - b.officeSeconds) || name(a).localeCompare(name(b)),
    meeting: (a, b) => sign * (a.meetingSeconds - b.meetingSeconds) || name(a).localeCompare(name(b)),
    tasks: (a, b) => sign * (a.taskSeconds - b.taskSeconds) || name(a).localeCompare(name(b)),
  };
  rows.sort(by[sort]);
}
