/**
 * Planning E2E: Today + daily plan + EOD report (FR-TASK-003), weekly planner (FR-TASK-004),
 * team workload and saved views (FR-TASK-005), RLS on the planning tables.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { formatInTimeZone } from 'date-fns-tz';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { addDaysIso, nextWorkDay, weekStartOf } from '../src/planning/planning-rules.ts';
import { TaskActivityListSchema, TaskDetailSchema } from '../../../packages/shared/src/tasks/types.ts';
import type { TaskDetail } from '../../../packages/shared/src/tasks/types.ts';
import { SavedViewListSchema, TodaySchema, WeekSchema, WorkloadSchema } from '../../../packages/shared/src/tasks/planning.ts';

const ORG = '22220000-0000-4000-8000-000000000001';
const TEAM = '22220000-0000-4000-8000-000000000101';
const PASSWORD = 'ComplexPassword123!';
const U = {
  lead: { id: '22220000-0000-4000-8000-000000000011', email: 'lead@plan.test', role: 'TEAM_LEAD', team: TEAM as string | null },
  emp: { id: '22220000-0000-4000-8000-000000000012', email: 'emp@plan.test', role: 'EMPLOYEE', team: TEAM as string | null },
  other: { id: '22220000-0000-4000-8000-000000000013', email: 'other@plan.test', role: 'EMPLOYEE', team: null as string | null },
} as const;
type Who = keyof typeof U;

describe('Planning API (FR-TASK-003/004/005)', { concurrency: false }, () => {
  let app: INestApplication;
  let base: string;
  let adminPool: pg.Pool;
  const tokens = {} as Record<Who, string>;
  const today = formatInTimeZone(new Date(), 'Asia/Colombo', 'yyyy-MM-dd');
  const yesterday = addDaysIso(today, -1);
  const tomorrow = addDaysIso(today, 1);
  const next = nextWorkDay(today, new Set([1, 2, 3, 4, 5]));
  const t: Record<string, TaskDetail> = {};

  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  async function ok<T>(res: Response, status: number, schema?: { parse: (v: unknown) => T }): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return schema ? schema.parse(JSON.parse(text)) : (JSON.parse(text || 'null') as T);
  }

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    adminPool = new pg.Pool({
      host: process.env.PGHOST || 'localhost',
      port: Number(process.env.PGPORT || 5433),
      database: process.env.PGDATABASE || 'hrvo_dev',
      user: process.env.PGADMIN_USER || 'postgres',
      password: process.env.PGADMIN_PASSWORD || 'postgres',
    });
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Plan Ltd', 'plan-e2e', 'Asia/Colombo')`, [ORG]);
    await adminPool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Ops')`, [TEAM, ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const [k, u] of Object.entries(U)) {
      await adminPool.query(
        `INSERT INTO users (id, org_id, email, display_name, role, team_id, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`,
        [u.id, ORG, u.email, k, u.role, u.team, hash],
      );
    }
    await adminPool.query(`UPDATE users SET manager_id = $1 WHERE id = $2`, [U.lead.id, U.emp.id]);

    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(3071);
    base = 'http://localhost:3071';
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: U[who].email, password: PASSWORD }),
      });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
    }
    const mk = async (key: string, body: Record<string, unknown>) => {
      t[key] = await ok(await api('lead', '/tasks', { method: 'POST', body: { assigneeId: U.emp.id, ...body } }), 201, TaskDetailSchema);
    };
    await mk('planned', { title: 'Planned today', plannedDate: today, estimateMinutes: 90 });
    await mk('due', { title: 'Due today', dueDate: today, estimateMinutes: 30 });
    await mk('overdue', { title: 'Overdue', dueDate: yesterday });
    await mk('carried', { title: 'Planned yesterday', plannedDate: yesterday });
    await mk('future', { title: 'Planned tomorrow', plannedDate: tomorrow, estimateMinutes: 60 });
    await mk('backlog', { title: 'No date yet' });
    await mk('done', { title: 'Already done', plannedDate: today });
    await ok(await api('emp', `/tasks/${t.done!.id}`, { method: 'PATCH', body: { version: t.done!.version, status: 'DONE' } }), 200);
    await ok(await api('other', '/tasks', { method: 'POST', body: { title: 'Not mine', plannedDate: today } }), 201);
  });

  after(async () => {
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.end();
  });

  it('Today lists planned, due, overdue and carried-over tasks with reasons; not future or done', async () => {
    const day = await ok(await api('emp', '/planning/today'), 200, TodaySchema);
    assert.equal(day.date, today);
    const reasons = Object.fromEntries(day.items.map((i) => [i.task.title, i.reasons]));
    assert.deepEqual(reasons['Planned today'], ['PLANNED']);
    assert.deepEqual(reasons['Due today'], ['DUE_TODAY']);
    assert.deepEqual(reasons['Overdue'], ['OVERDUE']);
    assert.deepEqual(reasons['Planned yesterday'], ['CARRIED_OVER']);
    assert.equal(reasons['Planned tomorrow'], undefined);
    assert.equal(reasons['Already done'], undefined);
    assert.equal(reasons['Not mine'], undefined);
    assert.deepEqual(day.doneToday.map((x) => x.title), ['Already done']);
    assert.equal(day.plan, null);
    assert.equal(day.nextWorkDay, next);
  });

  it('confirming the plan orders it, plans the tasks for today and logs the move; only own tasks', async () => {
    const otherTask = await ok(await api('other', '/tasks?scope=mine'), 200) as Array<{ id: string }>;
    await ok(await api('emp', `/planning/daily/${today}/confirm`, { method: 'POST', body: { goals: 'x', taskIds: [otherTask[0]!.id] } }), 400);

    const day = await ok(
      await api('emp', `/planning/daily/${today}/confirm`, { method: 'POST', body: { goals: 'Clear the overdue item first', taskIds: [t.overdue!.id, t.planned!.id] } }),
      201,
      TodaySchema,
    );
    assert.ok(day.plan?.confirmedAt);
    assert.equal(day.plan?.goals, 'Clear the overdue item first');
    assert.deepEqual(day.items.slice(0, 2).map((i) => i.task.title), ['Overdue', 'Planned today']);
    assert.ok(day.items[0]!.reasons.includes('IN_PLAN'));
    const overdue = day.items.find((i) => i.task.id === t.overdue!.id)!;
    assert.equal(overdue.task.plannedDate, today);
    const activity = await ok(await api('emp', `/tasks/${t.overdue!.id}/activity`), 200, TaskActivityListSchema);
    assert.ok(activity.some((a) => a.data.reason === 'daily plan'));
  });

  it('the end-of-day report records done/blocked/tomorrow and carries unfinished plan items over', async () => {
    const planned = await ok(await api('emp', `/tasks/${t.planned!.id}`), 200, TaskDetailSchema);
    await ok(await api('emp', `/tasks/${planned.id}`, { method: 'PATCH', body: { version: planned.version, status: 'DONE' } }), 200);

    await ok(await api('emp', `/planning/daily/${today}/report`, { method: 'POST', body: { summary: '' } }), 400);
    await ok(await api('emp', `/planning/daily/${tomorrow}/report`, { method: 'POST', body: { summary: 'Too early' } }), 400);
    const day = await ok(
      await api('emp', `/planning/daily/${today}/report`, { method: 'POST', body: { summary: 'Shipped the planned task', blockers: 'Waiting on VAT rules', tomorrow: 'Finish overdue' } }),
      201,
      TodaySchema,
    );
    assert.ok(day.plan?.submittedAt);
    assert.equal(day.plan?.blockers, 'Waiting on VAT rules');
    const status = Object.fromEntries(day.items.map((i) => [i.task.title, i.planStatus]));
    assert.equal(status['Planned today'], 'DONE');
    assert.equal(status['Overdue'], 'CARRIED_OVER');
    const carried = await ok(await api('emp', `/tasks/${t.overdue!.id}`), 200, TaskDetailSchema);
    assert.equal(carried.plannedDate, next);
  });

  it('weekly planner: days, backlog, carry-over, capacity from the work schedule, goals', async () => {
    const start = weekStartOf(today);
    let week = await ok(await api('emp', '/planning/week'), 200, WeekSchema);
    assert.equal(week.weekStart, start);
    assert.equal(week.capacityMinutes, 40 * 60);
    assert.deepEqual(week.workingDays, [1, 2, 3, 4, 5]);
    assert.ok(week.backlog.some((x) => x.title === 'No date yet'));
    const allPlanned = week.days.flatMap((d) => d.tasks.map((x) => x.title));
    if (tomorrow < addDaysIso(start, 7)) assert.ok(allPlanned.includes('Planned tomorrow'));
    assert.equal(week.scheduledMinutes, week.days.reduce((s, d) => s + d.scheduledMinutes, 0));

    // A user schedule changes capacity and working days
    await adminPool.query(
      `INSERT INTO work_schedules (org_id, user_id, days, effective_from) VALUES ($1, $2, $3::jsonb, $4::date)`,
      [ORG, U.emp.id, JSON.stringify({ '1': { start: '09:00', end: '17:00', expectedHours: 8 }, '3': { start: '09:00', end: '13:00', expectedHours: 4 } }), addDaysIso(start, -7)],
    );
    week = await ok(await api('emp', '/planning/week'), 200, WeekSchema);
    assert.equal(week.capacityMinutes, 12 * 60);
    assert.deepEqual(week.workingDays, [1, 3]);

    await ok(await api('emp', `/planning/week/${addDaysIso(start, 1)}`, { method: 'PUT', body: { goals: [] } }), 400);
    const goalId = '22220000-0000-4000-8000-0000000000aa';
    week = await ok(
      await api('emp', `/planning/week/${start}`, { method: 'PUT', body: { goals: [{ id: goalId, text: 'Close the VAT topic', done: false }], capacityMinutes: 1800 } }),
      200,
      WeekSchema,
    );
    assert.deepEqual(week.goals, [{ id: goalId, text: 'Close the VAT topic', done: false }]);
    assert.equal(week.capacityMinutes, 1800);
  });

  it('team workload: leads see their team; employees cannot', async () => {
    await ok(await api('emp', '/planning/workload'), 403);
    const wl = await ok(await api('lead', '/planning/workload'), 200, WorkloadSchema);
    const ids = wl.people.map((p) => p.user.id);
    assert.ok(ids.includes(U.emp.id) && ids.includes(U.lead.id));
    assert.ok(!ids.includes(U.other.id));
    const emp = wl.people.find((p) => p.user.id === U.emp.id)!;
    assert.equal(emp.eodSubmittedToday, true);
    assert.ok(emp.openTasks >= 4);
    assert.equal(emp.perDayMinutes.reduce((a, b) => a + b, 0), emp.scheduledMinutes);
  });

  it('saved views are per user; team views need the team permission', async () => {
    let views = await ok(await api('emp', '/task-views', { method: 'POST', body: { name: 'Urgent', filters: { scope: 'mine', priority: 'URGENT' } } }), 201, SavedViewListSchema);
    assert.deepEqual(views.map((v) => v.name), ['Urgent']);
    await ok(await api('emp', '/task-views', { method: 'POST', body: { name: 'Team', filters: { scope: 'team' } } }), 403);
    assert.deepEqual(await ok(await api('lead', '/task-views'), 200, SavedViewListSchema), []);
    views = await ok(await api('emp', `/task-views/${views[0]!.id}`, { method: 'DELETE' }), 200, SavedViewListSchema);
    assert.deepEqual(views, []);
  });

  it('planning tables are invisible without tenant context (RLS)', async () => {
    const appPool = new pg.Pool({
      host: process.env.PGHOST || 'localhost',
      port: Number(process.env.PGPORT || 5433),
      database: process.env.PGDATABASE || 'hrvo_dev',
      user: process.env.PGUSER || 'hrvo_app',
      password: process.env.PGPASSWORD || 'hrvo_app_pass',
    });
    try {
      for (const table of ['daily_plans', 'daily_plan_items', 'weekly_plans', 'task_saved_views']) {
        assert.equal((await appPool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, table);
      }
    } finally {
      await appPool.end();
    }
  });
});
