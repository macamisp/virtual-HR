import { Injectable } from '@nestjs/common';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { AttendanceService } from '../attendance/attendance.service.ts';
import { PostgresAttendanceRepository } from '../attendance/attendance-repository.ts';
import { PlanningService } from '../planning/planning.service.ts';
import { addDaysIso } from '../planning/planning-rules.ts';
import { NotificationsService } from './notifications.service.ts';
import type { NewNotification } from './notifications.service.ts';
import { dueInstant, escalationDue, localDate, reminderStage, weeklySummaryDue } from './reminder-rules.ts';
import { approversFor } from '../timesheets/timesheets.service.ts';
import { AttendanceFlagsService } from '../attendance/attendance-flags.service.ts';
import { mechanicalPatterns } from '../attendance/anti-spoofing.ts';
import type { IntervalSample } from '../attendance/anti-spoofing.ts';
import { readAttendanceGuards } from '../admin/policy-store.ts';
import { NotificationType } from '../../../../packages/shared/src/notifications/types.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';

/** FR-ATT-021: why the server closed a session, in plain words. */
const AUTO_CLOSE_REASON: Partial<Record<string, string>> = {
  TIMEOUT: 'the app stopped sending activity',
  DISCONNECT: 'the connection was lost and did not come back',
  MAX_LENGTH: 'the session reached the maximum length',
};
const AUTO_CLOCK_OUT_BODY = (why: string) => `We clocked you out at your last activity because ${why}.`;

/** ISO week of a local calendar date, like 2026-W42 (one "items to review" alert per person and week). */
function isoWeek(localDay: string): string {
  const t = new Date(`${localDay}T00:00:00Z`);
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

interface OrgRow {
  id: string;
  timezone: string;
  task_acceptance_escalation_hours: number;
  timesheet_submit_due_days: number;
  /** FR-ADM-004 retention settings. */
  retention_presence_days: number;
  retention_notifications_days: number;
}

function envNumber(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function hours(minutes: number): string {
  return `${(minutes / 60).toFixed(1)} h`;
}

/**
 * The work behind every scheduled job. Each method takes `now` so tests can drive it with a
 * fixed clock; BullMQ (jobs.service.ts) only decides *when* it runs. Every handler is
 * idempotent: reminders are deduplicated per user and key, once-per-day work is marked in
 * job_runs, and carry-over only moves tasks planned before today.
 */
@Injectable()
export class ScheduledWorkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly planning: PlanningService,
    private readonly attendance: AttendanceService,
    private readonly attendanceRepo: PostgresAttendanceRepository,
    private readonly flags: AttendanceFlagsService,
  ) {}

  private async orgs(): Promise<OrgRow[]> {
    const res = await this.prisma.getPool().query<OrgRow>(`SELECT * FROM fn_list_orgs_for_jobs()`);
    return res.rows;
  }

  /** Runs `fn` per organisation; one failing tenant never stops the others. */
  private async perOrg(job: string, fn: (org: OrgRow) => Promise<number>): Promise<number> {
    let total = 0;
    for (const org of await this.orgs()) {
      try {
        total += await fn(org);
      } catch (err) {
        console.error(`Job ${job} failed for org ${org.id}:`, err instanceof Error ? err.message : 'unknown error');
      }
    }
    return total;
  }

  private async onceFor(db: pg.PoolClient, orgId: string, job: string, key: string): Promise<boolean> {
    const res = await db.query(`INSERT INTO job_runs (org_id, job, run_key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [orgId, job, key]);
    return (res.rowCount ?? 0) > 0;
  }

  // ---------------------------------------------------------------- FR-TASK-011 / 007

  /** Due-soon (24 h, 1 h), overdue and acceptance escalation. Returns notifications created. */
  async taskReminders(now: Date = new Date()): Promise<number> {
    const dueTime = process.env.TASK_DUE_TIME || '17:00';
    return await this.perOrg('task-reminders', async (org) => {
      const today = localDate(now, org.timezone);
      const created = await this.prisma.runWithTenantContext(org.id, async (db) => {
        const items: NewNotification[] = [];
        const due = await db.query(
          `SELECT t.id, t.title, t.assignee_id, t.reporter_id, to_char(t.due_date, 'YYYY-MM-DD') AS due
           FROM tasks t
           WHERE t.org_id = $1 AND t.deleted_at IS NULL AND t.status <> 'DONE' AND t.assignee_id IS NOT NULL
             AND t.due_date BETWEEN $2::date AND $3::date`,
          [org.id, addDaysIso(today, -7), addDaysIso(today, 2)],
        );
        for (const t of due.rows) {
          const stage = reminderStage(now, dueInstant(t.due, org.timezone, dueTime));
          if (stage === 'NONE') continue;
          const key = `${stage}:${t.id}:${t.due}`;
          const base = { link: `/tasks/${t.id}`, entityType: 'TASK', entityId: t.id as string, dedupeKey: key };
          if (stage === 'OVERDUE') {
            items.push({ ...base, userId: t.assignee_id, type: 'TASK_OVERDUE', title: `Overdue: ${t.title}`, body: `“${t.title}” was due on ${t.due}.`, email: true });
            if (t.reporter_id !== t.assignee_id) {
              items.push({ ...base, userId: t.reporter_id, type: 'TASK_OVERDUE', title: `Overdue: ${t.title}`, body: `“${t.title}” was due on ${t.due} and is not done.`, email: true });
            }
          } else {
            items.push({
              ...base, userId: t.assignee_id,
              type: stage === 'DUE_24H' ? 'TASK_DUE_SOON_24H' : 'TASK_DUE_SOON_1H',
              title: stage === 'DUE_24H' ? `Due tomorrow: ${t.title}` : `Due within the hour: ${t.title}`,
              body: `“${t.title}” is due ${t.due} at ${dueTime}.`,
              email: stage === 'DUE_24H',
            });
          }
        }

        // FR-TASK-007 escalation of unaccepted tasks
        const pending = await db.query(
          `SELECT t.id, t.title, t.reporter_id, t.acceptance_requested_at, r.manager_id, a.display_name AS a_name, a.email AS a_email
           FROM tasks t JOIN users r ON r.id = t.reporter_id LEFT JOIN users a ON a.id = t.assignee_id
           WHERE t.org_id = $1 AND t.deleted_at IS NULL AND t.acceptance_status = 'PENDING'
             AND t.escalated_at IS NULL AND t.acceptance_requested_at IS NOT NULL`,
          [org.id],
        );
        for (const t of pending.rows) {
          if (!escalationDue(now, new Date(t.acceptance_requested_at), org.task_acceptance_escalation_hours)) continue;
          const claimed = await db.query(`UPDATE tasks SET escalated_at = $2 WHERE id = $1 AND escalated_at IS NULL`, [t.id, now]);
          if (!claimed.rowCount) continue;
          await db.query(
            `INSERT INTO task_activity (org_id, task_id, actor_id, type, data) VALUES ($1, $2, $3, 'ESCALATED', $4::jsonb)`,
            [org.id, t.id, t.reporter_id, JSON.stringify({ by: 'system', afterHours: org.task_acceptance_escalation_hours })],
          );
          let recipients = [t.reporter_id as string, ...(t.manager_id ? [t.manager_id as string] : [])];
          if (!t.manager_id) {
            const hr = await db.query<{ id: string }>(`SELECT id FROM users WHERE org_id = $1 AND status = 'ACTIVE' AND role IN ('HR', 'HR_MANAGER')`, [org.id]);
            recipients = [...recipients, ...hr.rows.map((r) => r.id)];
          }
          const who = t.a_name ?? t.a_email ?? 'The assignee';
          for (const userId of [...new Set(recipients)]) {
            items.push({
              userId, type: 'TASK_ESCALATED', title: `Not accepted after ${org.task_acceptance_escalation_hours} h: ${t.title}`,
              body: `${who} has not accepted or declined “${t.title}”. Follow up or reassign it.`,
              link: `/tasks/${t.id}`, entityType: 'TASK', entityId: t.id,
              dedupeKey: `escalated:${t.id}:${new Date(t.acceptance_requested_at).toISOString()}`, email: true,
            });
          }
        }
        return await this.notifications.create(db, org.id, items);
      });
      await this.notifications.deliver(org.id, created);
      return created.length;
    });
  }

  // ---------------------------------------------------------------- FR-TASK-004 carry-over

  async carryOver(now: Date = new Date()): Promise<number> {
    return await this.perOrg('carry-over', async (org) => {
      const today = localDate(now, org.timezone);
      return await this.prisma.runWithTenantContext(org.id, async (db) => {
        const users = await db.query<{ assignee_id: string }>(
          `SELECT DISTINCT assignee_id FROM tasks
           WHERE org_id = $1 AND deleted_at IS NULL AND status <> 'DONE' AND assignee_id IS NOT NULL AND planned_date < $2::date`,
          [org.id, today],
        );
        let moved = 0;
        for (const u of users.rows) moved += await this.planning.carryOverForUser(db, org.id, u.assignee_id, today);
        return moved;
      });
    });
  }

  // ---------------------------------------------------------------- FR-TS-012 / FR-TS-005

  /**
   * Every 15 minutes, all deduplicated:
   *  - owners: "submit by <due date>" once the period's last day has come, then "overdue" once
   *    past the due date (period end + org submit days); only for periods with any time;
   *  - approvers: one digest a day while timesheets have waited more than 24 h;
   *  - owners: a variance alert per flagged past day of an open timesheet (re-armed when the
   *    figures change).
   */
  async timesheetReminders(now: Date = new Date()): Promise<number> {
    return await this.perOrg('timesheet-reminders', async (org) => {
      const today = localDate(now, org.timezone);
      const created = await this.prisma.runWithTenantContext(org.id, async (db) => {
        const items: NewNotification[] = [];
        const open = await db.query<{ id: string; user_id: string; ps: string; pe: string }>(
          `SELECT t.id, t.user_id, to_char(t.period_start, 'YYYY-MM-DD') AS ps, to_char(t.period_end, 'YYYY-MM-DD') AS pe
           FROM timesheets t JOIN users u ON u.id = t.user_id
           WHERE t.org_id = $1 AND t.status IN ('DRAFT', 'REJECTED') AND t.period_end <= $2::date
             AND u.status = 'ACTIVE' AND (t.attendance_minutes > 0 OR t.logged_minutes > 0)`,
          [org.id, today],
        );
        for (const t of open.rows) {
          const due = addDaysIso(t.pe, org.timesheet_submit_due_days);
          const base = { userId: t.user_id, link: `/timesheets/${t.id}`, entityType: 'TIMESHEET', entityId: t.id, email: true };
          if (today > due) {
            items.push({ ...base, type: 'TIMESHEET_OVERDUE', title: `Timesheet overdue (${t.ps} – ${t.pe})`, body: `It was due on ${due}. Submit it as soon as you can.`, dedupeKey: `ts-overdue:${t.id}` });
          } else {
            items.push({ ...base, type: 'TIMESHEET_SUBMIT_REMINDER', title: `Submit your timesheet by ${due}`, body: `Period ${t.ps} – ${t.pe}. Check flagged days, then submit it for approval.`, dedupeKey: `ts-submit:${t.id}` });
          }
        }

        const waiting = await db.query<{ id: string; user_id: string; name: string; ps: string; pe: string }>(
          `SELECT t.id, t.user_id, COALESCE(u.display_name, u.email) AS name,
                  to_char(t.period_start, 'YYYY-MM-DD') AS ps, to_char(t.period_end, 'YYYY-MM-DD') AS pe
           FROM timesheets t JOIN users u ON u.id = t.user_id
           WHERE t.org_id = $1 AND t.status = 'SUBMITTED' AND t.submitted_at < $2
           ORDER BY t.submitted_at`,
          [org.id, new Date(now.getTime() - 24 * 3_600_000)],
        );
        const perApprover = new Map<string, string[]>();
        for (const w of waiting.rows) {
          for (const a of await approversFor(db, w.user_id)) {
            perApprover.set(a, [...(perApprover.get(a) ?? []), `${w.name}: ${w.ps} – ${w.pe}`]);
          }
        }
        for (const [userId, lines] of perApprover) {
          items.push({
            userId, type: 'TIMESHEET_APPROVAL_REMINDER',
            title: `${lines.length} timesheet${lines.length === 1 ? '' : 's'} waiting for your approval`,
            body: [...lines.slice(0, 10), ...(lines.length > 10 ? [`…and ${lines.length - 10} more`] : [])].join('\n'),
            link: '/timesheets/review', dedupeKey: `ts-approve:${today}`, email: true,
          });
        }

        const flagged = await db.query<{ user_id: string; timesheet_id: string; d: string; attendance_minutes: number; logged_minutes: number; variance_minutes: number; variance_pct: number | null; flags: string[] }>(
          `SELECT d.user_id, d.timesheet_id, to_char(d.work_date, 'YYYY-MM-DD') AS d, d.attendance_minutes, d.logged_minutes,
                  d.variance_minutes, d.variance_pct, d.flags
           FROM timesheet_days d JOIN timesheets t ON t.id = d.timesheet_id
           WHERE d.org_id = $1 AND d.flags <> '{}' AND d.alerted_at IS NULL AND t.status IN ('DRAFT', 'REJECTED')
             AND d.work_date < $2::date AND d.work_date >= $3::date`,
          [org.id, today, addDaysIso(today, -14)],
        );
        for (const f of flagged.rows) {
          const what = f.flags.includes('NO_ATTENDANCE')
            ? `${hours(f.logged_minutes)} logged on a day with no attendance.`
            : f.flags.includes('VARIANCE')
              ? `Attended ${hours(f.attendance_minutes)}, logged ${hours(f.logged_minutes)} on tasks (${f.variance_pct ?? 0}% apart).`
              : 'Manual time is over the daily limit.';
          items.push({
            userId: f.user_id, type: 'TIMESHEET_VARIANCE', title: `Check your time for ${f.d}`, body: `${what} Fix it or explain it in the timesheet notes.`,
            link: `/timesheets/${f.timesheet_id}`, entityType: 'TIMESHEET', entityId: f.timesheet_id,
            dedupeKey: `ts-var:${f.d}:${f.flags.join(',')}:${f.variance_minutes}`,
          });
        }
        if (flagged.rows.length > 0) {
          await db.query(
            `UPDATE timesheet_days SET alerted_at = now()
             WHERE org_id = $1 AND flags <> '{}' AND alerted_at IS NULL AND (user_id, work_date) IN (SELECT * FROM unnest($2::uuid[], $3::date[]))`,
            [org.id, flagged.rows.map((f) => f.user_id), flagged.rows.map((f) => f.d)],
          );
        }
        return await this.notifications.create(db, org.id, items);
      });
      await this.notifications.deliver(org.id, created);
      return created.length;
    });
  }

  // ---------------------------------------------------------------- FR-TASK-016 weekly summary

  async weeklySummary(now: Date = new Date()): Promise<number> {
    const day = envNumber('WEEKLY_SUMMARY_DAY', 5);
    const time = process.env.WEEKLY_SUMMARY_TIME || '17:00';
    return await this.perOrg('weekly-summary', async (org) => {
      const weekStart = weeklySummaryDue(now, org.timezone, day, time);
      if (!weekStart) return 0;
      const weekEnd = addDaysIso(weekStart, 6);
      const created = await this.prisma.runWithTenantContext(org.id, async (db) => {
        const recipients = await db.query(
          `SELECT id, role, team_id, display_name, email FROM users
           WHERE org_id = $1 AND status = 'ACTIVE' AND role IN ('TEAM_LEAD', 'MANAGER', 'SUBCONTRACTOR')`,
          [org.id],
        );
        const items: NewNotification[] = [];
        for (const r of recipients.rows) {
          const people = r.role === 'SUBCONTRACTOR'
            ? [r]
            : (await db.query(
                `SELECT id, display_name, email FROM users WHERE org_id = $1 AND status = 'ACTIVE'
                   AND (manager_id = $2 OR ($3::uuid IS NOT NULL AND team_id = $3::uuid)) AND id <> $2
                 ORDER BY display_name NULLS LAST, email`,
                [org.id, r.id, r.team_id],
              )).rows;
          const lines: string[] = [];
          let teamDone = 0;
          let teamOpen = 0;
          for (const p of people) {
            const s = await this.personWeek(db, org, p.id, weekStart, weekEnd);
            teamDone += s.done.length;
            teamOpen += s.open;
            lines.push(
              `${p.display_name ?? p.email}: ${s.done.length} completed, ${s.open} pending (${s.overdue} overdue), ` +
              `${hours(s.workedMinutes)} worked, ${hours(s.loggedMinutes)} logged on tasks, ${hours(s.estimateDoneMinutes)} estimated on completed tasks`,
            );
            if (r.role === 'SUBCONTRACTOR') lines.push(...s.done.slice(0, 10).map((t) => `  - done: ${t}`));
          }
          if (r.role !== 'SUBCONTRACTOR' && people.length === 0) lines.push('No one reports to you yet.');
          items.push({
            userId: r.id,
            type: 'WEEKLY_SUMMARY',
            title: `Weekly summary · week of ${weekStart}`,
            body: [
              r.role === 'SUBCONTRACTOR' ? 'Your week:' : `Your team this week: ${teamDone} completed, ${teamOpen} pending.`,
              ...lines,
              'Hours worked come from attendance; time on tasks from timers and manual entries.',
            ].join('\n'),
            link: r.role === 'SUBCONTRACTOR' ? '/tasks/week' : '/tasks/workload',
            dedupeKey: `weekly:${weekStart}`,
            email: true,
          });
        }
        return await this.notifications.create(db, org.id, items);
      });
      await this.notifications.deliver(org.id, created);
      return created.length;
    });
  }

  private async personWeek(db: pg.PoolClient, org: OrgRow, userId: string, weekStart: string, weekEnd: string) {
    const done = await db.query<{ title: string; estimate: number | null }>(
      `SELECT title, estimate_minutes AS estimate FROM tasks
       WHERE org_id = $1 AND assignee_id = $2 AND deleted_at IS NULL AND status = 'DONE'
         AND (completed_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date
       ORDER BY completed_at`,
      [org.id, userId, weekStart, weekEnd, org.timezone],
    );
    const open = await db.query<{ open: number; overdue: number }>(
      `SELECT count(*)::int AS open, count(*) FILTER (WHERE due_date < $3::date)::int AS overdue
       FROM tasks WHERE org_id = $1 AND assignee_id = $2 AND deleted_at IS NULL AND status <> 'DONE'`,
      [org.id, userId, weekEnd],
    );
    const worked = await db.query<{ seconds: number }>(
      `SELECT COALESCE(sum(net_seconds), 0)::int AS seconds FROM attendance_daily
       WHERE org_id = $1 AND user_id = $2 AND work_date BETWEEN $3 AND $4`,
      [org.id, userId, weekStart, weekEnd],
    );
    const logged = await db.query<{ minutes: number }>(
      `SELECT COALESCE(sum(minutes), 0)::int AS minutes FROM time_entries
       WHERE org_id = $1 AND user_id = $2 AND work_date BETWEEN $3::date AND $4::date AND ended_at IS NOT NULL`,
      [org.id, userId, weekStart, weekEnd],
    );
    return {
      loggedMinutes: logged.rows[0]!.minutes,
      done: done.rows.map((d) => d.title),
      estimateDoneMinutes: done.rows.reduce((s, d) => s + (d.estimate ?? 0), 0),
      open: open.rows[0]!.open,
      overdue: open.rows[0]!.overdue,
      workedMinutes: Math.round(worked.rows[0]!.seconds / 60),
    };
  }

  // ---------------------------------------------------------------- attendance jobs (FR-ATT-002, 008, 009, 015, 020)

  /** Every minute: missed heartbeats, expired grace windows, midnight split, max length. */
  async attendanceReconcile(now: Date = new Date()): Promise<number> {
    return await this.perOrg('attendance-reconcile', async (org) => {
      const r = await this.attendance.runReconciliation(now, org.id);
      // FR-ATT-021: tell people when the server clocked them out, with a way to correct it.
      const told = r.closed.filter((c) => AUTO_CLOSE_REASON[c.source]).map((c) => ({
        userId: c.userId, type: NotificationType.ATTENDANCE_AUTO_CLOCK_OUT,
        title: `Clocked out automatically at ${new Intl.DateTimeFormat('en-GB', { timeZone: org.timezone, hour: '2-digit', minute: '2-digit' }).format(c.clockOutAt)}`,
        body: `${AUTO_CLOCK_OUT_BODY(AUTO_CLOSE_REASON[c.source]!)} If this is wrong, request a correction.`,
        link: '/attendance', entityType: 'ATTENDANCE_SESSION', entityId: c.sessionId, dedupeKey: `autoclose:${c.sessionId}`,
      }));
      if (told.length) await this.notifications.notify(org.id, told);
      return r.closedCount + r.splitCount;
    });
  }

  /**
   * NFR-ACC-004 (ADR 026), nightly: yesterday's daily totals are recomputed from the stored
   * sessions and compared with the stored rows. Any difference alerts HR (critical notification,
   * once per day) and is written to the audit log. Nothing is rewritten.
   */
  async attendanceReplay(now: Date = new Date()): Promise<number> {
    return await this.perOrg('attendance-replay', async (org) => {
      const workDate = addDaysIso(localDate(now, org.timezone), -1);
      const r = await this.attendance.replayDay(org.id, workDate);
      if (r.mismatches.length === 0) return 0;
      const people = new Set(r.mismatches.map((m) => m.userId)).size;
      const first = r.mismatches[0]!;
      console.error(`Attendance replay: ${r.mismatches.length} differences across ${people} people on ${workDate} (org ${org.id})`);
      const hr = await this.prisma.runWithTenantContext(org.id, async (db) => {
        const rows = (await db.query<{ id: string }>(
          `SELECT id FROM users WHERE status = 'ACTIVE' AND role IN ('SUPER_ADMIN', 'ADMIN', 'HR_MANAGER', 'HR')
           ORDER BY array_position(ARRAY['HR', 'HR_MANAGER', 'ADMIN', 'SUPER_ADMIN']::text[], role::text), created_at`)).rows;
        if (rows[0] && await this.onceFor(db, org.id, 'attendance-replay', workDate)) {
          await appendAuditEntry(db, { orgId: org.id, actorId: rows[0].id, action: 'ATTENDANCE_REPLAY_MISMATCH', entityType: 'ORGANIZATION', entityId: org.id,
            after: { workDate, differences: r.mismatches.length, people, sample: r.mismatches.slice(0, 20), system: true } });
        }
        return rows;
      });
      await this.notifications.notify(org.id, hr.map((u) => ({
        userId: u.id, type: NotificationType.ATTENDANCE_REPLAY_MISMATCH,
        title: `Attendance totals for ${workDate} do not replay`,
        body: `${r.mismatches.length} difference(s) across ${people} people, for example ${first.field}: stored ${first.stored}, recomputed ${first.recomputed}. Nothing was changed. Review the day and run the daily close again.`,
        link: '/reports', entityType: 'ORGANIZATION', entityId: org.id, dedupeKey: `replay:${workDate}`,
      })));
      return r.mismatches.length;
    });
  }

  /**
   * FR-ATT-017 and FR-ATT-021 (ADR 019), every 5 minutes: no-clock-in reminders, long-idle alerts
   * to managers (if configured), "items to review" alerts, and the mechanical-input scan. Alerts
   * describe; they never penalise.
   */
  async attendanceAlerts(now: Date = new Date()): Promise<number> {
    return await this.perOrg('attendance-alerts', async (org) => {
      const guards = await this.prisma.runWithTenantContext(org.id, (db) => readAttendanceGuards(db, org.id));
      const items: NewNotification[] = [];
      const people = await this.prisma.runWithTenantContext(org.id, async (db) =>
        (await db.query<{ id: string; name: string }>(`SELECT id, COALESCE(display_name, email) AS name FROM users WHERE status = 'ACTIVE'`)).rows);
      const byId = new Map(people.map((p) => [p.id, p]));

      if (guards.noClockInReminder) {
        for (const p of people) {
          const r = await this.attendance.clockInReminderDue(org.id, p.id, now);
          if (!r.due) continue;
          items.push({ userId: p.id, type: NotificationType.ATTENDANCE_NO_CLOCK_IN, title: 'You have not clocked in yet',
            body: 'Your schedule started a while ago. Open the app to start your day, or ignore this if you are off today.', link: '/attendance', dedupeKey: `noclockin:${p.id}:${r.workDate}` });
        }
      }

      const sessions = await this.prisma.runWithTenantContext(org.id, async (db) => (await db.query<{ id: string; user_id: string; current_state: string; paused_since: Date | null; work_date: string }>(
        `SELECT s.id, s.user_id, s.current_state, s.work_date,
           (SELECT g.started_at FROM attendance_segments g WHERE g.session_id = s.id AND g.state = 'PAUSED' AND g.ended_at IS NULL ORDER BY g.started_at DESC LIMIT 1) AS paused_since
         FROM attendance_sessions s WHERE s.status = 'OPEN'`)).rows);

      if (guards.longIdleAlertMinutes > 0) {
        for (const s of sessions) {
          if (s.current_state !== 'PAUSED' || !s.paused_since) continue;
          const minutes = Math.floor((now.getTime() - new Date(s.paused_since).getTime()) / 60_000);
          if (minutes < guards.longIdleAlertMinutes) continue;
          const person = byId.get(s.user_id);
          if (!person) continue;
          for (const m of await this.reviewersOf(org.id, person.id)) {
            items.push({ userId: m, type: NotificationType.ATTENDANCE_LONG_IDLE, title: `${person.name} has been idle for ${minutes} minutes`,
              body: 'Their session is paused, so this time is not counted. This is information, not a warning.', link: '/live', dedupeKey: `longidle:${s.id}:${m}` });
          }
        }
      }

      // FR-ATT-017: mechanical-input heuristics over each open session's last 3.5 hours.
      for (const s of sessions) {
        const samples = await this.prisma.runWithTenantContext(org.id, async (db) => (await db.query<{ meta: Record<string, unknown> }>(
          `SELECT meta FROM presence_events WHERE session_id = $1 AND event_type = 'HEARTBEAT' AND server_ts > $2 ORDER BY server_ts`,
          [s.id, new Date(now.getTime() - 3.5 * 3600_000)])).rows);
        const parsed: IntervalSample[] = samples.map(({ meta: m }) => ({
          activeSeconds: Number(m.activeSeconds) || 0, idleSeconds: Number(m.idleSeconds) || 0,
          tabVisible: m.tabVisible !== false, windowFocused: m.windowFocused !== false, source: m.source === 'AGENT' ? 'AGENT' : 'WEB',
        }));
        for (const reason of mechanicalPatterns(parsed)) {
          await this.flags.raise({ orgId: org.id, userId: s.user_id, sessionId: s.id, workDate: s.work_date, kind: reason, details: { samples: parsed.length }, dedupeKey: `pattern:${s.id}:${reason}` });
        }
      }

      if (guards.flagAlertThreshold > 0) {
        const counts = await this.prisma.runWithTenantContext(org.id, async (db) => (await db.query<{ user_id: string; n: number }>(
          `SELECT user_id, count(*)::int AS n FROM attendance_flags WHERE status = 'OPEN' AND created_at > $1 GROUP BY user_id HAVING count(*) >= $2`,
          [new Date(now.getTime() - 7 * 86_400_000), guards.flagAlertThreshold])).rows);
        // The organisation's week, not the UTC one: late on Sunday UTC it is already Monday in Colombo.
        const week = isoWeek(localDate(now, org.timezone));
        for (const c of counts) {
          const person = byId.get(c.user_id);
          if (!person) continue;
          for (const m of await this.reviewersOf(org.id, person.id)) {
            items.push({ userId: m, type: NotificationType.ATTENDANCE_FLAGS_TO_REVIEW, title: `${c.n} attendance items to review for ${person.name}`,
              body: 'Automatic checks raised these for a human look. Nothing has been changed or deducted.', link: '/attendance/review', dedupeKey: `flags:${c.user_id}:${week}:${m}` });
          }
        }
      }

      if (items.length) await this.notifications.notify(org.id, items);
      return items.length;
    });
  }

  /** The person's manager, else the team's leads, else HR (same rule as timesheet approval). */
  private async reviewersOf(orgId: string, userId: string): Promise<string[]> {
    return await this.prisma.runWithTenantContext(orgId, (db) => approversFor(db, userId));
  }

  /** Once per org-local day, after 00:30: close yesterday (daily records + schedule compliance). */
  async attendanceDailyClose(now: Date = new Date()): Promise<number> {
    return await this.perOrg('attendance-daily-close', async (org) => {
      const localTime = Number(new Intl.DateTimeFormat('en-GB', { timeZone: org.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .format(now).replace(':', ''));
      if (localTime < 30) return 0;
      const yesterday = addDaysIso(localDate(now, org.timezone), -1);
      const first = await this.prisma.runWithTenantContext(org.id, (db) => this.onceFor(db, org.id, 'attendance-daily-close', yesterday));
      if (!first) return 0;
      await this.attendance.runDailyCloseJob(org.id, yesterday);
      return 1;
    });
  }

  /** FR-NOTIF-004: emails held back by quiet hours whose window has ended. */
  async deferredEmails(now: Date = new Date()): Promise<number> {
    return await this.perOrg('deferred-emails', (org) => this.notifications.dispatchDue(org.id, now));
  }

  /**
   * Once per org-local day: drop raw presence events and notifications older than the
   * organisation's retention settings (FR-ADM-004; presence defaults to the notice's 90 days).
   */
  async presenceRetention(now: Date = new Date()): Promise<number> {
    return await this.perOrg('presence-retention', async (org) => {
      const day = localDate(now, org.timezone);
      const first = await this.prisma.runWithTenantContext(org.id, (db) => this.onceFor(db, org.id, 'presence-retention', day));
      if (!first) return 0;
      const presence = await this.attendanceRepo.cleanupOldPresenceEvents(org.id, new Date(now.getTime() - org.retention_presence_days * 86_400_000));
      const notifications = await this.attendanceRepo.cleanupOldNotifications(org.id, new Date(now.getTime() - org.retention_notifications_days * 86_400_000));
      return presence + notifications;
    });
  }
}
