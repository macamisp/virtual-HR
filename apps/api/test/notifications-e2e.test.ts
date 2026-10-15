/**
 * Notifications (FR-NOTIF-001, FR-TASK-011) and scheduled work (FR-TASK-004 carry-over,
 * FR-TASK-007 escalation, FR-TASK-016 weekly summary, FR-ATT-002/015/020 attendance jobs).
 * Jobs are driven directly with a fixed clock; BullMQ wiring is tested in jobs-bullmq-e2e.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { generateSync } from 'otplib';
import { io, type Socket } from 'socket.io-client';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { MAIL_TRANSPORT, InMemoryMailTransport } from '../src/common/mailer.ts';
import { ScheduledWorkService } from '../src/notifications/scheduled-work.service.ts';
import { dueInstant } from '../src/notifications/reminder-rules.ts';
import { addDaysIso, weekStartOf } from '../src/planning/planning-rules.ts';
import { NotificationListSchema } from '../../../packages/shared/src/notifications/types.ts';
import { TaskActivityListSchema, TaskDetailSchema } from '../../../packages/shared/src/tasks/types.ts';
import type { TaskDetail } from '../../../packages/shared/src/tasks/types.ts';

const ORG = '11110000-0000-4000-8000-000000000001';
const TEAM = '11110000-0000-4000-8000-000000000101';
const TZ = 'Asia/Colombo';
const PASSWORD = 'ComplexPassword123!';
const HR_SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const U = {
  lead: { id: '11110000-0000-4000-8000-000000000011', email: 'lead@notif.test', name: 'Lena Lead', role: 'TEAM_LEAD', team: TEAM as string | null },
  sub: { id: '11110000-0000-4000-8000-000000000012', email: 'sub@notif.test', name: 'Sid Sub', role: 'SUBCONTRACTOR', team: TEAM as string | null },
  emp: { id: '11110000-0000-4000-8000-000000000013', email: 'emp@notif.test', name: 'Eva Emp', role: 'EMPLOYEE', team: TEAM as string | null },
  hr: { id: '11110000-0000-4000-8000-000000000014', email: 'hr@notif.test', name: 'Hal HR', role: 'HR', team: null as string | null },
  aud: { id: '11110000-0000-4000-8000-000000000015', email: 'aud@notif.test', name: 'Ada Aud', role: 'AUDITOR', team: null as string | null },
} as const;
type Who = keyof typeof U;

describe('Notifications and scheduled work', { concurrency: false }, () => {
  let app: INestApplication;
  let base: string;
  let adminPool: pg.Pool;
  let outbox: InMemoryMailTransport;
  let work: ScheduledWorkService;
  const tokens = {} as Record<Who, string>;
  const sessions = {} as Record<Who, string>;
  const today = formatInTimeZone(new Date(), TZ, 'yyyy-MM-dd');

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
  const inbox = async (who: Who) => await ok(await api(who, '/notifications'), 200, NotificationListSchema);
  const mailsTo = (who: Who) => outbox.outbox.filter((m) => m.to === U[who].email);
  const settle = () => new Promise((r) => setTimeout(r, 150));
  const notifCount = async (userId: string, type: string) =>
    (await adminPool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = $2`, [userId, type])).rows[0].n as number;

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    adminPool = new pg.Pool({
      host: process.env.PGHOST || 'localhost',
      port: Number(process.env.PGPORT || 5433),
      database: process.env.PGDATABASE || 'hrvo_dev',
      user: process.env.PGADMIN_USER || 'postgres',
      password: process.env.PGADMIN_PASSWORD || 'postgres',
    });
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug, timezone, task_acceptance_escalation_hours) VALUES ($1, 'Notif Ltd', 'notif-e2e', $2, 2)`, [ORG, TZ]);
    await adminPool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Field')`, [TEAM, ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(U)) {
      await adminPool.query(
        `INSERT INTO users (id, org_id, email, display_name, role, team_id, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`,
        [u.id, ORG, u.email, u.name, u.role, u.team, hash],
      );
    }
    await adminPool.query(`UPDATE users SET manager_id = $1 WHERE id = ANY($2::uuid[])`, [U.lead.id, [U.sub.id, U.emp.id]]);
    await adminPool.query(`UPDATE users SET mfa_enabled = true, mfa_secret = $1 WHERE id = $2`, [HR_SECRET, U.hr.id]);

    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(3081);
    base = 'http://localhost:3081';
    outbox = app.get<InMemoryMailTransport>(MAIL_TRANSPORT, { strict: false });
    work = app.get(ScheduledWorkService);
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: U[who].email, password: PASSWORD, ...(who === 'hr' ? { totpCode: generateSync({ secret: HR_SECRET }) } : {}) }),
      });
      const body = (await res.json()) as { accessToken: string; sessionId: string };
      tokens[who] = body.accessToken;
      sessions[who] = body.sessionId;
    }
  });

  after(async () => {
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.end();
  });

  describe('Task event notifications (FR-TASK-011, FR-NOTIF-001)', { concurrency: false }, () => {
    let task: TaskDetail;

    it('assignment to a subcontractor: in-app (pushed live over the socket) + email asking to accept', async () => {
      const socket: Socket = io(base, { transports: ['websocket'], reconnection: false, auth: { token: tokens.sub } });
      await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('connect_error', reject); });
      const pushed = new Promise<{ id: string; title: string }>((resolve) => socket.once('notification:new', resolve));
      task = await ok(await api('lead', '/tasks', { method: 'POST', body: { title: 'Survey site B', assigneeId: U.sub.id } }), 201, TaskDetailSchema);
      const live = await pushed;
      socket.disconnect();
      assert.equal(live.title, 'Please accept: Survey site B');
      await settle();
      const list = await inbox('sub');
      assert.equal(list.unreadCount, 1);
      assert.equal(list.items[0]!.type, 'TASK_ACCEPTANCE_REQUESTED');
      assert.equal(list.items[0]!.link, `/tasks/${task.id}`);
      const mail = mailsTo('sub').at(-1);
      assert.ok(mail && mail.subject.includes('Please accept') && mail.text.includes(`/tasks/${task.id}`));
      assert.equal(mailsTo('lead').length, 0, 'the actor is not notified about their own action');
    });

    it('decline notifies the reporter with the reason; a mention notifies the mentioned person', async () => {
      await ok(await api('sub', `/tasks/${task.id}/decline`, { method: 'POST', body: { reason: 'No vehicle this week' } }), 200);
      await settle();
      const lead = await inbox('lead');
      const declined = lead.items.find((n) => n.type === 'TASK_DECLINED')!;
      assert.match(declined.title, /Sid Sub declined/);
      assert.match(declined.body, /No vehicle this week/);
      assert.ok(mailsTo('lead').some((m) => m.text.includes('No vehicle this week')));

      await ok(await api('sub', `/tasks/${task.id}/comments`, { method: 'POST', body: { body: `@[Lena Lead](user:${U.lead.id}) can someone drive?` } }), 201);
      await settle();
      assert.ok((await inbox('lead')).items.some((n) => n.type === 'TASK_MENTIONED' && n.title.includes('Sid Sub mentioned you')));
    });

    it('mark one / all as read; other people cannot touch my notifications; every role has an inbox', async () => {
      const lead = await inbox('lead');
      const first = lead.items[0]!;
      await ok(await api('sub', `/notifications/${first.id}/read`, { method: 'POST' }), 404);
      const afterOne = await ok(await api('lead', `/notifications/${first.id}/read`, { method: 'POST' }), 200, NotificationListSchema);
      assert.equal(afterOne.unreadCount, lead.unreadCount - 1);
      const afterAll = await ok(await api('lead', '/notifications/read-all', { method: 'POST' }), 200, NotificationListSchema);
      assert.equal(afterAll.unreadCount, 0);
      assert.equal((await ok(await api('lead', '/notifications?unreadOnly=true'), 200, NotificationListSchema)).items.length, 0);
      await ok(await api('aud', '/notifications'), 200, NotificationListSchema);
    });
  });

  describe('Scheduled reminders (FR-TASK-011, 007)', { concurrency: false }, () => {
    let dueTask: TaskDetail;
    const dueDate = addDaysIso(today, 1);
    const dueAt = dueInstant(dueDate, TZ);
    const at = (hours: number) => new Date(dueAt.getTime() + hours * 3_600_000);

    before(async () => {
      dueTask = await ok(await api('lead', '/tasks', { method: 'POST', body: { title: 'File the permit', assigneeId: U.emp.id, dueDate } }), 201, TaskDetailSchema);
      outbox.outbox.length = 0;
    });

    it('due in 24 h: once per task (re-runs do not duplicate), with email', async () => {
      await work.taskReminders(at(-23));
      await work.taskReminders(at(-22));
      await settle();
      assert.equal(await notifCount(U.emp.id, 'TASK_DUE_SOON_24H'), 1);
      assert.ok(mailsTo('emp').some((m) => m.subject.includes('Due tomorrow: File the permit')));
    });

    it('due within 1 h: in-app only', async () => {
      const before = mailsTo('emp').length;
      await work.taskReminders(at(-0.5));
      await settle();
      assert.equal(await notifCount(U.emp.id, 'TASK_DUE_SOON_1H'), 1);
      assert.equal(mailsTo('emp').length, before);
    });

    it('overdue: assignee and reporter, once', async () => {
      await work.taskReminders(at(2));
      await work.taskReminders(at(5));
      await settle();
      assert.equal(await notifCount(U.emp.id, 'TASK_OVERDUE'), 1);
      assert.equal(await notifCount(U.lead.id, 'TASK_OVERDUE'), 1);
      // done tasks are never reminded
      const t = await ok(await api('emp', `/tasks/${dueTask.id}`), 200, TaskDetailSchema);
      await ok(await api('emp', `/tasks/${t.id}`, { method: 'PATCH', body: { version: t.version, status: 'DONE' } }), 200);
    });

    it('unaccepted tasks escalate after the org setting (2 h) to the reporter and, without a manager, HR', async () => {
      const t = await ok(await api('lead', '/tasks', { method: 'POST', body: { title: 'Inspect roof', assigneeId: U.sub.id } }), 201, TaskDetailSchema);
      const requested = (await adminPool.query(`SELECT acceptance_requested_at FROM tasks WHERE id = $1`, [t.id])).rows[0].acceptance_requested_at as Date;
      await work.taskReminders(new Date(requested.getTime() + 60 * 60_000)); // 1 h: not yet
      assert.equal(await notifCount(U.lead.id, 'TASK_ESCALATED'), 0);
      await work.taskReminders(new Date(requested.getTime() + 3 * 60 * 60_000));
      await work.taskReminders(new Date(requested.getTime() + 4 * 60 * 60_000));
      await settle();
      assert.equal(await notifCount(U.lead.id, 'TASK_ESCALATED'), 1);
      assert.equal(await notifCount(U.hr.id, 'TASK_ESCALATED'), 1, 'the reporter has no manager, so HR is told');
      const detail = await ok(await api('lead', `/tasks/${t.id}`), 200, TaskDetailSchema);
      assert.ok(detail.escalatedAt);
      const activity = await ok(await api('lead', `/tasks/${t.id}/activity`), 200, TaskActivityListSchema);
      assert.ok(activity.some((a) => a.type === 'ESCALATED'));
    });
  });

  describe('Carry-over and weekly summary (FR-TASK-004, 016)', { concurrency: false }, () => {
    it('automatic carry-over moves open tasks planned on earlier days to today, logged', async () => {
      const t = await ok(await api('emp', '/tasks', { method: 'POST', body: { title: 'Old plan', plannedDate: addDaysIso(today, -2) } }), 201, TaskDetailSchema);
      const doneOld = await ok(await api('emp', '/tasks', { method: 'POST', body: { title: 'Old but done', plannedDate: addDaysIso(today, -2) } }), 201, TaskDetailSchema);
      await ok(await api('emp', `/tasks/${doneOld.id}`, { method: 'PATCH', body: { version: doneOld.version, status: 'DONE' } }), 200);
      const moved = await work.carryOver(new Date());
      assert.ok(moved >= 1);
      assert.equal((await ok(await api('emp', `/tasks/${t.id}`), 200, TaskDetailSchema)).plannedDate, today);
      assert.equal((await ok(await api('emp', `/tasks/${doneOld.id}`), 200, TaskDetailSchema)).plannedDate, addDaysIso(today, -2));
      const activity = await ok(await api('emp', `/tasks/${t.id}/activity`), 200, TaskActivityListSchema);
      assert.ok(activity.some((a) => a.data.reason === 'automatic carry-over'));
    });

    it('weekly summary goes to managers and subcontractors once per week, not before Friday 17:00', async () => {
      const weekStart = weekStartOf(today);
      const thursday = fromZonedTime(`${addDaysIso(weekStart, 3)}T18:00:00`, TZ);
      const friday = fromZonedTime(`${addDaysIso(weekStart, 4)}T17:05:00`, TZ);
      assert.equal(await work.weeklySummary(thursday), 0);
      outbox.outbox.length = 0;
      await work.weeklySummary(friday);
      await work.weeklySummary(new Date(friday.getTime() + 30 * 60_000));
      await settle();
      assert.equal(await notifCount(U.lead.id, 'WEEKLY_SUMMARY'), 1);
      assert.equal(await notifCount(U.sub.id, 'WEEKLY_SUMMARY'), 1);
      assert.equal(await notifCount(U.emp.id, 'WEEKLY_SUMMARY'), 0, 'employees are not in the FR-TASK-016 audience');
      const leadMail = mailsTo('lead').find((m) => m.subject.includes('Weekly summary'))!;
      assert.match(leadMail.text, /Eva Emp: \d+ completed, \d+ pending/);
      assert.match(leadMail.text, /h worked/);
      assert.ok(mailsTo('sub').some((m) => m.subject.includes('Weekly summary') && m.text.includes('Your week:')));
    });
  });

  describe('Attendance jobs now scheduled (FR-ATT-002, 015, 020)', { concurrency: false }, () => {
    it('reconciler closes a session whose heartbeats stopped', async () => {
      const now = new Date();
      await adminPool.query(
        `INSERT INTO attendance_sessions (org_id, user_id, device_id, work_date, clock_in_at, clock_in_source, last_heartbeat_at, ip_in, status, current_state)
         VALUES ($1, $2, 'dev-1', $3, $4, 'AUTO_HEARTBEAT', $5, '127.0.0.1', 'OPEN', 'ACTIVE')`,
        [ORG, U.emp.id, today, new Date(now.getTime() - 20 * 60_000), new Date(now.getTime() - 10 * 60_000)],
      );
      // Another worker (e.g. a concurrent BullMQ test app) may close it first; the outcome is what matters.
      await work.attendanceReconcile(now);
      const s = await adminPool.query(`SELECT status, clock_out_source FROM attendance_sessions WHERE user_id = $1 AND device_id = 'dev-1'`, [U.emp.id]);
      assert.equal(s.rows[0].status, 'CLOSED');
    });

    it('daily close runs once per org-local day, only after 00:30', async () => {
      const early = fromZonedTime(`${today}T00:10:00`, TZ);
      const later = fromZonedTime(`${today}T01:00:00`, TZ);
      const yesterdayKey = addDaysIso(today, -1);
      const markers = async () =>
        (await adminPool.query(`SELECT 1 FROM job_runs WHERE org_id = $1 AND job = 'attendance-daily-close' AND run_key = $2`, [ORG, yesterdayKey])).rowCount;
      const before = await markers();
      assert.equal(await work.attendanceDailyClose(early), 0);
      if (before === 0) assert.equal(await markers(), 0, 'nothing runs before 00:30 local');
      await work.attendanceDailyClose(later);
      assert.equal(await work.attendanceDailyClose(new Date(later.getTime() + 3_600_000)), 0, 'once per day');
      const marker = await adminPool.query(`SELECT 1 FROM job_runs WHERE org_id = $1 AND job = 'attendance-daily-close' AND run_key = $2`, [ORG, addDaysIso(today, -1)]);
      assert.equal(marker.rowCount, 1);
    });

    it('presence retention deletes events older than 90 days, once per day', async () => {
      const now = new Date();
      await adminPool.query(
        `INSERT INTO presence_events (org_id, user_id, server_ts, event_type, state, seq) VALUES
         ($1, $2, $3, 'HEARTBEAT', 'ACTIVE', 1), ($1, $2, $4, 'HEARTBEAT', 'ACTIVE', 2)`,
        [ORG, U.emp.id, new Date(now.getTime() - 100 * 86_400_000), new Date(now.getTime() - 86_400_000)],
      );
      // Retention runs once per org-local day; drive a later day so a concurrent scheduler run
      // earlier today (before these rows existed) does not mask the effect.
      const later = new Date(now.getTime() + 2 * 86_400_000);
      await work.presenceRetention(later);
      const left = await adminPool.query(`SELECT seq FROM presence_events WHERE user_id = $1 ORDER BY seq`, [U.emp.id]);
      assert.deepEqual(left.rows.map((r) => Number(r.seq)), [2]);
      assert.equal(await work.presenceRetention(new Date(later.getTime() + 60_000)), 0, 'once per day');
    });
  });
});
