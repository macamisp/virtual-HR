/**
 * ADR 049 §3, §4 (FR-WT-013..018): timers on a task, a project or the person's own title, with
 * Pause/Resume; named manual work with declared times and overlap checks; names kept after a
 * rename; time on someone else's task only for people who manage it; remaining estimate; audit.
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
import { TimeEntrySchema, TimeEntryListSchema, TimerStateSchema } from '../../../packages/shared/src/timesheets/types.ts';
import { TaskDetailSchema } from '../../../packages/shared/src/tasks/types.ts';
import type { TaskDetail } from '../../../packages/shared/src/tasks/types.ts';

const ORG = '3e700000-0000-4000-8000-000000000001';
const TEAM_A = '3e700000-0000-4000-8000-000000000101';
const TEAM_B = '3e700000-0000-4000-8000-000000000102';
const PROJECT = '3e700000-0000-4000-8000-000000000201';
const PORT = 3070;
const PASSWORD = 'ComplexPassword123!';
const U = {
  lead: { id: '3e700000-0000-4000-8000-000000000011', email: 'lead@we.test', role: 'TEAM_LEAD', team: TEAM_A as string | null },
  emp: { id: '3e700000-0000-4000-8000-000000000012', email: 'emp@we.test', role: 'EMPLOYEE', team: TEAM_A as string | null },
  emp2: { id: '3e700000-0000-4000-8000-000000000013', email: 'emp2@we.test', role: 'EMPLOYEE', team: TEAM_A as string | null },
  outsider: { id: '3e700000-0000-4000-8000-000000000014', email: 'out@we.test', role: 'EMPLOYEE', team: TEAM_B as string | null },
} as const;
type Who = keyof typeof U;
const TZ = 'Asia/Colombo';
const TODAY = formatInTimeZone(new Date(), TZ, 'yyyy-MM-dd');
const YESTERDAY = formatInTimeZone(new Date(Date.now() - 86_400_000), TZ, 'yyyy-MM-dd');

describe('ADR 049: timers, named work entries and task time', { concurrency: false }, () => {
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
  const audits = async (action: string) => (await adminPool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = $2`, [ORG, action])).rows[0].n as number;
  const t = {} as { assigned: TaskDetail; open: TaskDetail };

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    const pgBase = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev' };
    adminPool = new pg.Pool({ ...pgBase, user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Work Entries Ltd', 'we-e2e', $2)`, [ORG, TZ]);
    await adminPool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $3, 'A'), ($2, $3, 'B')`, [TEAM_A, TEAM_B, ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const [k, u] of Object.entries(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, team_id, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`, [u.id, ORG, u.email, k, u.role, u.team, hash]);
    }
    await adminPool.query(`UPDATE users SET manager_id = $1 WHERE id IN ($2, $3)`, [U.lead.id, U.emp.id, U.emp2.id]);
    await adminPool.query(`INSERT INTO projects (id, org_id, name, code, manager_id, billable) VALUES ($1, $2, 'Client Portal', 'CP', $3, true)`, [PROJECT, ORG, U.lead.id]);
    for (const who of ['emp', 'emp2'] as const) await adminPool.query(`INSERT INTO project_members (org_id, project_id, user_id) VALUES ($1, $2, $3)`, [ORG, PROJECT, U[who].id]);
    for (const who of ['lead', 'emp', 'emp2', 'outsider'] as const) {
      await adminPool.query(
        `INSERT INTO attendance_sessions (org_id, user_id, device_id, work_date, clock_in_at, clock_in_source, last_heartbeat_at, ip_in, status, current_state)
         VALUES ($1, $2, 'dev-1', $3, now() - interval '1 hour', 'AUTO_HEARTBEAT', now(), '127.0.0.1', 'OPEN', 'ACTIVE')`, [ORG, U[who].id, TODAY]);
    }
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
      assert.ok(tokens[who], `login ${who}`);
    }
    t.assigned = await ok(await api('lead', '/tasks', { method: 'POST', body: { title: 'Login page', assigneeId: U.emp.id, projectId: PROJECT, estimateMinutes: 120 } }), 201, TaskDetailSchema);
    t.open = await ok(await api('lead', '/tasks', { method: 'POST', body: { title: 'Unassigned clean-up', projectId: PROJECT, estimateMinutes: 30 } }), 201, TaskDetailSchema);
    await adminPool.query(`UPDATE tasks SET assignee_id = NULL WHERE id = $1`, [t.open.id]); // creation always assigns someone
  });

  after(async () => {
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.end();
  });

  it('FR-WT-013: a timer on the person\'s own title and project, without a task; one at a time', async () => {
    assert.equal((await api('emp', '/timer/start', { method: 'POST', body: {} })).status, 400, 'a task or a title is required');
    assert.equal((await api('outsider', '/timer/start', { method: 'POST', body: { title: 'Sneak in', projectId: PROJECT } })).status, 404, 'not a project member');
    const s = await ok(await api('emp', '/timer/start', { method: 'POST', body: { title: 'Fix Login Authentication', projectId: PROJECT, workType: 'REMOTE', category: 'DEVELOPMENT', startedAt: '2020-01-01T00:00:00Z' } }), 200, TimerStateSchema);
    assert.equal(s.running?.title, 'Fix Login Authentication');
    assert.equal(s.running?.projectName, 'Client Portal');
    assert.equal(s.running?.workType, 'REMOTE');
    assert.equal(s.running?.category, 'DEVELOPMENT');
    assert.equal(s.running?.taskId, null);
    assert.ok(Math.abs(Date.parse(s.running!.startedAt!) - Date.now()) < 60_000, 'server clock, the body\'s startedAt is ignored');
    const again = await ok(await api('emp', '/timer/start', { method: 'POST', body: { title: 'Fix Login Authentication', projectId: PROJECT } }), 200, TimerStateSchema);
    assert.equal(again.running?.id, s.running?.id, 'the same work keeps running');
    const other = await ok(await api('emp', '/timer/start', { method: 'POST', body: { title: 'Client Report Preparation' } }), 200, TimerStateSchema);
    assert.equal(other.stopped?.id, s.running?.id, 'starting other work stopped the first timer');
    assert.equal(other.running?.projectId, null, 'a title alone is enough');
  });

  it('FR-WT-013: Pause stops the timer, Resume continues the same work as a new entry', async () => {
    const paused = await ok(await api('emp', '/timer/stop', { method: 'POST' }), 200, TimerStateSchema);
    assert.equal(paused.running, null);
    const resumed = await ok(await api('emp', '/timer/resume', { method: 'POST' }), 200, TimerStateSchema);
    assert.equal(resumed.running?.title, 'Client Report Preparation');
    assert.notEqual(resumed.running?.id, paused.stopped?.id, 'a new entry: the pause is not counted');
    await ok(await api('emp', '/timer/stop', { method: 'POST' }), 200);
    assert.equal((await api('emp2', '/timer/resume', { method: 'POST' })).status, 404, 'nothing to resume today');
  });

  it('FR-WT-016: time on a task assigned to someone else only from people who manage it', async () => {
    assert.equal((await api('emp2', `/tasks/${t.assigned.id}/timer/start`, { method: 'POST' })).status, 403, 'a teammate on the project');
    assert.equal((await api('emp2', '/time-entries', { method: 'POST', body: { workDate: YESTERDAY, minutes: 30, taskId: t.assigned.id, reason: 'Helped out' } })).status, 403);
    await ok(await api('lead', `/tasks/${t.assigned.id}/timer/start`, { method: 'POST' }), 200, TimerStateSchema);
    await ok(await api('lead', '/timer/stop', { method: 'POST' }), 200);
    await ok(await api('emp2', `/tasks/${t.open.id}/timer/start`, { method: 'POST' }), 200, TimerStateSchema);
    await ok(await api('emp2', '/timer/stop', { method: 'POST' }), 200);
  });

  let named: string;
  it('FR-WT-017, FR-WT-018: named manual work with declared times; overlaps, future ends and half times refused; audited', async () => {
    const e = await ok(await api('emp', '/time-entries', { method: 'POST', body: { workDate: YESTERDAY, startTime: '09:00', endTime: '10:30', title: 'Database Optimization', projectId: PROJECT, workType: 'OFFICE', category: 'DEVELOPMENT', note: 'Indexes for the report queries', reason: 'Worked before the app was open' } }), 201, TimeEntrySchema);
    named = e.id;
    assert.equal(e.minutes, 90);
    assert.equal(e.source, 'MANUAL');
    assert.equal(e.title, 'Database Optimization');
    assert.equal(new Date(e.startedAt!).toISOString(), new Date(`${YESTERDAY}T09:00:00+05:30`).toISOString(), 'org-local times');
    assert.equal((await api('emp', '/time-entries', { method: 'POST', body: { workDate: YESTERDAY, startTime: '10:00', endTime: '11:00', title: 'Overlap', reason: 'Testing overlap' } })).status, 409);
    assert.equal((await api('emp', '/time-entries', { method: 'POST', body: { workDate: YESTERDAY, startTime: '10:00', title: 'Half', reason: 'Only a start' } })).status, 400);
    assert.equal((await api('emp', '/time-entries', { method: 'POST', body: { workDate: YESTERDAY, startTime: '12:00', endTime: '11:00', title: 'Backwards', reason: 'End first' } })).status, 400);
    assert.equal((await api('emp', '/time-entries', { method: 'POST', body: { workDate: TODAY, startTime: '23:58', endTime: '23:59', title: 'Later', reason: 'Not yet' } })).status === 201 ? 'late-night run' : 'ok', 'ok', 'an end in the future is refused (unless the suite runs at 23:59)');
    const plain = await ok(await api('emp', '/time-entries', { method: 'POST', body: { workDate: YESTERDAY, minutes: 45, title: 'Client call notes', workType: 'ONSITE', reason: 'Offline at the client' } }), 201, TimeEntrySchema);
    assert.equal(plain.startedAt, null, 'a duration alone, as before');
    assert.equal(await audits('TIME_ENTRY_MANUAL_ADDED'), 2);
    const log = (await adminPool.query(`SELECT after FROM audit_logs WHERE org_id = $1 AND action = 'TIME_ENTRY_MANUAL_ADDED' LIMIT 1`, [ORG])).rows[0].after as Record<string, unknown>;
    assert.ok(!JSON.stringify(log).includes('Indexes'), 'notes never reach the audit log');
  });

  it('FR-WT-017: a named entry can be linked to a task later, under the task\'s rules; actual and remaining follow', async () => {
    const linked = await ok(await api('emp', `/time-entries/${named}`, { method: 'PATCH', body: { taskId: t.assigned.id } }), 200, TimeEntrySchema);
    assert.equal(linked.taskTitle, 'Login page');
    assert.equal((await api('emp', `/time-entries/${named}`, { method: 'PATCH', body: { taskId: t.open.id } })).status, 400, 'already on a task');
    const task = await ok(await api('emp', `/tasks/${t.assigned.id}`), 200, TaskDetailSchema);
    assert.equal(task.actualMinutes, 90);
    assert.equal(task.remainingMinutes, 30, 'estimate 120 - actual 90');
    assert.equal(await audits('TIME_ENTRY_MANUAL_UPDATED'), 1);
  });

  it('FR-WT-015: entries keep the task and project names they were recorded with', async () => {
    await adminPool.query(`UPDATE tasks SET title = 'Login and SSO page' WHERE id = $1`, [t.assigned.id]);
    await adminPool.query(`UPDATE projects SET name = 'Customer Portal' WHERE id = $1`, [PROJECT]);
    const list = await ok(await api('emp', `/time-entries?from=${YESTERDAY}&to=${YESTERDAY}`), 200, TimeEntryListSchema);
    const e = list.items.find((x) => x.id === named)!;
    assert.equal(e.taskTitle, 'Login page');
    assert.equal(e.taskTitleNow, 'Login and SSO page');
    assert.equal(e.projectName, 'Client Portal');
  });

  it('deleting manual time is audited', async () => {
    await ok(await api('emp', `/time-entries/${named}`, { method: 'DELETE' }), 200);
    assert.equal(await audits('TIME_ENTRY_MANUAL_DELETED'), 1);
  });
});
