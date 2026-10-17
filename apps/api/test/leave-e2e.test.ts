/**
 * Leave requests and the public holiday calendar (FR-ORG-010, FR-ORG-011, FR-ATT-022; ADR 027),
 * written before the implementation. Employees request leave (annual, sick, unpaid, other);
 * their manager or HR approves or rejects; HR keeps the holiday calendar (Sri Lanka defaults).
 * Approved leave and holidays reach attendance through the real providers: expected hours drop
 * to zero, absence and late flags are suppressed, the live board shows "On leave", and the
 * no-clock-in reminder stays quiet.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { generateSync } from 'otplib';
import { formatInTimeZone } from 'date-fns-tz';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { AttendanceService } from '../src/attendance/attendance.service.ts';
import { HolidayListSchema, LeaveRequestListSchema, LeaveRequestSchema } from '../../../packages/shared/src/attendance/leave.ts';
import type { LeaveRequest } from '../../../packages/shared/src/attendance/leave.ts';
import { LiveBoardSchema } from '../../../packages/shared/src/attendance/api.ts';

const ORG = '1ea10000-0000-4000-8000-000000000001';
const OTHER = '1ea10000-0000-4000-8000-000000000002';
const TEAM = '1ea10000-0000-4000-8000-000000000101';
const TEAM2 = '1ea10000-0000-4000-8000-000000000102';
const PORT = 3057;
const PASSWORD = 'ComplexPassword123!';
const MFA_SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD'; // test-only; HR must have 2FA enrolled (FR-AUTH-004)
const U = {
  hr: { id: '1ea10000-0000-4000-8000-000000000011', email: 'hr@leave.test', role: 'HR', team: null as string | null },
  lead: { id: '1ea10000-0000-4000-8000-000000000012', email: 'lead@leave.test', role: 'TEAM_LEAD', team: TEAM as string | null },
  emp: { id: '1ea10000-0000-4000-8000-000000000013', email: 'emp@leave.test', role: 'EMPLOYEE', team: TEAM as string | null },
  lead2: { id: '1ea10000-0000-4000-8000-000000000014', email: 'lead2@leave.test', role: 'TEAM_LEAD', team: TEAM2 as string | null },
  auditor: { id: '1ea10000-0000-4000-8000-000000000015', email: 'aud@leave.test', role: 'AUDITOR', team: null as string | null },
} as const;
type Who = keyof typeof U;
const TZ = 'Asia/Colombo';
const dayPlus = (n: number) => formatInTimeZone(new Date(Date.now() + n * 86_400_000), TZ, 'yyyy-MM-dd');
const SCHEDULE = { '1': { startTime: '09:00', endTime: '17:00', expectedHours: 8 }, '2': { startTime: '09:00', endTime: '17:00', expectedHours: 8 }, '3': { startTime: '09:00', endTime: '17:00', expectedHours: 8 }, '4': { startTime: '09:00', endTime: '17:00', expectedHours: 8 }, '5': { startTime: '09:00', endTime: '17:00', expectedHours: 8 }, '6': { startTime: '09:00', endTime: '17:00', expectedHours: 8 }, '7': { startTime: '09:00', endTime: '17:00', expectedHours: 8 } };

describe('Leave and public holidays (FR-ORG-010, FR-ORG-011, FR-ATT-022)', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  let attendance: AttendanceService;
  const tokens = {} as Record<Who, string>;
  const base = `http://localhost:${PORT}`;

  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  async function ok<T>(res: Response, status: number, schema?: { parse: (v: unknown) => T }): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return schema ? schema.parse(JSON.parse(text)) : (JSON.parse(text || 'null') as T);
  }
  const notes = async (who: Who, type: string) => (await adminPool.query(`SELECT title FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY created_at`, [U[who].id, type])).rows;
  const audits = async (action: string) => (await adminPool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = $2`, [ORG, action])).rows[0].n as number;

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    const pgBase = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev' };
    adminPool = new pg.Pool({ ...pgBase, user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    appPool = new pg.Pool({ ...pgBase, user: process.env.PGUSER || 'hrvo_app', password: process.env.PGPASSWORD || 'hrvo_app_pass' });
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Leave Ltd', 'leave-e2e', $3), ($2, 'Other', 'leave-e2e-other', $3)`, [ORG, OTHER, TZ]);
    await adminPool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $3, 'Alpha'), ($2, $3, 'Beta')`, [TEAM, TEAM2, ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const [k, u] of Object.entries(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, team_id, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`, [u.id, ORG, u.email, k, u.role, u.team, hash]);
    }
    await adminPool.query(`UPDATE users SET manager_id = $1 WHERE id = $2`, [U.lead.id, U.emp.id]);
    await adminPool.query(`UPDATE users SET mfa_enabled = true, mfa_secret = $1 WHERE id = $2`, [MFA_SECRET, U.hr.id]);
    await adminPool.query(`UPDATE teams SET lead_id = $1 WHERE id = $2`, [U.lead.id, TEAM]);
    await adminPool.query(`INSERT INTO work_schedules (org_id, user_id, days, flexible, grace_minutes, effective_from) VALUES ($1, $2, $3, false, 10, '2026-01-01')`, [ORG, U.emp.id, JSON.stringify(SCHEDULE)]);
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    attendance = app.get(AttendanceService);
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD, ...(who === 'hr' ? { totpCode: generateSync({ secret: MFA_SECRET }) } : {}) }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
      assert.ok(tokens[who], `login ${who}`);
    }
  });

  after(async () => {
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.end();
    await appPool.end();
  });

  let future: LeaveRequest;
  it('an employee requests leave; input is validated; the manager is told', async () => {
    assert.equal((await api('auditor', '/leave/requests', { method: 'POST', body: { type: 'ANNUAL', startDate: dayPlus(10), endDate: dayPlus(11) } })).status, 403, 'auditors do not take leave here');
    assert.equal((await api('emp', '/leave/requests', { method: 'POST', body: { type: 'ANNUAL', startDate: dayPlus(11), endDate: dayPlus(10) } })).status, 400, 'end before start');
    assert.equal((await api('emp', '/leave/requests', { method: 'POST', body: { type: 'HOLIDAY', startDate: dayPlus(10), endDate: dayPlus(10) } })).status, 400, 'unknown type');
    assert.equal((await api('emp', '/leave/requests', { method: 'POST', body: { type: 'ANNUAL', startDate: dayPlus(10), endDate: dayPlus(200) } })).status, 400, 'too long');
    future = await ok(await api('emp', '/leave/requests', { method: 'POST', body: { type: 'ANNUAL', startDate: dayPlus(10), endDate: dayPlus(11), reason: 'Family visit' } }), 201, LeaveRequestSchema);
    assert.equal(future.status, 'PENDING');
    assert.equal(future.days, 2);
    assert.equal(future.canCancel, true);
    assert.equal(future.canDecide, false, 'not by the requester');
    assert.equal((await notes('lead', 'LEAVE_REQUESTED')).length, 1, 'the manager is told');
    assert.equal(await audits('LEAVE_REQUESTED'), 1);
    assert.equal((await api('emp', '/leave/requests', { method: 'POST', body: { type: 'SICK', startDate: dayPlus(11), endDate: dayPlus(12) } })).status, 409, 'overlaps an open request');
  });

  it('only the manager (or HR) decides; never the requester; another team\'s lead cannot', async () => {
    assert.equal((await api('emp', `/leave/requests/${future.id}/decide`, { method: 'POST', body: { approved: true } })).status, 403);
    assert.equal((await api('lead2', `/leave/requests/${future.id}/decide`, { method: 'POST', body: { approved: true } })).status, 403, 'not their report');
    const team = await ok(await api('lead', '/leave/requests?scope=team'), 200, LeaveRequestListSchema);
    assert.deepEqual(team.items.map((r) => r.id), [future.id]);
    assert.equal(team.items[0]!.canDecide, true);
    assert.equal((await ok(await api('lead2', '/leave/requests?scope=team'), 200, LeaveRequestListSchema)).items.length, 0);
    assert.equal((await ok(await api('hr', '/leave/requests?scope=team'), 200, LeaveRequestListSchema)).items.length, 1, 'HR sees the organisation');
    assert.equal((await api('lead', `/leave/requests/${future.id}/decide`, { method: 'POST', body: { approved: false } })).status, 400, 'a rejection needs a note');
    const decided = await ok(await api('lead', `/leave/requests/${future.id}/decide`, { method: 'POST', body: { approved: true, note: 'Enjoy' } }), 200, LeaveRequestSchema);
    assert.equal(decided.status, 'APPROVED');
    assert.equal(decided.decidedBy?.id, U.lead.id);
    assert.equal((await notes('emp', 'LEAVE_APPROVED')).length, 1);
    assert.equal((await api('lead', `/leave/requests/${future.id}/decide`, { method: 'POST', body: { approved: false, note: 'changed my mind' } })).status, 409, 'decided once');
    assert.equal(await audits('LEAVE_APPROVED'), 1);
  });

  it('approved leave: expected hours are zero, no absence flag, the day is LEAVE, the reminder stays quiet', async () => {
    const day = dayPlus(10);
    const daily = await attendance.computeDailySummary(ORG, U.emp.id, day);
    assert.equal(daily.dayStatus, 'LEAVE');
    assert.equal(daily.expectedSeconds, 0);
    assert.equal(daily.lateMinutes, 0);
    const other = await attendance.computeDailySummary(ORG, U.emp.id, dayPlus(13));
    assert.equal(other.dayStatus, 'ABSENT', 'a scheduled day without leave or sessions is absent');
    assert.equal(other.expectedSeconds, 8 * 3600);
    const reminder = await attendance.clockInReminderDue(ORG, U.emp.id, new Date(`${day}T06:00:00Z`)); // 11:30 in Colombo, two hours after the 09:00 start
    assert.equal(reminder.due, false);
  });

  it('leave today shows as "On leave" on the live board; cancelling it removes it at once', async () => {
    const today = dayPlus(0);
    const sick = await ok(await api('emp', '/leave/requests', { method: 'POST', body: { type: 'SICK', startDate: today, endDate: today, reason: 'Flu' } }), 201, LeaveRequestSchema);
    await ok(await api('hr', `/leave/requests/${sick.id}/decide`, { method: 'POST', body: { approved: true } }), 200, LeaveRequestSchema);
    let board = await ok(await api('lead', '/attendance/live'), 200, LiveBoardSchema);
    assert.equal(board.find((r) => r.userId === U.emp.id)?.status, 'ON_LEAVE');
    const mine = await ok(await api('emp', '/leave/requests?scope=mine'), 200, LeaveRequestListSchema);
    assert.deepEqual(mine.items.map((r) => r.status).sort(), ['APPROVED', 'APPROVED']);
    assert.equal((await api('lead', `/leave/requests/${sick.id}/cancel`, { method: 'POST' })).status, 403, 'only the requester cancels');
    const cancelled = await ok(await api('emp', `/leave/requests/${sick.id}/cancel`, { method: 'POST' }), 200, LeaveRequestSchema);
    assert.equal(cancelled.status, 'CANCELLED');
    board = await ok(await api('lead', '/attendance/live'), 200, LiveBoardSchema);
    assert.equal(board.find((r) => r.userId === U.emp.id)?.status, 'OFFLINE');
    assert.equal(await audits('LEAVE_CANCELLED'), 1);
  });

  it('a rejected request tells the requester why', async () => {
    const r = await ok(await api('emp', '/leave/requests', { method: 'POST', body: { type: 'UNPAID', startDate: dayPlus(20), endDate: dayPlus(20) } }), 201, LeaveRequestSchema);
    const d = await ok(await api('lead', `/leave/requests/${r.id}/decide`, { method: 'POST', body: { approved: false, note: 'Release week' } }), 200, LeaveRequestSchema);
    assert.equal(d.status, 'REJECTED');
    assert.equal(d.decisionNote, 'Release week');
    assert.match((await notes('emp', 'LEAVE_REJECTED'))[0].title, /rejected|declined/i);
    assert.equal((await attendance.computeDailySummary(ORG, U.emp.id, dayPlus(20))).dayStatus, 'ABSENT', 'rejected leave changes nothing');
  });

  it('HR keeps the public holiday calendar; Sri Lanka 2026 defaults load in one step', async () => {
    const empty = await ok(await api('emp', '/holidays?year=2026'), 200, HolidayListSchema);
    assert.equal(empty.items.length, 0);
    assert.equal(empty.defaultsAvailable, true);
    assert.equal((await api('emp', '/holidays', { method: 'POST', body: { date: '2026-12-31', name: 'Company day' } })).status, 403);
    assert.equal((await api('lead', '/holidays/defaults', { method: 'POST', body: { year: 2026 } })).status, 403);
    const loaded = await ok(await api('hr', '/holidays/defaults', { method: 'POST', body: { year: 2026 } }), 200, HolidayListSchema);
    assert.equal(loaded.items.length, 25, 'the 2026 gazette: 25 dates (May Day and Vesak share 1 May)');
    assert.ok(loaded.items.some((h) => h.date === '2026-02-04' && /Independence/.test(h.name)));
    assert.ok(loaded.items.some((h) => h.date === '2026-05-01' && /Vesak/.test(h.name)));
    assert.equal((await ok(await api('hr', '/holidays/defaults', { method: 'POST', body: { year: 2026 } }), 200, HolidayListSchema)).items.length, 25, 'loading again adds nothing');
    assert.equal((await api('hr', '/holidays/defaults', { method: 'POST', body: { year: 2031 } })).status, 404, 'no built-in calendar for that year');
    const added = await ok(await api('hr', '/holidays', { method: 'POST', body: { date: '2026-12-31', name: 'Company day' } }), 201, HolidayListSchema);
    assert.equal(added.items.length, 26);
    const renamed = await ok(await api('hr', '/holidays', { method: 'POST', body: { date: '2026-12-31', name: 'Company closure' } }), 201, HolidayListSchema);
    assert.equal(renamed.items.length, 26, 'one row per date');
    assert.equal(renamed.items.find((h) => h.date === '2026-12-31')?.name, 'Company closure');
    const id = renamed.items.find((h) => h.date === '2026-12-31')!.id;
    assert.equal((await ok(await api('hr', `/holidays/${id}`, { method: 'DELETE' }), 200, HolidayListSchema)).items.length, 25);
    assert.equal(await audits('HOLIDAY_ADDED'), 2);
    assert.equal(await audits('HOLIDAY_REMOVED'), 1);
    assert.equal(await audits('HOLIDAYS_DEFAULTS_LOADED'), 1);
    assert.equal((await ok(await api('emp', '/holidays?year=2027'), 200, HolidayListSchema)).defaultsAvailable, false);
  });

  it('a holiday is excluded from expected time and suppresses the absence flag', async () => {
    // 4 February 2026, Independence Day, a Wednesday on the employee's 7-day schedule.
    const daily = await attendance.computeDailySummary(ORG, U.emp.id, '2026-02-04');
    assert.equal(daily.dayStatus, 'HOLIDAY');
    assert.equal(daily.expectedSeconds, 0);
    assert.equal((await attendance.computeDailySummary(ORG, U.emp.id, '2026-02-05')).dayStatus, 'ABSENT');
    assert.equal((await attendance.clockInReminderDue(ORG, U.emp.id, new Date('2026-02-04T06:00:00Z'))).due, false);
  });

  it('RLS: another organisation sees nothing; the app role cannot delete leave requests', async () => {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [OTHER]);
      assert.equal((await c.query(`SELECT 1 FROM leave_requests`)).rowCount, 0);
      assert.equal((await c.query(`SELECT 1 FROM public_holidays`)).rowCount, 0);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
      assert.ok((await c.query(`SELECT 1 FROM leave_requests`)).rowCount! >= 3);
      await assert.rejects(c.query(`DELETE FROM leave_requests`), /permission denied/);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [OTHER]);
      await assert.rejects(c.query(`INSERT INTO public_holidays (org_id, date, name) VALUES ($1, '2026-06-01', 'x')`, [ORG]), /row-level security/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });
});
