/**
 * ADR 049 §5 (FR-WT-019..021) and defect D5: the work-time report from server records, without
 * double counting task time that ran during a meeting; scope (self, a person in report scope,
 * the team); CSV export audited; insights phrased as planning prompts; the task report's actual
 * time from time entries.
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
import { weekOf, workTimeInsights } from '../src/reports/work-time.service.ts';
import { TaskReportSchema, WorkTimeReportSchema } from '../../../packages/shared/src/reports/types.ts';
import { TaskDetailSchema, TimeEntrySchema } from '../../../packages/shared/src/index.ts';
import { freshCode } from './support/totp.ts';

describe('Work-time rules (ADR 049 §5)', () => {
  it('weeks start on Monday', () => {
    assert.equal(weekOf('2026-11-05'), '2026-11-02');
    assert.equal(weekOf('2026-11-02'), '2026-11-02');
    assert.equal(weekOf('2026-11-08'), '2026-11-02', 'Sunday belongs to the week before');
  });
  it('insights are planning prompts, never ratings of people', () => {
    const lines = workTimeInsights({
      totals: { attendanceMinutes: 600, meetingMinutes: 300, taskMinutes: 200, focusedTaskMinutes: 170, taskDuringMeetingsMinutes: 30, manualMinutes: 100, onsiteMinutes: 0 },
      overEstimate: { completedTasks: 4, completedOverEstimate: 3, tasks: [] },
      categories: [],
    });
    assert.ok(lines.some((l) => l.includes('Meetings took 50%')));
    assert.ok(lines.some((l) => l.includes('3 of 4 completed tasks took longer than estimated')));
    for (const l of lines) assert.doesNotMatch(l, /productiv|lazy|slow|poor|underperform|score/i);
  });
});

const ORG = '3e650000-0000-4000-8000-000000000001';
const TEAM = '3e650000-0000-4000-8000-000000000101';
const TEAM2 = '3e650000-0000-4000-8000-000000000102';
const PROJECT = '3e650000-0000-4000-8000-000000000201';
const PORT = 3065;
const PASSWORD = 'ComplexPassword123!';
const MFA_SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const U = {
  lead: { id: '3e650000-0000-4000-8000-000000000011', email: 'lead@wt.test', role: 'TEAM_LEAD', team: TEAM as string | null },
  emp: { id: '3e650000-0000-4000-8000-000000000012', email: 'emp@wt.test', role: 'EMPLOYEE', team: TEAM as string | null },
  lead2: { id: '3e650000-0000-4000-8000-000000000013', email: 'lead2@wt.test', role: 'TEAM_LEAD', team: TEAM2 as string | null },
  hr: { id: '3e650000-0000-4000-8000-000000000014', email: 'hr@wt.test', role: 'HR', team: null as string | null },
} as const;
type Who = keyof typeof U;
const TZ = 'Asia/Colombo';
const Y = formatInTimeZone(new Date(Date.now() - 86_400_000), TZ, 'yyyy-MM-dd');
const at = (hhmm: string) => new Date(`${Y}T${hhmm}:00+05:30`);

describe('ADR 049: work-time report', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  const tokens = {} as Record<Who, string>;
  const base = `http://localhost:${PORT}`;
  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  async function ok<T>(res: Response, status: number, schema?: { parse: (v: unknown) => T }): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return schema ? schema.parse(JSON.parse(text)) : (JSON.parse(text || 'null') as T);
  }
  let taskId = '';

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    const pgBase = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev' };
    adminPool = new pg.Pool({ ...pgBase, user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Work Time Ltd', 'wt-e2e', $2)`, [ORG, TZ]);
    await adminPool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $3, 'A'), ($2, $3, 'B')`, [TEAM, TEAM2, ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const [k, u] of Object.entries(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, team_id, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`, [u.id, ORG, u.email, k, u.role, u.team, hash]);
    }
    await adminPool.query(`UPDATE users SET manager_id = $1 WHERE id = $2`, [U.lead.id, U.emp.id]);
    await adminPool.query(`UPDATE users SET mfa_enabled = true, mfa_secret = $1 WHERE id = $2`, [MFA_SECRET, U.hr.id]);
    await adminPool.query(`INSERT INTO projects (id, org_id, name, code, manager_id) VALUES ($1, $2, 'Billing', 'BIL', $3)`, [PROJECT, ORG, U.lead.id]);
    await adminPool.query(`INSERT INTO project_members (org_id, project_id, user_id) VALUES ($1, $2, $3)`, [ORG, PROJECT, U.emp.id]);
    // Yesterday 09:00-13:00 attended (4 h), of which 10:00-11:00 in a verified meeting.
    const S = '3e650000-0000-4000-8000-000000000901';
    await adminPool.query(
      `INSERT INTO attendance_sessions (id, org_id, user_id, device_id, work_date, clock_in_at, clock_out_at, clock_in_source, clock_out_source,
         active_seconds, idle_seconds, break_seconds, meeting_seconds, net_seconds, last_heartbeat_at, ip_in, flags, status, current_state, consecutive_idle_seconds)
       VALUES ($1, $2, $3, 'd1', $4, $5, $6, 'AUTO_HEARTBEAT', 'LOGOUT', 10800, 0, 0, 3600, 14400, $6, '127.0.0.1', '{}', 'CLOSED', 'OFFLINE', 0)`,
      [S, ORG, U.emp.id, Y, at('09:00'), at('13:00')]);
    await adminPool.query(`INSERT INTO attendance_segments (org_id, session_id, state, started_at, ended_at, duration_seconds, call_kind, flags) VALUES ($1, $2, 'IN_MEETING', $3, $4, 3600, 'ROOM', '{}')`,
      [ORG, S, at('10:00'), at('11:00')]);
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD, ...(who === 'hr' ? { totpCode: await freshCode(MFA_SECRET) } : {}) }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
    }
    const task = await ok(await api('lead', '/tasks', { method: 'POST', body: { title: 'Invoice export', assigneeId: U.emp.id, projectId: PROJECT, estimateMinutes: 60 } }), 201, TaskDetailSchema);
    taskId = task.id;
    // 30 min of named manual development work, then a 10:30-12:00 timer on the task (30 min of it in the meeting).
    const manual = await ok(await api('emp', '/time-entries', { method: 'POST', body: { workDate: Y, minutes: 30, title: 'Code review', projectId: PROJECT, category: 'DEVELOPMENT', reason: 'Reviewed offline' } }), 201, TimeEntrySchema);
    await adminPool.query(
      `INSERT INTO time_entries (org_id, user_id, timesheet_id, project_id, task_id, work_date, started_at, ended_at, minutes, source, task_title, project_name)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, 90, 'TIMER', 'Invoice export', 'Billing')`,
      [ORG, U.emp.id, manual.timesheetId, PROJECT, taskId, Y, at('10:30'), at('12:00')]);
    await adminPool.query(`UPDATE tasks SET status = 'DONE', completed_at = $2 WHERE id = $1`, [taskId, at('12:30')]);
  });

  after(async () => {
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.end();
  });

  it('FR-WT-019, FR-WT-020: attendance, meetings, task and focused time without double counting', async () => {
    const r = await ok(await api('emp', `/reports/work-time?from=${Y}&to=${Y}`), 200, WorkTimeReportSchema);
    assert.deepEqual(r.totals, { attendanceMinutes: 240, meetingMinutes: 60, taskMinutes: 120, focusedTaskMinutes: 90, taskDuringMeetingsMinutes: 30, manualMinutes: 30, onsiteMinutes: 0 });
    const t = r.tasks.find((x) => x.taskId === taskId)!;
    assert.equal(t.estimateMinutes, 60);
    assert.equal(t.actualMinutes, 90);
    assert.equal(t.remainingMinutes, 0);
    assert.equal(t.percentOfEstimate, 150);
    assert.deepEqual(r.projects.map((p) => [p.label, p.minutes]), [['Billing', 120]]);
    assert.deepEqual(r.categories.map((c) => [c.label, c.minutes]), [['Not specified', 90], ['Development', 30]]);
    assert.equal(r.weekly.length, 1);
    assert.equal(r.weekly[0]!.focusedTaskMinutes, 90);
    assert.equal(r.overEstimate.completedTasks, 1);
    assert.equal(r.overEstimate.completedOverEstimate, 1);
    assert.equal(r.overEstimate.tasks[0]?.taskId, taskId);
    assert.ok(r.insights.some((l) => l.includes('ran during meetings')));
  });

  it('scope: employees see only themselves; the manager sees their report; another team cannot; HR sees the team view', async () => {
    assert.equal((await api('emp', `/reports/work-time?from=${Y}&to=${Y}&scope=team`)).status, 403);
    assert.equal((await api('emp', `/reports/work-time?from=${Y}&to=${Y}&scope=person&userId=${U.lead.id}`)).status, 403);
    const lead = await ok(await api('lead', `/reports/work-time?from=${Y}&to=${Y}&scope=person&userId=${U.emp.id}`), 200, WorkTimeReportSchema);
    assert.equal(lead.totals.taskMinutes, 120);
    assert.equal((await api('lead2', `/reports/work-time?from=${Y}&to=${Y}&scope=person&userId=${U.emp.id}`)).status, 404);
    const hr = await ok(await api('hr', `/reports/work-time?from=${Y}&to=${Y}&scope=team`), 200, WorkTimeReportSchema);
    assert.ok(hr.people >= 4);
    assert.equal(hr.totals.taskMinutes, 120);
    assert.equal((await api('emp', `/reports/work-time?from=2026-01-01&to=2027-12-31`)).status, 400, 'at most 366 days');
  });

  it('a project filter narrows task time', async () => {
    const other = '3e650000-0000-4000-8000-000000000299';
    const r = await ok(await api('emp', `/reports/work-time?from=${Y}&to=${Y}&projectId=${other}`), 200, WorkTimeReportSchema);
    assert.equal(r.totals.taskMinutes, 0);
    assert.equal(r.totals.attendanceMinutes, 240, 'attendance is never filtered by project');
  });

  it('FR-WT-020: CSV export, formula-safe and audited', async () => {
    const res = await api('emp', `/reports/work-time?from=${Y}&to=${Y}&format=csv`);
    assert.equal(res.status, 200);
    const csv = await res.text();
    assert.match(csv, /Focused task time \(outside meetings\)/);
    assert.match(csv, /Invoice export/);
    const n = (await adminPool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = 'REPORT_EXPORTED'`, [ORG])).rows[0].n as number;
    assert.equal(n, 1);
  });

  it('D5: the task report\'s actual time comes from time entries', async () => {
    const r = await ok(await api('lead', `/reports/tasks?from=${Y}&to=${Y}`), 200, TaskReportSchema);
    const emp = r.rows.find((x) => x.user.id === U.emp.id)!;
    assert.equal(emp.actualMinutes, 90, 'was always 0');
  });
});
