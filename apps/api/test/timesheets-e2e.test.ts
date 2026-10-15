/**
 * Timesheets E2E (FR-TS-001..006, 009, 011): task timers (one at a time, server clock,
 * auto-stop at clock-out), manual time (reason, daily limit flag), the daily draft and
 * reconciliation, periodic timesheets, submit / approve / reject / reopen with locking,
 * payable amounts, visibility (subcontractors see only their own; Finance/Auditor read-only),
 * per-route permissions and RLS.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { generateSync } from 'otplib';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import ExcelJSModule from 'exceljs';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { addDaysIso, weekStartOf } from '../src/planning/planning-rules.ts';
import { ScheduledWorkService } from '../src/notifications/scheduled-work.service.ts';
import { AttendanceService } from '../src/attendance/attendance.service.ts';
import { TaskDetailSchema } from '../../../packages/shared/src/tasks/types.ts';
import type { TaskDetail } from '../../../packages/shared/src/tasks/types.ts';
import {
  RatesListSchema,
  TimeEntryListSchema,
  TimeEntrySchema,
  TimerStateSchema,
  TimesheetDetailSchema,
  TimesheetListSchema,
  TimesheetReportSchema,
  TimesheetSettingsSchema,
} from '../../../packages/shared/src/timesheets/types.ts';
import type { TimesheetDetail } from '../../../packages/shared/src/timesheets/types.ts';

const ORG = 'abab0000-0000-4000-8000-000000000001';
const OTHER_ORG = 'abab0000-0000-4000-8000-000000000002';
const TEAM = 'abab0000-0000-4000-8000-000000000101';
const TEAM2 = 'abab0000-0000-4000-8000-000000000102';
const TZ = 'Asia/Colombo';
const PASSWORD = 'ComplexPassword123!';
const MFA_SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const MFA_ROLES: readonly string[] = ['HR', 'HR_MANAGER'];
const U = {
  hr: { id: 'abab0000-0000-4000-8000-000000000011', role: 'HR', team: null as string | null },
  hrm: { id: 'abab0000-0000-4000-8000-000000000012', role: 'HR_MANAGER', team: null as string | null },
  lead: { id: 'abab0000-0000-4000-8000-000000000013', role: 'TEAM_LEAD', team: TEAM as string | null },
  sub: { id: 'abab0000-0000-4000-8000-000000000014', role: 'SUBCONTRACTOR', team: TEAM as string | null },
  emp: { id: 'abab0000-0000-4000-8000-000000000015', role: 'EMPLOYEE', team: TEAM as string | null },
  sub2: { id: 'abab0000-0000-4000-8000-000000000016', role: 'SUBCONTRACTOR', team: TEAM2 as string | null },
  aud: { id: 'abab0000-0000-4000-8000-000000000017', role: 'AUDITOR', team: null as string | null },
  lead2: { id: 'abab0000-0000-4000-8000-000000000018', role: 'TEAM_LEAD', team: TEAM2 as string | null },
} as const;
type Who = keyof typeof U;
const email = (w: Who) => `${w}@ts.test`;
const ExcelJS = (ExcelJSModule as unknown as { default?: typeof ExcelJSModule }).default ?? ExcelJSModule;

describe('Timesheets API (FR-TS-001..006, 009, 011)', { concurrency: false }, () => {
  let app: INestApplication;
  let base: string;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  const tokens = {} as Record<Who, string>;
  const today = formatInTimeZone(new Date(), TZ, 'yyyy-MM-dd');
  const lastMon = addDaysIso(weekStartOf(today), -7);
  const lastTue = addDaysIso(lastMon, 1);
  let projectId = '';
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
  const openSession = async (who: Who, device = 'dev-1', lastHeartbeatAgoMs = 0) => {
    const now = Date.now();
    await adminPool.query(
      `INSERT INTO attendance_sessions (org_id, user_id, device_id, work_date, clock_in_at, clock_in_source, last_heartbeat_at, ip_in, status, current_state)
       VALUES ($1, $2, $3, $4, $5, 'AUTO_HEARTBEAT', $6, '127.0.0.1', 'OPEN', 'ACTIVE')`,
      [ORG, U[who].id, device, today, new Date(now - 2 * 3_600_000), new Date(now - lastHeartbeatAgoMs)],
    );
  };
  const closeAllSessions = async (who: Who) =>
    adminPool.query(`UPDATE attendance_sessions SET status = 'CLOSED', clock_out_at = last_heartbeat_at, clock_out_source = 'LOGOUT' WHERE user_id = $1 AND status = 'OPEN'`, [U[who].id]);
  const sheetFor = async (who: Who, date: string): Promise<TimesheetDetail> => {
    const list = await ok(await api(who, `/timesheets?scope=mine&from=${date}&to=${date}`), 200, TimesheetListSchema);
    assert.equal(list.items.length, 1, `one timesheet covers ${date}`);
    return await ok(await api(who, `/timesheets/${list.items[0]!.id}`), 200, TimesheetDetailSchema);
  };
  const manual = (who: Who, body: Record<string, unknown>) => api(who, '/time-entries', { method: 'POST', body: { reason: 'Worked offline on the train', ...body } });

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
    appPool = new pg.Pool({
      host: process.env.PGHOST || 'localhost',
      port: Number(process.env.PGPORT || 5433),
      database: process.env.PGDATABASE || 'hrvo_dev',
      user: process.env.PGUSER || 'hrvo_app',
      password: process.env.PGPASSWORD || 'hrvo_app_pass',
    });
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER_ORG]]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'TS Ltd', 'ts-e2e', $2), ($3, 'Other', 'ts-e2e-other', $2)`, [ORG, TZ, OTHER_ORG]);
    await adminPool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $3, 'Build'), ($2, $3, 'Design')`, [TEAM, TEAM2, ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const [k, u] of Object.entries(U)) {
      await adminPool.query(
        `INSERT INTO users (id, org_id, email, display_name, role, team_id, password_hash, status, mfa_enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', false)`,
        [u.id, ORG, email(k as Who), k, u.role, u.team, hash],
      );
    }
    await adminPool.query(`UPDATE users SET manager_id = $1 WHERE id = ANY($2::uuid[])`, [U.lead.id, [U.sub.id, U.emp.id]]);
    await adminPool.query(`UPDATE users SET mfa_enabled = true, mfa_secret = $1 WHERE id = ANY($2::uuid[])`, [MFA_SECRET, [U.hr.id, U.hrm.id]]);

    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(3093);
    base = 'http://localhost:3093';
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email(who), password: PASSWORD, ...(MFA_ROLES.includes(U[who].role) ? { totpCode: generateSync({ secret: MFA_SECRET }) } : {}) }),
      });
      const body = (await res.json()) as { accessToken?: string };
      assert.ok(body.accessToken, `login ${who}`);
      tokens[who] = body.accessToken;
    }
    const project = await ok<{ id: string }>(await api('hr', '/projects', { method: 'POST', body: { name: 'Website', code: 'WEB', billable: true, managerId: U.lead.id } }), 201);
    projectId = project.id;
    await ok(await api('hr', `/projects/${projectId}/members`, { method: 'POST', body: { userId: U.sub.id } }), 201);
    t.a = await ok(await api('lead', '/tasks', { method: 'POST', body: { title: 'Build header', assigneeId: U.sub.id, projectId } }), 201, TaskDetailSchema);
    t.b = await ok(await api('lead', '/tasks', { method: 'POST', body: { title: 'Build footer', assigneeId: U.sub.id, projectId } }), 201, TaskDetailSchema);
    t.pending = await ok(await api('lead', '/tasks', { method: 'POST', body: { title: 'Not accepted yet', assigneeId: U.sub.id } }), 201, TaskDetailSchema);
    await ok(await api('sub', `/tasks/${t.a.id}/accept`, { method: 'POST' }), 200);
    await ok(await api('sub', `/tasks/${t.b.id}/accept`, { method: 'POST' }), 200);
  });

  after(async () => {
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER_ORG]]);
    await adminPool.end();
    await appPool.end();
  });

  describe('Task timers (FR-TS-003)', { concurrency: false }, () => {
    it('needs a clock-in, and an accepted task', async () => {
      const res = await api('sub', `/tasks/${t.a!.id}/timer/start`, { method: 'POST' });
      assert.equal(res.status, 409);
      assert.match(await res.text(), /Clock in/);
      await openSession('sub');
      const pending = await api('sub', `/tasks/${t.pending!.id}/timer/start`, { method: 'POST' });
      assert.equal(pending.status, 409);
      assert.match(await pending.text(), /Accept the task/);
    });

    it('one timer at a time: starting another stops the first; server clock only', async () => {
      const before = Date.now();
      const a = await ok(await api('sub', `/tasks/${t.a!.id}/timer/start`, { method: 'POST', body: { startedAt: '2000-01-01T00:00:00Z' } }), 200, TimerStateSchema);
      assert.equal(a.running?.taskId, t.a!.id);
      assert.equal(a.running?.projectId, projectId);
      assert.ok(new Date(a.running!.startedAt!).getTime() >= before - 1000, 'client timestamps are ignored');
      const again = await ok(await api('sub', `/tasks/${t.a!.id}/timer/start`, { method: 'POST' }), 200, TimerStateSchema);
      assert.equal(again.running?.id, a.running?.id, 'starting the same task again is a no-op');
      const b = await ok(await api('sub', `/tasks/${t.b!.id}/timer/start`, { method: 'POST' }), 200, TimerStateSchema);
      assert.equal(b.running?.taskId, t.b!.id);
      assert.equal(b.stopped?.id, a.running?.id);
      assert.equal(b.stopped?.running, false);
      const running = await adminPool.query(`SELECT count(*)::int AS n FROM time_entries WHERE user_id = $1 AND ended_at IS NULL`, [U.sub.id]);
      assert.equal(running.rows[0].n, 1);
    });

    it('the database itself refuses a second running timer', async () => {
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
        const sheet = await client.query(`SELECT timesheet_id FROM time_entries WHERE user_id = $1 AND ended_at IS NULL`, [U.sub.id]);
        await assert.rejects(
          client.query(
            `INSERT INTO time_entries (org_id, user_id, timesheet_id, work_date, started_at, source) VALUES ($1, $2, $3, $4::date, now(), 'TIMER')`,
            [ORG, U.sub.id, sheet.rows[0].timesheet_id, today],
          ),
          /time_entries_one_running_timer/,
        );
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('stop returns the finished entry; stopping again is a 404', async () => {
      const s = await ok(await api('sub', `/tasks/${t.b!.id}/timer/stop`, { method: 'POST' }), 200, TimerStateSchema);
      assert.equal(s.running, null);
      assert.equal(s.stopped?.taskId, t.b!.id);
      assert.equal((await api('sub', '/timer/stop', { method: 'POST' })).status, 404);
    });

    it('stops automatically at clock-out, at the last valid heartbeat', async () => {
      await closeAllSessions('sub');
      await openSession('sub', 'dev-auto');
      const started = await ok(await api('sub', `/tasks/${t.a!.id}/timer/start`, { method: 'POST' }), 200, TimerStateSchema);
      // Simulate an hour of work, then heartbeats stopping five minutes ago.
      await adminPool.query(`UPDATE time_entries SET started_at = now() - interval '60 minutes' WHERE id = $1`, [started.running!.id]);
      await adminPool.query(`UPDATE attendance_sessions SET last_heartbeat_at = now() - interval '5 minutes' WHERE user_id = $1 AND device_id = 'dev-auto'`, [U.sub.id]);
      await app.get(ScheduledWorkService).attendanceReconcile(new Date());
      const e = await adminPool.query(`SELECT ended_at, minutes, auto_stopped FROM time_entries WHERE id = $1`, [started.running!.id]);
      assert.ok(e.rows[0].ended_at, 'the timer stopped');
      assert.equal(e.rows[0].auto_stopped, true);
      assert.ok(e.rows[0].minutes >= 54 && e.rows[0].minutes <= 56, `about 55 minutes, got ${e.rows[0].minutes}`);
      const state = await ok(await api('sub', '/timer'), 200, TimerStateSchema);
      assert.equal(state.running, null);
    });

    it('keeps running while another device is still clocked in', async () => {
      await openSession('sub', 'dev-laptop');
      await openSession('sub', 'dev-phone', 5 * 60_000);
      const started = await ok(await api('sub', `/tasks/${t.a!.id}/timer/start`, { method: 'POST' }), 200, TimerStateSchema);
      await app.get(ScheduledWorkService).attendanceReconcile(new Date()); // closes only the stale phone session
      const phone = await adminPool.query(`SELECT status FROM attendance_sessions WHERE user_id = $1 AND device_id = 'dev-phone'`, [U.sub.id]);
      assert.equal(phone.rows[0].status, 'CLOSED');
      const state = await ok(await api('sub', '/timer'), 200, TimerStateSchema);
      assert.equal(state.running?.id, started.running?.id);
      await ok(await api('sub', '/timer/stop', { method: 'POST' }), 200);
      await closeAllSessions('sub');
    });

    it('logged time shows as the task actual (FR-TASK-008)', async () => {
      const task = await ok(await api('lead', `/tasks/${t.a!.id}`), 200, TaskDetailSchema);
      assert.ok((task.actualMinutes ?? 0) >= 54);
    });
  });

  describe('Manual time (FR-TS-004)', { concurrency: false }, () => {
    it('requires a reason; no future days; at most 24 h per day', async () => {
      assert.equal((await api('emp', '/time-entries', { method: 'POST', body: { workDate: lastMon, minutes: 30 } })).status, 400);
      assert.equal((await manual('emp', { workDate: lastMon, minutes: 30, reason: '  ' })).status, 400);
      assert.equal((await manual('emp', { workDate: addDaysIso(today, 1), minutes: 30 })).status, 400);
      assert.equal((await manual('emp', { workDate: lastMon, minutes: 24 * 60 + 1 })).status, 400);
    });

    it('is visibly manual and flagged beyond the org daily limit (default 2 h), in order', async () => {
      const first = await ok(await manual('sub', { workDate: lastMon, minutes: 90, note: 'Wireframes' }), 201, TimeEntrySchema);
      assert.equal(first.source, 'MANUAL');
      assert.equal(first.manualReason, 'Worked offline on the train');
      assert.equal(first.flagged, false);
      const second = await ok(await manual('sub', { workDate: lastMon, minutes: 60 }), 201, TimeEntrySchema);
      assert.equal(second.flagged, true);
      assert.equal(second.flagReason, 'MANUAL_LIMIT');
      await ok(await api('sub', `/time-entries/${first.id}`, { method: 'DELETE' }), 200);
      const list = await ok(await api('sub', `/time-entries?from=${lastMon}&to=${lastMon}`), 200, TimeEntryListSchema);
      assert.equal(list.items.find((e) => e.id === second.id)?.flagged, false, 'back within the limit');
      const sheet = await sheetFor('sub', lastMon);
      assert.deepEqual(sheet.days.find((d) => d.date === lastMon)?.flags.includes('MANUAL_LIMIT'), false);
    });

    it('logs against a project the person belongs to, or a visible task', async () => {
      const onProject = await ok(await manual('sub', { workDate: lastTue, minutes: 120, projectId }), 201, TimeEntrySchema);
      assert.equal(onProject.projectName, 'Website');
      assert.equal((await manual('sub2', { workDate: lastTue, minutes: 30, projectId })).status, 404);
      assert.equal((await manual('sub2', { workDate: lastTue, minutes: 30, taskId: t.a!.id })).status, 404);
      const edited = await ok(await api('sub', `/time-entries/${onProject.id}`, { method: 'PATCH', body: { note: 'Header and nav' } }), 200, TimeEntrySchema);
      assert.equal(edited.note, 'Header and nav');
      assert.equal((await api('sub2', `/time-entries/${onProject.id}`, { method: 'PATCH', body: { note: 'x' } })).status, 404);
    });
  });

  describe('Daily draft and reconciliation (FR-TS-001, FR-TS-005)', { concurrency: false }, () => {
    it('the daily close writes attendance into the day and flags variance over 15 %', async () => {
      // 8 h of attendance last Monday; 1 h logged so far (the 60 min manual entry).
      await adminPool.query(
        `INSERT INTO attendance_sessions (org_id, user_id, device_id, work_date, clock_in_at, clock_out_at, clock_in_source, clock_out_source, last_heartbeat_at, ip_in, status, current_state, net_seconds, active_seconds)
         VALUES ($1, $2, 'dev-mon', $3, $4::timestamptz, $4::timestamptz + interval '8 hours', 'AUTO_HEARTBEAT', 'LOGOUT', $4::timestamptz + interval '8 hours', '127.0.0.1', 'CLOSED', 'OFFLINE', 28800, 28800)`,
        [ORG, U.sub.id, lastMon, `${lastMon}T03:30:00Z`],
      );
      await app.get(AttendanceService).runDailyCloseJob(ORG, lastMon);
      let sheet = await sheetFor('sub', lastMon);
      let day = sheet.days.find((d) => d.date === lastMon)!;
      assert.equal(day.attendanceMinutes, 480);
      assert.equal(day.loggedMinutes, 60);
      assert.equal(day.varianceMinutes, -420);
      assert.deepEqual(day.flags, ['VARIANCE']);
      assert.ok(sheet.flaggedDays >= 1);

      await ok(await manual('sub', { workDate: lastMon, minutes: 400, reason: 'Forgot to start the timer' }), 201);
      sheet = await sheetFor('sub', lastMon);
      day = sheet.days.find((d) => d.date === lastMon)!;
      assert.equal(day.loggedMinutes, 460);
      assert.ok(day.flags.includes('MANUAL_LIMIT'));
      assert.ok(!day.flags.includes('VARIANCE'), '20 minutes of 480 is within 15 %');
      assert.equal(sheet.attendanceMinutes, 480);
      assert.equal(sheet.loggedMinutes, 580);
    });

    it('a week of a weekly org: the period is Monday to Sunday and lists every day', async () => {
      const sheet = await sheetFor('sub', lastMon);
      assert.equal(sheet.periodStart, lastMon);
      assert.equal(sheet.periodEnd, addDaysIso(lastMon, 6));
      assert.equal(sheet.days.length, 7);
      assert.equal(sheet.submitDueDate, addDaysIso(lastMon, 7));
      const current = await ok(await api('sub', '/timesheets/current'), 200, TimesheetDetailSchema);
      assert.equal(current.periodStart, weekStartOf(today));
    });
  });

  describe('Org settings (FR-TS-002, 004, 005)', { concurrency: false }, () => {
    it('HR changes the period and limits; validated; employees cannot', async () => {
      const s = await ok(await api('hr', '/timesheets/settings'), 200, TimesheetSettingsSchema);
      assert.deepEqual(s, { period: 'WEEKLY', periodAnchor: '2026-01-05', manualLimitMinutes: 120, variancePct: 15, submitDueDays: 1 });
      assert.equal((await api('emp', '/timesheets/settings', { method: 'PUT', body: s })).status, 403);
      assert.equal((await api('hr', '/timesheets/settings', { method: 'PUT', body: { ...s, periodAnchor: '2026-01-06' } })).status, 400);
      assert.equal((await api('hr', '/timesheets/settings', { method: 'PUT', body: { ...s, variancePct: 60 } })).status, 400);
      const monthly = await ok(await api('hr', '/timesheets/settings', { method: 'PUT', body: { ...s, period: 'MONTHLY' } }), 200, TimesheetSettingsSchema);
      assert.equal(monthly.period, 'MONTHLY');
      // A new timesheet (an employee with none yet, an older date) follows the new setting.
      const old = addDaysIso(lastMon, -60);
      await ok(await manual('emp', { workDate: old, minutes: 30 }), 201);
      const sheet = await sheetFor('emp', old);
      assert.equal(sheet.periodStart, `${old.slice(0, 7)}-01`);
      await ok(await api('hr', '/timesheets/settings', { method: 'PUT', body: s }), 200);
      const audit = await adminPool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = 'TIMESHEET_SETTINGS_UPDATED'`, [ORG]);
      assert.equal(audit.rows[0].n, 2);
    });
  });

  describe('Rates (FR-TS-009)', { concurrency: false }, () => {
    it('HR sets a subcontractor rate and a project override; validated and audited', async () => {
      assert.equal((await api('hr', `/rates/${U.emp.id}`, { method: 'PUT', body: { rateType: 'HOURLY', rate: '10.00', currency: 'USD' } })).status, 400);
      assert.equal((await api('hr', `/rates/${U.sub.id}`, { method: 'PUT', body: { rateType: 'HOURLY', rate: '1e3', currency: 'USD' } })).status, 400);
      assert.equal((await api('hr', `/rates/${U.sub.id}`, { method: 'PUT', body: { rateType: 'HOURLY', rate: 25.5, currency: 'USD' } })).status, 400, 'numbers are refused: money is a string');
      assert.equal((await api('lead', `/rates/${U.sub.id}`, { method: 'PUT', body: { rateType: 'HOURLY', rate: '25.50', currency: 'USD' } })).status, 403);
      const rates = await ok(await api('hr', `/rates/${U.sub.id}`, { method: 'PUT', body: { rateType: 'HOURLY', rate: '25.50', currency: 'USD' } }), 200, RatesListSchema);
      assert.deepEqual(rates.items.find((i) => i.user.id === U.sub.id)?.profile?.rate, '25.50');
      assert.equal(rates.items.find((i) => i.user.id === U.sub.id)?.profile?.overtimeMultiplier, '1.50');
      const withOverride = await ok(await api('hr', `/projects/${projectId}/members/${U.sub.id}/rate`, { method: 'PUT', body: { rateOverride: '30.00' } }), 200, RatesListSchema);
      assert.equal(withOverride.projectRates.find((r) => r.user.id === U.sub.id)?.rateOverride, '30.00');
      const audit = await adminPool.query(`SELECT action FROM audit_logs WHERE org_id = $1 AND action IN ('RATE_PROFILE_SET', 'PROJECT_RATE_SET')`, [ORG]);
      assert.equal(audit.rowCount, 2);
      // Finance/Auditor reads rates, cannot change them.
      await ok(await api('aud', '/rates'), 200, RatesListSchema);
      assert.equal((await api('aud', `/rates/${U.sub.id}`, { method: 'PUT', body: { rateType: 'HOURLY', rate: '1.00', currency: 'USD' } })).status, 403);
      assert.equal((await api('sub', '/rates')).status, 403);
    });
  });

  describe('Submit, approve, reject, reopen (FR-TS-006, 009, 011)', { concurrency: false }, () => {
    let sheet: TimesheetDetail;

    it('shows a live payable estimate before approval', async () => {
      sheet = await sheetFor('sub', lastMon);
      assert.equal(sheet.status, 'DRAFT');
      assert.equal(sheet.payable?.final, false);
      // Mon: 60 + 400 min base rate; Tue: 120 min on Website at 30.00 -> 460/60 x 25.50 + 2 x 30.00
      assert.equal(sheet.payable?.amount, '255.50');
      assert.equal(sheet.payable?.currency, 'USD');
      assert.deepEqual(sheet.permissions, { canView: true, canEdit: true, canSubmit: true, canApprove: false, canReopen: false });
    });

    it('only the owner submits, with the current version, after the period', async () => {
      assert.equal((await api('lead', `/timesheets/${sheet.id}/submit`, { method: 'POST', body: { version: sheet.version } })).status, 403);
      assert.equal((await api('sub', `/timesheets/${sheet.id}/submit`, { method: 'POST', body: { version: sheet.version + 9 } })).status, 409);
      const current = await ok(await api('sub', '/timesheets/current'), 200, TimesheetDetailSchema);
      if (current.periodEnd > today) {
        const early = await api('sub', `/timesheets/${current.id}/submit`, { method: 'POST', body: { version: current.version } });
        assert.equal(early.status, 409, 'the current period is still running');
      }
      sheet = await ok(await api('sub', `/timesheets/${sheet.id}/submit`, { method: 'POST', body: { version: sheet.version } }), 200, TimesheetDetailSchema);
      assert.equal(sheet.status, 'SUBMITTED');
      assert.ok(sheet.submittedAt);
      assert.equal(sheet.approvals.at(-1)?.action, 'SUBMIT');
    });

    it('a submitted timesheet is locked, in the API and in the database', async () => {
      assert.equal((await manual('sub', { workDate: lastTue, minutes: 15 })).status, 409);
      const entry = sheet.entries[0]!;
      assert.equal(entry.editable, false);
      assert.equal((await api('sub', `/time-entries/${entry.id}`, { method: 'DELETE' })).status, 409);
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
        await assert.rejects(client.query(`UPDATE time_entries SET minutes = 1 WHERE id = $1`, [entry.id]), /locked/);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('visibility: subcontractors see only their own; other teams see nothing; the auditor reads all', async () => {
      assert.equal((await api('sub2', `/timesheets/${sheet.id}`)).status, 404);
      const sub2All = await ok(await api('sub2', '/timesheets?scope=all'), 200, TimesheetListSchema);
      assert.ok(sub2All.items.every((s) => s.user.id === U.sub2.id));
      assert.equal((await api('sub2', `/time-entries?from=${lastMon}&to=${lastTue}&userId=${U.sub.id}`)).status, 403);
      assert.equal((await api('lead2', `/timesheets/${sheet.id}`)).status, 404);
      const leadTeam = await ok(await api('lead', '/timesheets?scope=team&status=SUBMITTED'), 200, TimesheetListSchema);
      assert.ok(leadTeam.items.some((s) => s.id === sheet.id));
      const aud = await ok(await api('aud', `/timesheets/${sheet.id}`), 200, TimesheetDetailSchema);
      assert.deepEqual(aud.permissions, { canView: true, canEdit: false, canSubmit: false, canApprove: false, canReopen: false });
      assert.ok((await ok(await api('aud', '/timesheets?scope=all'), 200, TimesheetListSchema)).items.some((s) => s.id === sheet.id));
    });

    it('per-route permissions: the auditor and subcontractors cannot approve; another team cannot', async () => {
      const body = { version: sheet.version };
      assert.equal((await api('aud', `/timesheets/${sheet.id}/approve`, { method: 'POST', body })).status, 403);
      assert.equal((await api('sub', `/timesheets/${sheet.id}/approve`, { method: 'POST', body })).status, 403);
      assert.equal((await api('sub2', `/timesheets/${sheet.id}/approve`, { method: 'POST', body })).status, 403);
      assert.equal((await api('lead2', `/timesheets/${sheet.id}/approve`, { method: 'POST', body })).status, 404);
      assert.equal((await api('aud', '/time-entries', { method: 'POST', body: { workDate: lastMon, minutes: 5, reason: 'x x x' } })).status, 403);
      assert.equal((await api('aud', `/tasks/${t.a!.id}/timer/start`, { method: 'POST' })).status, 403);
    });

    it('reject needs a comment and returns the timesheet to the owner', async () => {
      assert.equal((await api('lead', `/timesheets/${sheet.id}/reject`, { method: 'POST', body: { version: sheet.version, comment: '' } })).status, 400);
      sheet = await ok(await api('lead', `/timesheets/${sheet.id}/reject`, { method: 'POST', body: { version: sheet.version, comment: 'Split Monday by task please' } }), 200, TimesheetDetailSchema);
      assert.equal(sheet.status, 'REJECTED');
      assert.equal(sheet.rejectionReason, 'Split Monday by task please');
      const mine = await ok(await api('sub', `/timesheets/${sheet.id}`), 200, TimesheetDetailSchema);
      assert.equal(mine.permissions.canEdit, true);
      await ok(await manual('sub', { workDate: lastTue, minutes: 30, projectId, reason: 'Review call' }), 201);
      sheet = await ok(await api('sub', `/timesheets/${sheet.id}`), 200, TimesheetDetailSchema);
      sheet = await ok(await api('sub', `/timesheets/${sheet.id}/submit`, { method: 'POST', body: { version: sheet.version } }), 200, TimesheetDetailSchema);
      assert.equal(sheet.rejectionReason, null);
    });

    it('the manager approves; the amount is stored with the currency and the approval is audited', async () => {
      assert.equal((await api('lead', `/timesheets/${sheet.id}/approve`, { method: 'POST', body: { version: sheet.version - 1 } })).status, 409);
      sheet = await ok(await api('lead', `/timesheets/${sheet.id}/approve`, { method: 'POST', body: { version: sheet.version, comment: 'Thanks' } }), 200, TimesheetDetailSchema);
      assert.equal(sheet.status, 'APPROVED');
      assert.equal(sheet.approvedBy?.id, U.lead.id);
      // + 30 min on Website at 30.00
      assert.equal(sheet.amount, '270.50');
      assert.equal(sheet.currency, 'USD');
      assert.equal(sheet.payable?.final, true);
      assert.deepEqual(sheet.permissions.canEdit, false);
      const audit = await adminPool.query(`SELECT after FROM audit_logs WHERE org_id = $1 AND action = 'TIMESHEET_APPROVED' AND entity_id = $2`, [ORG, sheet.id]);
      assert.equal(audit.rowCount, 1);
      assert.equal(audit.rows[0].after.amount, '270.50');
      // Locked: rates changing later do not change an approved amount.
      await ok(await api('hr', `/rates/${U.sub.id}`, { method: 'PUT', body: { rateType: 'HOURLY', rate: '99.00', currency: 'USD' } }), 200);
      assert.equal((await ok(await api('sub', `/timesheets/${sheet.id}`), 200, TimesheetDetailSchema)).amount, '270.50');
      await ok(await api('hr', `/rates/${U.sub.id}`, { method: 'PUT', body: { rateType: 'HOURLY', rate: '25.50', currency: 'USD' } }), 200);
    });

    it('nobody approves their own timesheet, not even HR', async () => {
      await ok(await manual('hr', { workDate: lastMon, minutes: 30 }), 201);
      let own = await sheetFor('hr', lastMon);
      own = await ok(await api('hr', `/timesheets/${own.id}/submit`, { method: 'POST', body: { version: own.version } }), 200, TimesheetDetailSchema);
      assert.equal(own.permissions.canApprove, false);
      const res = await api('hr', `/timesheets/${own.id}/approve`, { method: 'POST', body: { version: own.version } });
      assert.equal(res.status, 403);
      assert.match(await res.text(), /their own/);
      const byHrm = await ok(await api('hrm', `/timesheets/${own.id}/approve`, { method: 'POST', body: { version: own.version } }), 200, TimesheetDetailSchema);
      assert.equal(byHrm.status, 'APPROVED');
      assert.equal(byHrm.payable, null, 'no amount for non-subcontractors');
    });

    it('only timesheet.reopen reopens an approved timesheet, with a reason, audited', async () => {
      assert.equal((await api('lead', `/timesheets/${sheet.id}/reopen`, { method: 'POST', body: { reason: 'Wrong day' } })).status, 403);
      assert.equal((await api('hr', `/timesheets/${sheet.id}/reopen`, { method: 'POST', body: { reason: 'Wrong day' } })).status, 403);
      assert.equal((await api('hrm', `/timesheets/${sheet.id}/reopen`, { method: 'POST', body: { reason: '' } })).status, 400);
      const reopened = await ok(await api('hrm', `/timesheets/${sheet.id}/reopen`, { method: 'POST', body: { reason: 'Client disputes Tuesday' } }), 200, TimesheetDetailSchema);
      assert.equal(reopened.status, 'DRAFT');
      assert.equal(reopened.amount, null);
      assert.equal(reopened.reopenReason, 'Client disputes Tuesday');
      assert.deepEqual(reopened.approvals.map((a) => a.action), ['SUBMIT', 'REJECT', 'SUBMIT', 'APPROVE', 'REOPEN']);
      const audit = await adminPool.query(`SELECT before, after FROM audit_logs WHERE org_id = $1 AND action = 'TIMESHEET_REOPENED' AND entity_id = $2`, [ORG, sheet.id]);
      assert.equal(audit.rows[0].before.amount, '270.50');
      assert.equal(audit.rows[0].after.reason, 'Client disputes Tuesday');
      assert.equal((await api('hrm', `/timesheets/${sheet.id}/reopen`, { method: 'POST', body: { reason: 'Again' } })).status, 409);
    });
  });

  describe('Notifications, reminders and variance alerts (FR-TS-005, 012)', { concurrency: false }, () => {
    const notes = async (who: Who, type: string) =>
      (await adminPool.query<{ title: string; body: string; send_email: boolean }>(
        `SELECT title, body, send_email FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY created_at`,
        [U[who].id, type],
      )).rows;
    const eventually = async <T>(fn: () => Promise<T[]>, n = 1): Promise<T[]> => {
      for (let i = 0; i < 40; i += 1) {
        const rows = await fn();
        if (rows.length >= n) return rows;
        await new Promise((r) => setTimeout(r, 100));
      }
      return await fn();
    };

    it('decisions notified the right people: submissions to the approver, returns and reopenings to the owner', async () => {
      const submitted = await eventually(() => notes('lead', 'TIMESHEET_SUBMITTED'), 2);
      assert.ok(submitted.length >= 2, 'lead was told about both submissions');
      assert.ok(submitted.every((n) => n.send_email && n.title.startsWith('sub submitted a timesheet')));
      const rejected = await eventually(() => notes('sub', 'TIMESHEET_REJECTED'));
      assert.match(rejected[0]!.body, /Split Monday by task please/);
      assert.equal((await eventually(() => notes('sub', 'TIMESHEET_APPROVED'))).length, 1);
      assert.match((await eventually(() => notes('sub', 'TIMESHEET_REOPENED')))[0]!.body, /Client disputes Tuesday/);
      assert.equal((await notes('hrm', 'TIMESHEET_SUBMITTED')).length, 1, 'HR got the lead-less HR timesheet');
      assert.equal((await notes('sub2', 'TIMESHEET_SUBMITTED')).length, 0);
    });

    it('owners are reminded to submit on the last day, then told when overdue; once each', async () => {
      await ok(await manual('sub2', { workDate: lastMon, minutes: 45 }), 201);
      const sheet = await sheetFor('sub2', lastMon);
      const work = app.get(ScheduledWorkService);
      await work.timesheetReminders(fromZonedTime(`${sheet.periodEnd}T12:00:00`, TZ));
      const reminder = await notes('sub2', 'TIMESHEET_SUBMIT_REMINDER');
      assert.equal(reminder.length, 1);
      assert.equal(reminder[0]!.title, `Submit your timesheet by ${sheet.submitDueDate}`);
      await work.timesheetReminders(new Date());
      await work.timesheetReminders(new Date());
      assert.equal((await notes('sub2', 'TIMESHEET_SUBMIT_REMINDER')).length, 1);
      const overdue = await notes('sub2', 'TIMESHEET_OVERDUE');
      assert.equal(overdue.length, 1, `today (${today}) is past ${sheet.submitDueDate}`);
      assert.equal(overdue[0]!.send_email, true);
    });

    it('approvers get one digest a day for timesheets waiting more than 24 h', async () => {
      let sheet = await sheetFor('sub2', lastMon);
      sheet = await ok(await api('sub2', `/timesheets/${sheet.id}/submit`, { method: 'POST', body: { version: sheet.version } }), 200, TimesheetDetailSchema);
      const work = app.get(ScheduledWorkService);
      await work.timesheetReminders(new Date());
      assert.equal((await notes('lead2', 'TIMESHEET_APPROVAL_REMINDER')).length, 0, 'not before 24 h');
      await adminPool.query(`UPDATE timesheets SET submitted_at = now() - interval '30 hours' WHERE id = $1`, [sheet.id]);
      await work.timesheetReminders(new Date());
      await work.timesheetReminders(new Date());
      const digest = await notes('lead2', 'TIMESHEET_APPROVAL_REMINDER');
      assert.equal(digest.length, 1);
      assert.equal(digest[0]!.title, '1 timesheet waiting for your approval');
      assert.match(digest[0]!.body, /sub2: /);
    });

    it('flagged past days raise one in-app variance alert, re-armed only when the figures change', async () => {
      const work = app.get(ScheduledWorkService);
      await work.timesheetReminders(new Date());
      const alerts = await notes('sub', 'TIMESHEET_VARIANCE');
      const monday = alerts.filter((a) => a.title === `Check your time for ${lastMon}`);
      assert.equal(monday.length, 1);
      assert.equal(monday[0]!.send_email, false);
      await work.timesheetReminders(new Date());
      assert.equal((await notes('sub', 'TIMESHEET_VARIANCE')).length, alerts.length);
      const day = await adminPool.query(`SELECT alerted_at FROM timesheet_days WHERE user_id = $1 AND work_date = $2::date`, [U.sub.id, lastMon]);
      assert.ok(day.rows[0].alerted_at);
    });
  });

  describe('Reports and exports (FR-TS-013)', { concurrency: false }, () => {
    const range = () => `from=${addDaysIso(lastMon, -90)}&to=${today}`;

    it('re-approval stores the amount again (setup for cost)', async () => {
      let sheet = await sheetFor('sub', lastMon);
      sheet = await ok(await api('sub', `/timesheets/${sheet.id}/submit`, { method: 'POST', body: { version: sheet.version } }), 200, TimesheetDetailSchema);
      sheet = await ok(await api('lead', `/timesheets/${sheet.id}/approve`, { method: 'POST', body: { version: sheet.version } }), 200, TimesheetDetailSchema);
      assert.equal(sheet.amount, '270.50');
    });

    it('by person: a lead sees their team only; cost per currency; approval turnaround', async () => {
      const r = await ok(await api('lead', `/timesheets/reports?groupBy=user&${range()}`), 200, TimesheetReportSchema);
      const labels = r.rows.map((x) => x.label);
      assert.ok(labels.includes('sub') && labels.includes('emp'));
      assert.ok(!labels.includes('sub2') && !labels.includes('lead'), 'other teams and self are out of scope');
      const sub = r.rows.find((x) => x.label === 'sub')!;
      assert.deepEqual(sub.cost, { USD: '270.50' });
      assert.equal(sub.approvedMinutes, 610);
      assert.ok(sub.avgApprovalHours !== null && sub.avgApprovalHours >= 0);
      assert.ok(sub.flaggedDays >= 1);
    });

    it('by project, team and period; Finance/Auditor sees everyone', async () => {
      const byProject = await ok(await api('aud', `/timesheets/reports?groupBy=project&${range()}`), 200, TimesheetReportSchema);
      const web = byProject.rows.find((x) => x.label === 'Website')!;
      assert.deepEqual(web.cost, { USD: '75.00' }, '2 h 30 m on Website at the 30.00 override');
      assert.deepEqual(byProject.rows.find((x) => x.label === 'No project')?.cost, { USD: '195.50' });
      const byTeam = await ok(await api('aud', `/timesheets/reports?groupBy=team&${range()}`), 200, TimesheetReportSchema);
      assert.ok(byTeam.rows.some((x) => x.label === 'Build') && byTeam.rows.some((x) => x.label === 'Design'));
      const byPeriod = await ok(await api('hr', `/timesheets/reports?groupBy=period&${range()}`), 200, TimesheetReportSchema);
      assert.ok(byPeriod.rows.some((x) => x.key === lastMon));
      const projectOnly = await ok(await api('aud', `/timesheets/reports?groupBy=user&projectId=${projectId}&${range()}`), 200, TimesheetReportSchema);
      assert.deepEqual(projectOnly.rows.map((x) => x.label), ['sub']);
    });

    it('subcontractors and employees cannot run reports; ranges are bounded', async () => {
      assert.equal((await api('sub', `/timesheets/reports?${range()}`)).status, 403);
      assert.equal((await api('emp', `/timesheets/reports?${range()}`)).status, 403);
      assert.equal((await api('aud', `/timesheets/reports?from=2025-01-01&to=2026-12-31`)).status, 400);
      assert.equal((await api('aud', `/timesheets/reports?from=${today}&to=${lastMon}`)).status, 400);
    });

    it('CSV export: a download, formula injection neutralised, audited', async () => {
      await adminPool.query(`UPDATE users SET display_name = '=HYPERLINK("http://evil.test","x")' WHERE id = $1`, [U.emp.id]);
      try {
        const res = await api('aud', `/timesheets/reports?groupBy=user&format=csv&${range()}`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') ?? '', /^text\/csv/);
        assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="timesheets-by-user-.*\.csv"/);
        // res.text() would strip the BOM; keep it to prove Excel gets UTF-8.
        const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
        assert.ok(csv.startsWith('﻿Person,Timesheets,Attendance (h),Logged (h),Approved (h),Variance (h),Flagged days,Cost USD,Avg approval (h)'));
        assert.ok(csv.includes(`"'=HYPERLINK(""http://evil.test"",""x"")"`), 'the formula is quoted and prefixed');
        assert.ok(!/(^|,)=HYPERLINK/m.test(csv));
        const subLine = csv.split('\r\n').find((l) => l.startsWith('sub,'))!;
        assert.match(subLine, /^sub,\d+,8,[\d.]+,10\.17,[\d.-]+,\d+,270\.5,[\d.]+$/, 'hours as numbers, 2 decimals; cost as a plain amount');
        assert.ok(!csv.split('\r\n').some((l) => l.startsWith('aud,')), 'no timesheets for the read-only auditor');

        const xlsx = await api('aud', `/timesheets/reports?groupBy=user&format=xlsx&${range()}`);
        assert.equal(xlsx.status, 200);
        assert.equal(xlsx.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(Buffer.from(await xlsx.arrayBuffer()) as unknown as ArrayBuffer);
        const ws = wb.getWorksheet('Timesheets')!;
        const names: unknown[] = [];
        ws.eachRow((row, i) => {
          if (i > 1) names.push(row.getCell(1).value);
          row.eachCell((c) => assert.notEqual(c.type, ExcelJS.ValueType.Formula));
        });
        assert.ok(names.includes(`'=HYPERLINK("http://evil.test","x")`));
        const subRow = ws.getRows(2, ws.rowCount - 1)!.find((r) => r.getCell(1).value === 'sub')!;
        assert.equal(subRow.getCell(8).value, 270.5);
      } finally {
        await adminPool.query(`UPDATE users SET display_name = 'emp' WHERE id = $1`, [U.emp.id]);
      }
      const audit = await adminPool.query(`SELECT after FROM audit_logs WHERE org_id = $1 AND action = 'TIMESHEET_REPORT_EXPORTED' ORDER BY created_at`, [ORG]);
      assert.equal(audit.rowCount, 2);
      assert.equal(audit.rows[1].after.format, 'xlsx');
    });
  });

  describe('Row-Level Security and legacy data', { concurrency: false }, () => {
    it('every timesheet table is tenant-isolated; approvals are append-only; the legacy table is closed', async () => {
      for (const table of ['timesheets', 'timesheet_days', 'time_entries', 'timesheet_approvals', 'subcontractor_profiles']) {
        const none = await appPool.query(`SELECT count(*)::int AS n FROM ${table}`);
        assert.equal(none.rows[0].n, 0, `${table} without tenant context`);
        const client = await appPool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`SELECT set_config('app.org_id', $1, true)`, [OTHER_ORG]);
          const other = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
          assert.equal(other.rows[0].n, 0, `${table} from another org`);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      }
      await assert.rejects(appPool.query(`UPDATE timesheet_approvals SET comment = 'x'`), /permission denied/);
      await assert.rejects(appPool.query(`DELETE FROM timesheets`), /permission denied/);
      await assert.rejects(appPool.query(`SELECT 1 FROM draft_timesheets_legacy`), /permission denied/);
    });
  });
});
