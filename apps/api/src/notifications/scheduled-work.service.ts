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

interface OrgRow {
  id: string;
  timezone: string;
  task_acceptance_escalation_hours: number;
}

const PRESENCE_RETENTION_DAYS = 90;

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
              `${hours(s.workedMinutes)} worked, ${hours(s.estimateDoneMinutes)} estimated on completed tasks`,
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
              'Hours worked come from attendance; time per task arrives with timesheets.',
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
    return {
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
      return r.closedCount + r.splitCount;
    });
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

  /** Once per org-local day: drop raw presence events older than the notice's retention period. */
  async presenceRetention(now: Date = new Date()): Promise<number> {
    return await this.perOrg('presence-retention', async (org) => {
      const day = localDate(now, org.timezone);
      const first = await this.prisma.runWithTenantContext(org.id, (db) => this.onceFor(db, org.id, 'presence-retention', day));
      if (!first) return 0;
      return await this.attendanceRepo.cleanupOldPresenceEvents(org.id, new Date(now.getTime() - PRESENCE_RETENTION_DAYS * 86_400_000));
    });
  }
}
