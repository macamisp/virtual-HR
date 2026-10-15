/**
 * Tasks core E2E: FR-TASK-001, 002, 005 (list scopes), 006 (comments/@mentions/activity), 007
 * (acceptance), visibility rules, RLS and per-route permissions.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { generateSync } from 'otplib';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { TaskEvents } from '../src/tasks/task-events.ts';
import type { TaskEventMap } from '../src/tasks/task-events.ts';
import {
  ProjectListSchema,
  ProjectMembersSchema,
  TaskActivityListSchema,
  TaskCommentSchema,
  TaskDetailSchema,
  TaskListSchema,
  UserRefListSchema,
} from '../../../packages/shared/src/tasks/types.ts';
import type { TaskDetail } from '../../../packages/shared/src/tasks/types.ts';

const ORG = '33330000-0000-4000-8000-000000000001';
const ORG_B = '33330000-0000-4000-8000-000000000002';
const TEAM = '33330000-0000-4000-8000-000000000101';
const OTHER_TEAM = '33330000-0000-4000-8000-000000000102';
const PASSWORD = 'ComplexPassword123!';
const HR_SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';

const U = {
  hr: { id: '33330000-0000-4000-8000-000000000011', email: 'hr@tasks.test', role: 'HR', team: null as string | null },
  lead: { id: '33330000-0000-4000-8000-000000000012', email: 'lead@tasks.test', role: 'TEAM_LEAD', team: TEAM },
  e1: { id: '33330000-0000-4000-8000-000000000013', email: 'e1@tasks.test', role: 'EMPLOYEE', team: TEAM },
  e2: { id: '33330000-0000-4000-8000-000000000014', email: 'e2@tasks.test', role: 'EMPLOYEE', team: OTHER_TEAM },
  sub: { id: '33330000-0000-4000-8000-000000000015', email: 'sub@tasks.test', role: 'SUBCONTRACTOR', team: TEAM },
  aud: { id: '33330000-0000-4000-8000-000000000016', email: 'aud@tasks.test', role: 'AUDITOR', team: null as string | null },
  other: { id: '33330000-0000-4000-8000-000000000021', email: 'other@tasks-b.test', role: 'EMPLOYEE', team: null as string | null },
} as const;
type Who = keyof typeof U;

describe('Tasks core API (FR-TASK-001/002/005/006/007, visibility, RLS)', { concurrency: false }, () => {
  let app: INestApplication;
  let base: string;
  let adminPool: pg.Pool;
  const tokens = {} as Record<Who, string>;
  const events: Array<{ name: keyof TaskEventMap; payload: unknown }> = [];

  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const json = async <T>(res: Response, status: number, schema?: { parse: (v: unknown) => T }): Promise<T> => {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    const body = text ? JSON.parse(text) : undefined;
    return schema ? schema.parse(body) : (body as T);
  };
  const createTask = async (who: Who, body: Record<string, unknown>): Promise<TaskDetail> =>
    await json(await api(who, '/tasks', { method: 'POST', body }), 201, TaskDetailSchema);
  const listIds = async (who: Who, scope = 'all'): Promise<string[]> =>
    (await json(await api(who, `/tasks?scope=${scope}`), 200, TaskListSchema)).map((t) => t.id);

  let projectId: string;
  let tTeam: TaskDetail; // lead -> e1 (team task)
  let tProject: TaskDetail; // hr -> e2 in project (sub is member)

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
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, ORG_B]]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Tasks Ltd', 'tasks-e2e'), ($2, 'Other Ltd', 'tasks-e2e-b')`, [ORG, ORG_B]);
    await adminPool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $3, 'Delivery'), ($2, $3, 'Sales')`, [TEAM, OTHER_TEAM, ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const [key, u] of Object.entries(U)) {
      await adminPool.query(
        `INSERT INTO users (id, org_id, email, display_name, role, team_id, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`,
        [u.id, key === 'other' ? ORG_B : ORG, u.email, key.toUpperCase(), u.role, u.team, hash],
      );
    }
    await adminPool.query(`UPDATE users SET manager_id = $1 WHERE id = ANY($2::uuid[])`, [U.lead.id, [U.e1.id, U.sub.id]]);
    await adminPool.query(`UPDATE users SET mfa_enabled = true, mfa_secret = $1 WHERE id = $2`, [HR_SECRET, U.hr.id]);

    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(3061);
    base = 'http://localhost:3061';
    const bus = app.get(TaskEvents);
    for (const name of ['task.assigned', 'task.accepted', 'task.declined', 'task.mentioned', 'task.status'] as const) {
      bus.on(name, (payload) => {
        events.push({ name, payload });
      });
    }

    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: U[who].email, password: PASSWORD, ...(who === 'hr' ? { totpCode: generateSync({ secret: HR_SECRET }) } : {}) }),
      });
      const body = (await res.json()) as { accessToken: string };
      assert.ok(body.accessToken, `login ${who}`);
      tokens[who] = body.accessToken;
    }
  });

  after(async () => {
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, ORG_B]]);
    await adminPool.end();
  });

  describe('Projects (minimal admin)', { concurrency: false }, () => {
    it('HR creates a project; duplicate codes are refused; employees cannot create projects', async () => {
      const p = await json(await api('hr', '/projects', { method: 'POST', body: { name: 'Website relaunch', code: 'WEB', managerId: U.hr.id } }), 201);
      projectId = (p as { id: string }).id;
      await json(await api('hr', '/projects', { method: 'POST', body: { name: 'Again', code: 'WEB' } }), 409);
      await json(await api('e1', '/projects', { method: 'POST', body: { name: 'Mine', code: 'MINE' } }), 403);
    });

    it('membership changes are audited and drive project visibility', async () => {
      const members = await json(await api('hr', `/projects/${projectId}/members`, { method: 'POST', body: { userId: U.sub.id } }), 201, ProjectMembersSchema);
      assert.deepEqual(members.map((m) => m.id), [U.sub.id]);
      await json(await api('hr', `/projects/${projectId}/members`, { method: 'POST', body: { userId: U.e2.id } }), 201);
      const audit = await adminPool.query(`SELECT action FROM audit_logs WHERE org_id = $1 AND entity_id = $2 ORDER BY id`, [ORG, projectId]);
      assert.ok(audit.rows.some((r) => r.action === 'PROJECT_MEMBER_ADDED'));
      // The sub sees the project; e1 (not a member) does not
      assert.equal((await json(await api('sub', '/projects'), 200, ProjectListSchema)).length, 1);
      assert.equal((await json(await api('e1', '/projects'), 200, ProjectListSchema)).length, 0);
      await json(await api('e1', `/projects/${projectId}/members`), 404);
      await json(await api('e1', `/projects/${projectId}/members`, { method: 'POST', body: { userId: U.e1.id } }), 403);
    });
  });

  describe('Create, visibility and list scopes', { concurrency: false }, () => {
    it('creates tasks with all FR-TASK-001 fields', async () => {
      tTeam = await createTask('lead', {
        title: 'Prepare onboarding pack',
        description: '## Steps\n- **collect** forms',
        assigneeId: U.e1.id,
        priority: 'HIGH',
        dueDate: '2026-10-20',
        plannedDate: '2026-10-19',
        estimateMinutes: 120,
        labels: ['hr', 'onboarding', 'hr'],
        checklist: ['Draft', 'Review'],
      });
      assert.equal(tTeam.assignee?.id, U.e1.id);
      assert.equal(tTeam.reporter.id, U.lead.id);
      assert.deepEqual(tTeam.labels, ['hr', 'onboarding']);
      assert.equal(tTeam.checklistTotal, 2);
      assert.equal(tTeam.acceptanceStatus, 'NOT_REQUIRED');
      assert.equal(tTeam.dueDate, '2026-10-20');
      assert.equal(tTeam.actualMinutes, null);
      assert.equal(tTeam.overrun, false);
      tProject = await createTask('hr', { title: 'Write landing copy', projectId, assigneeId: U.e2.id });
      assert.equal(tProject.projectCode, 'WEB');
    });

    it('visibility: assignee, reporter, team lead, project members and HR; nobody else', async () => {
      const sees = async (who: Who, task: TaskDetail) => (await api(who, `/tasks/${task.id}`)).status === 200;
      // team task (lead -> e1)
      assert.equal(await sees('e1', tTeam), true);
      assert.equal(await sees('lead', tTeam), true);
      assert.equal(await sees('hr', tTeam), true);
      assert.equal(await sees('e2', tTeam), false);
      assert.equal(await sees('sub', tTeam), false, 'same team, but subcontractors see only own + project tasks');
      // project task (hr -> e2, sub is a member)
      assert.equal(await sees('sub', tProject), true);
      assert.equal(await sees('e2', tProject), true);
      assert.equal(await sees('lead', tProject), false, 'e2 is not in the lead team and lead is not a project member');
      assert.equal(await sees('e1', tProject), false);
      // the invisible task is a 404, indistinguishable from a missing one
      assert.equal((await api('e2', `/tasks/${tTeam.id}`)).status, 404);
    });

    it('list scopes match visibility; team scope requires the permission', async () => {
      assert.deepEqual(new Set(await listIds('hr')), new Set([tTeam.id, tProject.id]));
      assert.deepEqual(await listIds('e1', 'mine'), [tTeam.id]);
      assert.deepEqual(await listIds('lead', 'reported'), [tTeam.id]);
      assert.deepEqual(await listIds('lead', 'team'), [tTeam.id]);
      assert.deepEqual(await listIds('sub'), [tProject.id]);
      assert.deepEqual(await listIds('e2'), [tProject.id]);
      await json(await api('e1', '/tasks?scope=team'), 403);
    });

    it('filters: status, project, label, search and due range', async () => {
      assert.deepEqual((await json(await api('hr', `/tasks?scope=all&projectId=${projectId}`), 200, TaskListSchema)).map((t) => t.id), [tProject.id]);
      assert.deepEqual((await json(await api('hr', '/tasks?scope=all&label=onboarding'), 200, TaskListSchema)).map((t) => t.id), [tTeam.id]);
      assert.deepEqual((await json(await api('hr', '/tasks?scope=all&q=landing'), 200, TaskListSchema)).map((t) => t.id), [tProject.id]);
      assert.deepEqual((await json(await api('hr', '/tasks?scope=all&dueFrom=2026-10-20&dueTo=2026-10-20'), 200, TaskListSchema)).map((t) => t.id), [tTeam.id]);
      assert.equal((await api('hr', '/tasks?scope=nope')).status, 400);
    });

    it('cross-tenant: another org cannot see or touch the task; RLS returns nothing without context', async () => {
      assert.equal((await api('other', `/tasks/${tTeam.id}`)).status, 404);
      assert.deepEqual(await listIds('other'), []);
      const appPool = new pg.Pool({
        host: process.env.PGHOST || 'localhost',
        port: Number(process.env.PGPORT || 5433),
        database: process.env.PGDATABASE || 'hrvo_dev',
        user: process.env.PGUSER || 'hrvo_app',
        password: process.env.PGPASSWORD || 'hrvo_app_pass',
      });
      try {
        for (const table of ['tasks', 'projects', 'project_members', 'task_activity', 'task_comments', 'task_checklist_items', 'task_attachments']) {
          const res = await appPool.query(`SELECT count(*)::int AS n FROM ${table}`);
          assert.equal(res.rows[0].n, 0, `${table} without app.org_id`);
        }
        await assert.rejects(appPool.query(`UPDATE task_activity SET type = 'X'`), /permission denied/);
        await assert.rejects(appPool.query(`DELETE FROM tasks`), /permission denied/);
      } finally {
        await appPool.end();
      }
    });

    it('per-route permissions: the auditor role has no task access', async () => {
      await json(await api('aud', '/tasks'), 403);
      await json(await api('aud', '/projects'), 403);
      await json(await api('aud', '/tasks', { method: 'POST', body: { title: 'x' } }), 403);
    });
  });

  describe('Assignment scope and acceptance (FR-TASK-007)', { concurrency: false }, () => {
    it('employees cannot assign to others; leads only within their team; HR anyone', async () => {
      await json(await api('e1', '/tasks', { method: 'POST', body: { title: 'Help me', assigneeId: U.e2.id } }), 403);
      await json(await api('lead', '/tasks', { method: 'POST', body: { title: 'Cross team', assigneeId: U.e2.id } }), 403);
      const t = await createTask('hr', { title: 'HR to e2', assigneeId: U.e2.id });
      assert.equal(t.assignee?.id, U.e2.id);
      const assignable = await json(await api('lead', '/tasks/assignable-users'), 200, UserRefListSchema);
      assert.deepEqual(new Set(assignable.map((u) => u.id)), new Set([U.lead.id, U.e1.id, U.sub.id]));
      assert.deepEqual((await json(await api('e1', '/tasks/assignable-users'), 200, UserRefListSchema)).map((u) => u.id), [U.e1.id]);
    });

    it('a task assigned to a subcontractor waits for acceptance; the sub cannot work on it until accepted', async () => {
      events.length = 0;
      const t = await createTask('lead', { title: 'Fix invoice template', assigneeId: U.sub.id });
      assert.equal(t.acceptanceStatus, 'PENDING');
      assert.ok(events.some((e) => e.name === 'task.assigned' && (e.payload as TaskEventMap['task.assigned']).requiresAcceptance));
      const subView = await json(await api('sub', `/tasks/${t.id}`), 200, TaskDetailSchema);
      assert.equal(subView.permissions.canRespond, true);
      assert.equal(subView.permissions.canChangeStatus, false);
      await json(await api('sub', `/tasks/${t.id}`, { method: 'PATCH', body: { version: subView.version, status: 'IN_PROGRESS' } }), 403);
      // accept, then the status can change
      const accepted = await json(await api('sub', `/tasks/${t.id}/accept`, { method: 'POST' }), 200, TaskDetailSchema);
      assert.equal(accepted.acceptanceStatus, 'ACCEPTED');
      assert.ok(accepted.acceptedAt);
      const moved = await json(await api('sub', `/tasks/${t.id}`, { method: 'PATCH', body: { version: accepted.version, status: 'IN_PROGRESS' } }), 200, TaskDetailSchema);
      assert.equal(moved.status, 'IN_PROGRESS');
      await json(await api('sub', `/tasks/${t.id}/accept`, { method: 'POST' }), 409);
    });

    it('declining needs a reason; the reporter sees the reason and can reassign', async () => {
      const t = await createTask('lead', { title: 'Weekend migration', assigneeId: U.sub.id });
      await json(await api('sub', `/tasks/${t.id}/decline`, { method: 'POST', body: { reason: 'no' } }), 400);
      events.length = 0;
      await json(await api('sub', `/tasks/${t.id}/decline`, { method: 'POST', body: { reason: 'Not available this weekend' } }), 200);
      assert.ok(events.some((e) => e.name === 'task.declined'));
      const leadView = await json(await api('lead', `/tasks/${t.id}`), 200, TaskDetailSchema);
      assert.equal(leadView.acceptanceStatus, 'DECLINED');
      assert.equal(leadView.declineReason, 'Not available this weekend');
      const reassigned = await json(await api('lead', `/tasks/${t.id}`, { method: 'PATCH', body: { version: leadView.version, assigneeId: U.e1.id } }), 200, TaskDetailSchema);
      assert.equal(reassigned.assignee?.id, U.e1.id);
      assert.equal(reassigned.acceptanceStatus, 'NOT_REQUIRED');
      assert.equal(reassigned.declineReason, null);
    });
  });

  describe('Workflow, concurrency and activity (FR-TASK-002, 006)', { concurrency: false }, () => {
    it('enforces the default transitions, stamps completion and logs every move', async () => {
      let t = await json(await api('e1', `/tasks/${tTeam.id}`), 200, TaskDetailSchema);
      await json(await api('e1', `/tasks/${t.id}`, { method: 'PATCH', body: { version: t.version, status: 'IN_REVIEW' } }), 400);
      for (const status of ['IN_PROGRESS', 'IN_REVIEW', 'DONE'] as const) {
        t = await json(await api('e1', `/tasks/${t.id}`, { method: 'PATCH', body: { version: t.version, status } }), 200, TaskDetailSchema);
      }
      assert.ok(t.completedAt);
      t = await json(await api('e1', `/tasks/${t.id}`, { method: 'PATCH', body: { version: t.version, status: 'IN_PROGRESS' } }), 200, TaskDetailSchema);
      assert.equal(t.completedAt, null);
      const activity = await json(await api('lead', `/tasks/${t.id}/activity`), 200, TaskActivityListSchema);
      const moves = activity.filter((a) => a.type === 'STATUS_CHANGED').map((a) => `${a.data.from}->${a.data.to}`);
      assert.deepEqual(moves, ['TODO->IN_PROGRESS', 'IN_PROGRESS->IN_REVIEW', 'IN_REVIEW->DONE', 'DONE->IN_PROGRESS']);
      assert.equal(activity[0]!.type, 'CREATED');
    });

    it('the assignee cannot edit fields; the reporter can; edits record previous values', async () => {
      const t = await json(await api('e1', `/tasks/${tTeam.id}`), 200, TaskDetailSchema);
      await json(await api('e1', `/tasks/${t.id}`, { method: 'PATCH', body: { version: t.version, title: 'Mine now' } }), 403);
      const planned = await json(await api('e1', `/tasks/${t.id}`, { method: 'PATCH', body: { version: t.version, plannedDate: '2026-10-21' } }), 200, TaskDetailSchema);
      assert.equal(planned.plannedDate, '2026-10-21');
      const edited = await json(await api('lead', `/tasks/${t.id}`, { method: 'PATCH', body: { version: planned.version, title: 'Prepare onboarding pack v2', priority: 'URGENT' } }), 200, TaskDetailSchema);
      assert.equal(edited.priority, 'URGENT');
      const activity = await json(await api('lead', `/tasks/${t.id}/activity`), 200, TaskActivityListSchema);
      const upd = activity.filter((a) => a.type === 'UPDATED').at(-1)!;
      assert.deepEqual((upd.data.changes as Record<string, unknown>).priority, { from: 'HIGH', to: 'URGENT' });
    });

    it('a stale version is rejected with 409', async () => {
      const t = await json(await api('lead', `/tasks/${tTeam.id}`), 200, TaskDetailSchema);
      await json(await api('lead', `/tasks/${t.id}`, { method: 'PATCH', body: { version: t.version, priority: 'LOW' } }), 200);
      await json(await api('lead', `/tasks/${t.id}`, { method: 'PATCH', body: { version: t.version, priority: 'HIGH' } }), 409);
    });
  });

  describe('Comments, @mentions, checklist, attachments, subtasks, delete', { concurrency: false }, () => {
    it('mentions must target people who can see the task; mentioned users are notified', async () => {
      const mentionable = await json(await api('e1', `/tasks/${tTeam.id}/mentionable`), 200, UserRefListSchema);
      const ids = new Set(mentionable.map((u) => u.id));
      assert.ok(ids.has(U.lead.id) && ids.has(U.hr.id) && ids.has(U.e1.id));
      assert.ok(!ids.has(U.e2.id) && !ids.has(U.sub.id));
      await json(await api('e1', `/tasks/${tTeam.id}/comments`, { method: 'POST', body: { body: `@[E2](user:${U.e2.id}) look` } }), 400);
      events.length = 0;
      const c = await json(await api('e1', `/tasks/${tTeam.id}/comments`, { method: 'POST', body: { body: `Done the draft, @[LEAD](user:${U.lead.id}) please review` } }), 201, TaskCommentSchema);
      assert.deepEqual(c.mentions.map((m) => m.id), [U.lead.id]);
      assert.ok(events.some((e) => e.name === 'task.mentioned' && (e.payload as TaskEventMap['task.mentioned']).userIds.includes(U.lead.id)));
      await json(await api('e2', `/tasks/${tTeam.id}/comments`), 404);
    });

    it('checklist items can be added and ticked; attachment references must be https', async () => {
      let t = await json(await api('e1', `/tasks/${tTeam.id}/checklist`, { method: 'POST', body: { text: 'Send to HR' } }), 201, TaskDetailSchema);
      assert.equal(t.checklistTotal, 3);
      t = await json(await api('e1', `/tasks/${tTeam.id}/checklist/${t.checklist[0]!.id}`, { method: 'PATCH', body: { done: true } }), 200, TaskDetailSchema);
      assert.equal(t.checklistDone, 1);
      await json(await api('e1', `/tasks/${tTeam.id}/attachments`, { method: 'POST', body: { name: 'x', url: 'http://insecure.example/x' } }), 400);
      await json(await api('e1', `/tasks/${tTeam.id}/attachments`, { method: 'POST', body: { name: 'x', url: 'javascript:alert(1)' } }), 400);
      t = await json(await api('e1', `/tasks/${tTeam.id}/attachments`, { method: 'POST', body: { name: 'Pack.pdf', url: 'https://files.example/pack.pdf', mimeType: 'application/pdf', sizeBytes: 1024 } }), 201, TaskDetailSchema);
      assert.equal(t.attachments[0]!.name, 'Pack.pdf');
      // someone who can only view cannot change the checklist
      await json(await api('sub', `/tasks/${tProject.id}/checklist`, { method: 'POST', body: { text: 'nope' } }), 403);
    });

    it('subtasks inherit the project and cannot nest further', async () => {
      const sub = await createTask('hr', { title: 'Hero section', parentTaskId: tProject.id, assigneeId: U.e2.id });
      assert.equal(sub.projectId, projectId);
      const parent = await json(await api('hr', `/tasks/${tProject.id}`), 200, TaskDetailSchema);
      assert.deepEqual(parent.subtasks.map((s) => s.id), [sub.id]);
      await json(await api('hr', '/tasks', { method: 'POST', body: { title: 'Too deep', parentTaskId: sub.id } }), 400);
    });

    it('only the reporter (or HR) deletes; deleted tasks disappear', async () => {
      await json(await api('e2', `/tasks/${tProject.id}`, { method: 'DELETE' }), 403);
      await json(await api('hr', `/tasks/${tProject.id}`, { method: 'DELETE' }), 204);
      assert.equal((await api('hr', `/tasks/${tProject.id}`)).status, 404);
      assert.ok(!(await listIds('hr')).includes(tProject.id));
    });

    it('rejects malformed ids and bodies', async () => {
      assert.equal((await api('hr', '/tasks/not-a-uuid')).status, 400);
      assert.equal((await api('hr', '/tasks', { method: 'POST', body: { title: '' } })).status, 400);
      assert.equal((await api('hr', '/tasks', { method: 'POST', body: { title: 'x', dueDate: '20-10-2026' } })).status, 400);
    });
  });
});
