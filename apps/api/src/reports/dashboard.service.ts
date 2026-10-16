import { Injectable } from '@nestjs/common';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { PrismaService } from '../common/prisma.service.ts';
import { AttendanceState } from '../../../../packages/shared/src/attendance/types.ts';
import type { WorkScheduleDay } from '../../../../packages/shared/src/attendance/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import type { Dashboard } from '../../../../packages/shared/src/reports/types.ts';
import { reportScope, scopeSql, USER_REF_SELECT, userRef } from './report-scope.ts';

const EXPIRY_WINDOW_DAYS = 30;
const LIST_LIMIT = 20;
const BREAK_STATES = Object.values(AttendanceState).filter((s) => /BREAK|PAUSE/i.test(s));

interface Ref { user_id: string; display_name: string | null; email: string; team_name: string | null }

/**
 * FR-REP-001: what a manager needs at a glance, for the people in their scope (FR-REP-008).
 * "Today" is the organisation's calendar day; lateness uses the same schedule precedence as
 * the daily close (person, then team, then organisation schedule).
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async dashboard(user: AuthenticatedUser, now: Date = new Date()): Promise<Dashboard> {
    const scope = reportScope(user);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const tz = (await db.query<{ timezone: string }>(`SELECT timezone FROM organizations WHERE id = $1`, [user.orgId])).rows[0]!.timezone;
      const today = formatInTimeZone(now, tz, 'yyyy-MM-dd');
      const isoDow = String(((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7) + 1); // 1 = Monday

      const p: unknown[] = [user.orgId];
      const scoped = `SELECT u.id, u.team_id FROM users u WHERE u.status = 'ACTIVE' AND ${scopeSql(user, scope, p)}`;
      const people = (await db.query<{ id: string }>(scoped, p)).rows;
      const ids = people.map((r) => r.id);

      // ---- today's attendance
      const sessions = await db.query<{ user_id: string; first_in: Date; open: boolean; on_break: boolean }>(
        `SELECT s.user_id, min(s.clock_in_at) AS first_in,
                bool_or(s.status = 'OPEN') AS open,
                bool_or(s.status = 'OPEN' AND s.current_state = ANY($3::text[])) AS on_break
         FROM attendance_sessions s
         WHERE s.org_id = $1 AND s.work_date = $2 AND s.status NOT IN ('CANCELLED', 'ADJUSTED') AND s.user_id = ANY($4::uuid[])
         GROUP BY s.user_id`,
        [user.orgId, today, BREAK_STATES, ids],
      );
      const off = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM attendance_daily d WHERE d.org_id = $1 AND d.work_date = $2 AND d.user_id = ANY($3::uuid[]) AND d.day_status IN ('LEAVE', 'HOLIDAY', 'REST_DAY')`,
        [user.orgId, today, ids],
      );
      const working = sessions.rows.filter((s) => s.open && !s.on_break).length;
      const onBreak = sessions.rows.filter((s) => s.open && s.on_break).length;
      const finished = sessions.rows.filter((s) => !s.open).length;
      const onLeaveOrOff = off.rows[0]!.n;

      // ---- late arrivals (schedule precedence as in findWorkScheduleForUser)
      const late = await db.query<Ref & { first_in: Date; days: Record<string, WorkScheduleDay> | null; grace_minutes: number | null; flexible: boolean | null }>(
        `SELECT ${USER_REF_SELECT()}, s.first_in, ws.days, ws.grace_minutes, ws.flexible
         FROM (SELECT user_id, min(clock_in_at) AS first_in FROM attendance_sessions
               WHERE org_id = $1 AND work_date = $2 AND status NOT IN ('CANCELLED', 'ADJUSTED') AND user_id = ANY($3::uuid[]) GROUP BY user_id) s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN teams t ON t.id = u.team_id
         LEFT JOIN LATERAL (
           SELECT ws.days, ws.grace_minutes, ws.flexible FROM work_schedules ws
           WHERE ws.org_id = $1 AND (ws.user_id = u.id OR (ws.team_id IS NOT NULL AND ws.team_id = u.team_id) OR (ws.user_id IS NULL AND ws.team_id IS NULL))
           ORDER BY ws.user_id NULLS LAST, ws.team_id NULLS LAST LIMIT 1) ws ON TRUE`,
        [user.orgId, today, ids],
      );
      const lateArrivals: Dashboard['lateArrivals'] = [];
      for (const r of late.rows) {
        const day = r.days?.[isoDow];
        if (!day?.start || r.flexible) continue;
        const expected = fromZonedTime(`${today}T${day.start}:00`, tz);
        const lateMinutes = Math.floor((r.first_in.getTime() - expected.getTime()) / 60_000) - (r.grace_minutes ?? 10);
        if (lateMinutes > 0) lateArrivals.push({ user: userRef(r), clockInAt: r.first_in.toISOString(), expectedStart: day.start, lateMinutes });
      }
      lateArrivals.sort((a, b) => b.lateMinutes - a.lateMinutes);

      // ---- approvals waiting
      const ts = await db.query<{ n: number; oldest: Date | null }>(
        `SELECT count(*)::int AS n, min(ts.submitted_at) AS oldest FROM timesheets ts WHERE ts.org_id = $1 AND ts.status = 'SUBMITTED' AND ts.user_id = ANY($2::uuid[])`,
        [user.orgId, ids],
      );
      const corr = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM attendance_corrections c WHERE c.org_id = $1 AND c.status = 'PENDING' AND c.user_id = ANY($2::uuid[])`,
        [user.orgId, ids],
      );

      // ---- overdue tasks
      const overdue = await db.query<Ref & { id: string; title: string; due_date: string; project_name: string | null; total: number }>(
        `SELECT tk.id, tk.title, to_char(tk.due_date, 'YYYY-MM-DD') AS due_date, pr.name AS project_name, ${USER_REF_SELECT()}, count(*) OVER () AS total
         FROM tasks tk JOIN users u ON u.id = tk.assignee_id LEFT JOIN teams t ON t.id = u.team_id LEFT JOIN projects pr ON pr.id = tk.project_id
         WHERE tk.org_id = $1 AND tk.deleted_at IS NULL AND tk.status <> 'DONE' AND tk.due_date < $2::date AND tk.assignee_id = ANY($3::uuid[])
         ORDER BY tk.due_date, tk.title LIMIT ${LIST_LIMIT}`,
        [user.orgId, today, ids],
      );
      const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

      // ---- expiring documents and contracts (confidential titles never shown)
      const expiring = await db.query<Ref & { kind: 'DOCUMENT' | 'CONTRACT'; id: string; title: string; expires_on: string; has_user: boolean }>(
        `SELECT 'DOCUMENT' AS kind, d.id, CASE WHEN d.confidentiality = 'NORMAL' THEN COALESCE(d.title, '(untitled)') ELSE '(confidential)' END AS title,
                to_char(d.expires_at, 'YYYY-MM-DD') AS expires_on, ${USER_REF_SELECT()}, true AS has_user
         FROM documents d JOIN users u ON u.id = COALESCE(d.linked_user_id, d.owner_id) LEFT JOIN teams t ON t.id = u.team_id
         WHERE d.org_id = $1 AND d.deleted_at IS NULL AND d.expires_at BETWEEN $2::date AND $2::date + ${EXPIRY_WINDOW_DAYS} AND u.id = ANY($3::uuid[])
         UNION ALL
         SELECT 'CONTRACT', c.id, c.title, to_char(c.end_date, 'YYYY-MM-DD'), ${USER_REF_SELECT()}, true
         FROM contracts c JOIN users u ON u.id = c.user_id LEFT JOIN teams t ON t.id = u.team_id
         WHERE c.org_id = $1 AND c.end_date IS NOT NULL AND c.end_date BETWEEN $2::date AND $2::date + GREATEST(c.renewal_notice_days, ${EXPIRY_WINDOW_DAYS}) AND u.id = ANY($3::uuid[])
         ORDER BY expires_on, title LIMIT ${LIST_LIMIT}`,
        [user.orgId, today, ids],
      );

      return {
        today,
        scope,
        peopleInScope: ids.length,
        attendance: { working, onBreak, finished, notYetIn: Math.max(0, ids.length - sessions.rows.length - onLeaveOrOff), onLeaveOrOff },
        lateArrivals,
        pendingApprovals: { timesheets: ts.rows[0]!.n, corrections: corr.rows[0]!.n, oldestSubmittedAt: ts.rows[0]!.oldest?.toISOString() ?? null },
        overdueTasks: overdue.rows.map((r) => ({ id: r.id, title: r.title, dueDate: r.due_date, daysOverdue: dayDiff(today, r.due_date), assignee: userRef(r), projectName: r.project_name })),
        overdueTaskCount: Number(overdue.rows[0]?.total ?? 0),
        expiring: expiring.rows.map((r) => ({ kind: r.kind, id: r.id, title: r.title, user: r.has_user ? userRef(r) : null, expiresOn: r.expires_on, daysLeft: dayDiff(r.expires_on, today) })),
      };
    });
  }
}
