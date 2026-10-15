import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { formatInTimeZone } from 'date-fns-tz';
import { PrismaService } from '../common/prisma.service.ts';
import { hasPermission, Permission } from '../../../../packages/shared/src/auth/types.ts';
import type {
  ConfirmPlanDto,
  DailyPlan,
  EodReportDto,
  SavedView,
  SavedViewDto,
  Today,
  TodayItem,
  Week,
  WeeklyGoal,
  WeeklyPlanDto,
  Workload,
} from '../../../../packages/shared/src/tasks/planning.ts';
import type { TaskSummary } from '../../../../packages/shared/src/tasks/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { ACTUAL_TIME_PROVIDER } from '../tasks/actual-time.ts';
import type { ActualTimeProvider } from '../tasks/actual-time.ts';
import { SUMMARY_COLUMNS, SUMMARY_FROM, mapSummary, toIso, userRef } from '../tasks/tasks.sql.ts';
import {
  addDaysIso,
  capacityFromSchedule,
  nextWorkDay,
  todayReasons,
  weekStartOf,
  workingDaysFromSchedule,
} from './planning-rules.ts';
import type { TodayReason } from './planning-rules.ts';

type Client = pg.PoolClient;
type ScheduleDays = Record<string, { expectedHours: number }> | null;

const REASON_ORDER: Record<TodayReason, number> = { IN_PLAN: 0, OVERDUE: 1, DUE_TODAY: 2, PLANNED: 3, CARRIED_OVER: 4 };

@Injectable()
export class PlanningService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ACTUAL_TIME_PROVIDER) private readonly actualTime: ActualTimeProvider,
  ) {}

  // ------------------------------------------------------------- shared helpers

  /** Today's date in the organisation's timezone (SRS 2.5: day boundaries use the org timezone). */
  async orgToday(db: Client, orgId: string, now: Date = new Date()): Promise<{ today: string; timezone: string }> {
    const res = await db.query<{ timezone: string }>(`SELECT timezone FROM organizations WHERE id = $1`, [orgId]);
    const timezone = res.rows[0]?.timezone ?? 'Asia/Colombo';
    return { today: formatInTimeZone(now, timezone, 'yyyy-MM-dd'), timezone };
  }

  /** Effective work schedule days for a user (user schedule wins over team schedule). */
  async scheduleDays(db: Client, orgId: string, userId: string, onDate: string): Promise<ScheduleDays> {
    const res = await db.query<{ days: ScheduleDays }>(
      `SELECT ws.days FROM work_schedules ws
       LEFT JOIN users u ON u.id = $2
       WHERE ws.org_id = $1 AND (ws.user_id = $2 OR (ws.user_id IS NULL AND ws.team_id = u.team_id))
         AND ws.effective_from <= $3::date AND (ws.effective_to IS NULL OR ws.effective_to >= $3::date)
       ORDER BY (ws.user_id IS NOT NULL) DESC, ws.effective_from DESC LIMIT 1`,
      [orgId, userId, onDate],
    );
    return res.rows[0]?.days ?? null;
  }

  private async summaries(db: Client, orgId: string, where: string, params: unknown[]): Promise<TaskSummary[]> {
    const res = await db.query(
      `SELECT ${SUMMARY_COLUMNS} ${SUMMARY_FROM}
       WHERE t.org_id = $1 AND t.deleted_at IS NULL AND ${where}
       ORDER BY CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, t.created_at`,
      [orgId, ...params],
    );
    const actual = await this.actualTime.actualMinutes(orgId, res.rows.map((r) => r.id as string));
    return res.rows.map((r) => mapSummary(r, actual.get(r.id) ?? null));
  }

  private async planRow(db: Client, orgId: string, userId: string, date: string): Promise<pg.QueryResultRow | null> {
    const res = await db.query(
      `SELECT id, to_char(plan_date, 'YYYY-MM-DD') AS plan_date, goals, confirmed_at, eod_summary, blockers, tomorrow_plan, submitted_at
       FROM daily_plans WHERE org_id = $1 AND user_id = $2 AND plan_date = $3::date`,
      [orgId, userId, date],
    );
    return res.rows[0] ?? null;
  }

  private mapPlan(r: pg.QueryResultRow | null): DailyPlan | null {
    if (!r) return null;
    return {
      planDate: r.plan_date,
      goals: r.goals,
      confirmedAt: toIso(r.confirmed_at),
      eodSummary: r.eod_summary ?? null,
      blockers: r.blockers ?? null,
      tomorrowPlan: r.tomorrow_plan ?? null,
      submittedAt: toIso(r.submitted_at),
    };
  }

  private async logPlannedMove(db: Client, orgId: string, taskId: string, actorId: string, from: string | null, to: string, reason: string) {
    await db.query(
      `INSERT INTO task_activity (org_id, task_id, actor_id, type, data) VALUES ($1, $2, $3, 'UPDATED', $4::jsonb)`,
      [orgId, taskId, actorId, JSON.stringify({ changes: { plannedDate: { from, to } }, reason })],
    );
  }

  // ------------------------------------------------------------- Today (FR-TASK-003)

  async today(user: AuthenticatedUser, date?: string): Promise<Today> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => this.todayIn(db, user, date));
  }

  private async todayIn(db: Client, user: AuthenticatedUser, date?: string): Promise<Today> {
    const { today, timezone } = await this.orgToday(db, user.orgId);
    const day = date ?? today;
    const plan = await this.planRow(db, user.orgId, user.id, day);
    const planItems = plan
      ? (await db.query<{ task_id: string; status: string; sort_order: number }>(
          `SELECT task_id, status, sort_order FROM daily_plan_items WHERE plan_id = $1`, [plan.id],
        )).rows
      : [];
    const inPlan = new Map(planItems.map((i) => [i.task_id, i]));

    const candidates = await this.summaries(
      db, user.orgId,
      `t.assignee_id = $2 AND (t.id = ANY($4::uuid[]) OR (t.status <> 'DONE' AND (t.planned_date <= $3::date OR t.due_date <= $3::date)))`,
      [user.id, day, [...inPlan.keys()]],
    );
    const items: TodayItem[] = candidates
      .map((task) => ({
        task,
        reasons: todayReasons(task, day, inPlan.has(task.id)),
        planStatus: (inPlan.get(task.id)?.status as TodayItem['planStatus']) ?? null,
      }))
      .filter((i) => i.reasons.length > 0)
      .sort((a, b) => {
        const pa = inPlan.get(a.task.id)?.sort_order ?? 1e6;
        const pb = inPlan.get(b.task.id)?.sort_order ?? 1e6;
        return pa - pb || REASON_ORDER[a.reasons[0]!] - REASON_ORDER[b.reasons[0]!];
      });

    const doneToday = await this.summaries(
      db, user.orgId,
      `t.assignee_id = $2 AND t.status = 'DONE' AND (t.completed_at AT TIME ZONE $4)::date = $3::date`,
      [user.id, day, timezone],
    );
    const workingDays = workingDaysFromSchedule(await this.scheduleDays(db, user.orgId, user.id, day));
    return { date: day, plan: this.mapPlan(plan), items, doneToday, nextWorkDay: nextWorkDay(day, workingDays) };
  }

  /** Start-of-day confirmation: chosen tasks are planned for the day, in order. */
  async confirmPlan(user: AuthenticatedUser, date: string, dto: ConfirmPlanDto): Promise<Today> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const ids = [...new Set(dto.taskIds)];
      if (ids.length > 0) {
        const own = await db.query<{ id: string; planned: string | null }>(
          `SELECT id, to_char(planned_date, 'YYYY-MM-DD') AS planned FROM tasks
           WHERE org_id = $1 AND id = ANY($2::uuid[]) AND assignee_id = $3 AND deleted_at IS NULL FOR UPDATE`,
          [user.orgId, ids, user.id],
        );
        if (own.rows.length !== ids.length) throw new BadRequestException('You can only plan tasks assigned to you');
        for (const t of own.rows) {
          if (t.planned !== date) {
            await db.query(`UPDATE tasks SET planned_date = $2::date, version = version + 1, updated_at = now() WHERE id = $1`, [t.id, date]);
            await this.logPlannedMove(db, user.orgId, t.id, user.id, t.planned, date, 'daily plan');
          }
        }
      }
      const plan = await db.query<{ id: string }>(
        `INSERT INTO daily_plans (org_id, user_id, plan_date, goals, confirmed_at)
         VALUES ($1, $2, $3::date, $4, now())
         ON CONFLICT (user_id, plan_date) DO UPDATE SET goals = EXCLUDED.goals, confirmed_at = now(), updated_at = now()
         RETURNING id`,
        [user.orgId, user.id, date, dto.goals],
      );
      const planId = plan.rows[0]!.id;
      await db.query(`DELETE FROM daily_plan_items WHERE plan_id = $1 AND NOT (task_id = ANY($2::uuid[]))`, [planId, ids]);
      for (const [i, taskId] of ids.entries()) {
        await db.query(
          `INSERT INTO daily_plan_items (org_id, plan_id, task_id, sort_order) VALUES ($1, $2, $3, $4)
           ON CONFLICT (plan_id, task_id) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
          [user.orgId, planId, taskId, i],
        );
      }
      return await this.todayIn(db, user, date);
    });
  }

  /**
   * End-of-day report (done / blocked / tomorrow). Planned items that are not done are carried
   * over to the next working day (FR-TASK-004 automatic carry-over).
   */
  async submitReport(user: AuthenticatedUser, date: string, dto: EodReportDto): Promise<Today> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const { today } = await this.orgToday(db, user.orgId);
      if (date > today) throw new BadRequestException('You cannot report on a future day');
      const plan = await db.query<{ id: string }>(
        `INSERT INTO daily_plans (org_id, user_id, plan_date, eod_summary, blockers, tomorrow_plan, submitted_at)
         VALUES ($1, $2, $3::date, $4, $5, $6, now())
         ON CONFLICT (user_id, plan_date) DO UPDATE SET eod_summary = EXCLUDED.eod_summary, blockers = EXCLUDED.blockers,
           tomorrow_plan = EXCLUDED.tomorrow_plan, submitted_at = now(), updated_at = now()
         RETURNING id`,
        [user.orgId, user.id, date, dto.summary, dto.blockers, dto.tomorrow],
      );
      const planId = plan.rows[0]!.id;
      const target = nextWorkDay(date, workingDaysFromSchedule(await this.scheduleDays(db, user.orgId, user.id, date)));
      const items = await db.query<{ task_id: string; status: string; planned: string | null }>(
        `SELECT i.task_id, t.status, to_char(t.planned_date, 'YYYY-MM-DD') AS planned
         FROM daily_plan_items i JOIN tasks t ON t.id = i.task_id
         WHERE i.plan_id = $1 AND t.deleted_at IS NULL FOR UPDATE OF t`,
        [planId],
      );
      for (const it of items.rows) {
        if (it.status === 'DONE') {
          await db.query(`UPDATE daily_plan_items SET status = 'DONE', carried_to_date = NULL WHERE plan_id = $1 AND task_id = $2`, [planId, it.task_id]);
        } else {
          await db.query(
            `UPDATE daily_plan_items SET status = 'CARRIED_OVER', carried_to_date = $3::date WHERE plan_id = $1 AND task_id = $2`,
            [planId, it.task_id, target],
          );
          if (it.planned === null || it.planned <= date) {
            await db.query(`UPDATE tasks SET planned_date = $2::date, version = version + 1, updated_at = now() WHERE id = $1`, [it.task_id, target]);
            await this.logPlannedMove(db, user.orgId, it.task_id, user.id, it.planned, target, 'carried over at end of day');
          }
        }
      }
      return await this.todayIn(db, user, date);
    });
  }

  /**
   * Automatic carry-over (used by the daily job): open tasks of `userId` planned before `today`
   * move to `today`. Returns the number of tasks moved.
   */
  async carryOverForUser(db: Client, orgId: string, userId: string, today: string): Promise<number> {
    const moved = await db.query<{ id: string; planned: string }>(
      `UPDATE tasks t SET planned_date = $3::date, version = t.version + 1, updated_at = now()
       FROM (SELECT id, to_char(planned_date, 'YYYY-MM-DD') AS planned FROM tasks
             WHERE org_id = $1 AND assignee_id = $2 AND deleted_at IS NULL AND status <> 'DONE' AND planned_date < $3::date
             FOR UPDATE) old
       WHERE t.id = old.id
       RETURNING t.id, old.planned`,
      [orgId, userId, today],
    );
    for (const r of moved.rows) {
      await this.logPlannedMove(db, orgId, r.id, userId, r.planned, today, 'automatic carry-over');
    }
    return moved.rowCount ?? 0;
  }

  // ------------------------------------------------------------- Week (FR-TASK-004)

  async week(user: AuthenticatedUser, start?: string): Promise<Week> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => this.weekIn(db, user, start));
  }

  private async weekIn(db: Client, user: AuthenticatedUser, start?: string): Promise<Week> {
    const { today } = await this.orgToday(db, user.orgId);
    const weekStart = start ?? weekStartOf(today);
    if (weekStartOf(weekStart) !== weekStart) throw new BadRequestException('The week must start on a Monday');
    const weekEnd = addDaysIso(weekStart, 6);

    const planned = await this.summaries(db, user.orgId, `t.assignee_id = $2 AND t.planned_date BETWEEN $3::date AND $4::date`, [user.id, weekStart, weekEnd]);
    const carriedOver = await this.summaries(db, user.orgId, `t.assignee_id = $2 AND t.status <> 'DONE' AND t.planned_date < $3::date`, [user.id, weekStart]);
    const backlog = (await this.summaries(db, user.orgId, `t.assignee_id = $2 AND t.status <> 'DONE' AND t.planned_date IS NULL`, [user.id])).slice(0, 100);

    const days = Array.from({ length: 7 }, (_, i) => {
      const date = addDaysIso(weekStart, i);
      const tasks = planned.filter((t) => t.plannedDate === date);
      return { date, tasks, scheduledMinutes: tasks.reduce((s, t) => s + (t.estimateMinutes ?? 0), 0) };
    });
    const plan = await db.query<{ goals: WeeklyGoal[]; capacity_minutes: number | null }>(
      `SELECT goals, capacity_minutes FROM weekly_plans WHERE org_id = $1 AND user_id = $2 AND week_start = $3::date`,
      [user.orgId, user.id, weekStart],
    );
    const schedule = await this.scheduleDays(db, user.orgId, user.id, weekStart);
    return {
      weekStart,
      days,
      backlog,
      carriedOver,
      goals: plan.rows[0]?.goals ?? [],
      capacityMinutes: plan.rows[0]?.capacity_minutes ?? capacityFromSchedule(schedule),
      scheduledMinutes: days.reduce((s, d) => s + d.scheduledMinutes, 0),
      workingDays: [...workingDaysFromSchedule(schedule)].sort(),
    };
  }

  async saveWeek(user: AuthenticatedUser, start: string, dto: WeeklyPlanDto): Promise<Week> {
    if (weekStartOf(start) !== start) throw new BadRequestException('The week must start on a Monday');
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(
        `INSERT INTO weekly_plans (org_id, user_id, week_start, goals, capacity_minutes, submitted_at)
         VALUES ($1, $2, $3::date, $4::jsonb, $5, now())
         ON CONFLICT (user_id, week_start) DO UPDATE SET goals = EXCLUDED.goals,
           capacity_minutes = COALESCE(EXCLUDED.capacity_minutes, weekly_plans.capacity_minutes), submitted_at = now(), updated_at = now()`,
        [user.orgId, user.id, start, JSON.stringify(dto.goals), dto.capacityMinutes ?? null],
      );
      return await this.weekIn(db, user, start);
    });
  }

  // ------------------------------------------------------------- Team workload (FR-TASK-005)

  async workload(user: AuthenticatedUser, start?: string, teamId?: string): Promise<Workload> {
    if (!hasPermission(user.role, Permission.TASKS_READ_TEAM)) throw new ForbiddenException('Workload is for team leads, managers and HR');
    const all = hasPermission(user.role, Permission.TASKS_READ_ALL);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const { today } = await this.orgToday(db, user.orgId);
      const weekStart = start ?? weekStartOf(today);
      if (weekStartOf(weekStart) !== weekStart) throw new BadRequestException('The week must start on a Monday');
      const weekEnd = addDaysIso(weekStart, 6);
      const people = await db.query(
        `SELECT u.id, u.display_name, u.email, u.role FROM users u
         WHERE u.org_id = $1 AND u.status = 'ACTIVE'
           AND ($4::boolean OR u.id = $2 OR u.manager_id = $2 OR ($3::uuid IS NOT NULL AND u.team_id = $3::uuid))
           AND ($5::uuid IS NULL OR u.team_id = $5::uuid)
         ORDER BY u.display_name NULLS LAST, u.email`,
        [user.orgId, user.id, user.teamId ?? null, all, teamId ?? null],
      );
      const ids = people.rows.map((p) => p.id as string);
      const stats = await db.query(
        `SELECT t.assignee_id,
                count(*) FILTER (WHERE t.status <> 'DONE')::int AS open_tasks,
                count(*) FILTER (WHERE t.status <> 'DONE' AND t.due_date < $3::date)::int AS overdue,
                count(*) FILTER (WHERE t.acceptance_status = 'PENDING')::int AS pending
         FROM tasks t WHERE t.org_id = $1 AND t.assignee_id = ANY($2::uuid[]) AND t.deleted_at IS NULL
         GROUP BY t.assignee_id`,
        [user.orgId, ids, today],
      );
      const perDay = await db.query(
        `SELECT t.assignee_id, (t.planned_date - $3::date)::int AS idx, COALESCE(sum(t.estimate_minutes), 0)::int AS minutes
         FROM tasks t WHERE t.org_id = $1 AND t.assignee_id = ANY($2::uuid[]) AND t.deleted_at IS NULL
           AND t.planned_date BETWEEN $3::date AND $4::date
         GROUP BY t.assignee_id, t.planned_date`,
        [user.orgId, ids, weekStart, weekEnd],
      );
      const eod = await db.query(
        `SELECT user_id FROM daily_plans WHERE org_id = $1 AND user_id = ANY($2::uuid[]) AND plan_date = $3::date AND submitted_at IS NOT NULL`,
        [user.orgId, ids, today],
      );
      const capacities = await db.query(
        `SELECT user_id, capacity_minutes FROM weekly_plans WHERE org_id = $1 AND user_id = ANY($2::uuid[]) AND week_start = $3::date`,
        [user.orgId, ids, weekStart],
      );
      const statBy = new Map(stats.rows.map((r) => [r.assignee_id as string, r]));
      const eodBy = new Set(eod.rows.map((r) => r.user_id as string));
      const capBy = new Map(capacities.rows.map((r) => [r.user_id as string, r.capacity_minutes as number | null]));
      const result: Workload['people'] = [];
      for (const p of people.rows) {
        const days = [0, 0, 0, 0, 0, 0, 0];
        for (const d of perDay.rows.filter((r) => r.assignee_id === p.id)) days[d.idx as number] = d.minutes as number;
        const s = statBy.get(p.id);
        result.push({
          user: userRef(p.id, p.display_name, p.email, p.role),
          capacityMinutes: capBy.get(p.id) ?? capacityFromSchedule(await this.scheduleDays(db, user.orgId, p.id, weekStart)),
          scheduledMinutes: days.reduce((a, b) => a + b, 0),
          perDayMinutes: days,
          openTasks: s?.open_tasks ?? 0,
          overdueTasks: s?.overdue ?? 0,
          pendingAcceptance: s?.pending ?? 0,
          eodSubmittedToday: eodBy.has(p.id),
        });
      }
      return { weekStart, today, people: result };
    });
  }

  // ------------------------------------------------------------- Saved views (FR-TASK-005)

  async views(user: AuthenticatedUser): Promise<SavedView[]> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const res = await db.query(`SELECT id, name, filters FROM task_saved_views WHERE org_id = $1 AND user_id = $2 ORDER BY name`, [user.orgId, user.id]);
      return res.rows.map((r) => ({ id: r.id, name: r.name, filters: r.filters }));
    });
  }

  async saveView(user: AuthenticatedUser, dto: SavedViewDto): Promise<SavedView[]> {
    if (dto.filters.scope === 'team' && !hasPermission(user.role, Permission.TASKS_READ_TEAM)) {
      throw new ForbiddenException('Team views are for team leads, managers and HR');
    }
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const count = await db.query(`SELECT count(*)::int AS n FROM task_saved_views WHERE org_id = $1 AND user_id = $2`, [user.orgId, user.id]);
      if (count.rows[0]!.n >= 30) throw new ConflictException('You can keep up to 30 saved views');
      await db.query(
        `INSERT INTO task_saved_views (org_id, user_id, name, filters) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (user_id, name) DO UPDATE SET filters = EXCLUDED.filters`,
        [user.orgId, user.id, dto.name, JSON.stringify(dto.filters)],
      );
    });
    return await this.views(user);
  }

  async deleteView(user: AuthenticatedUser, id: string): Promise<SavedView[]> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const res = await db.query(`DELETE FROM task_saved_views WHERE org_id = $1 AND user_id = $2 AND id = $3`, [user.orgId, user.id, id]);
      if (res.rowCount === 0) throw new NotFoundException('Saved view not found');
    });
    return await this.views(user);
  }
}
