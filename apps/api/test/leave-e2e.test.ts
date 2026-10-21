import { AttendanceStateMachine } from '../src/attendance/attendance-state-machine.ts';
import { freshCode } from './support/totp.ts';
import { PgLeaveProvider, PgHolidayProvider } from '../src/attendance/leave-providers.ts';
import { PrismaService } from '../src/common/prisma.service.ts';
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
import { formatInTimeZone } from 'date-fns-tz';
import { SRI_LANKA_HOLIDAYS } from '../src/leave/sri-lanka-holidays.ts';
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
// The test organisation gets the Sri Lanka default calendar when it is created, and a holiday turns
// ABSENT into HOLIDAY and expected hours into 0. Days that must be ordinary working days skip it, so
// the suite passes on every calendar date (it failed on 19 October 2026: day +20 was Deepavali).
const DEFAULT_HOLIDAYS = new Set(Object.values(SRI_LANKA_HOLIDAYS).flat().map((h) => h.date));
const workingOffset = (from: number, span = 1) => {
  let n = from;
  while (Array.from({ length: span }, (_, i) => dayPlus(n + i)).some((d) => DEFAULT_HOLIDAYS.has(d))) n += 1;
  return n;
};
const FUTURE = workingOffset(10, 4); // annual leave on +0..+1, the overlap probe on +1..+2, a plain absent day on +3
const REJECT_DAY = workingOffset(Math.max(20, FUTURE + 4));
const OTHER_DAY = workingOffset(Math.max(30, REJECT_DAY + 1));
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
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD, ...(who === 'hr' ? { totpCode: await freshCode(MFA_SECRET) } : {}) }) });
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
    assert.equal((await api('auditor', '/leave/requests', { method: 'POST', body: { type: 'ANNUAL', startDate: dayPlus(FUTURE), endDate: dayPlus(FUTURE + 1) } })).status, 403, 'auditors do not take leave here');
    assert.equal((await api('emp', '/leave/requests', { method: 'POST', body: { type: 'ANNUAL', startDate: dayPlus(FUTURE + 1), endDate: dayPlus(FUTURE) } })).status, 400, 'end before start');
    assert.equal((await api('emp', '/leave/requests', { method: 'POST', body: { type: 'HOLIDAY', startDate: dayPlus(FUTURE), endDate: dayPlus(FUTURE) } })).status, 400, 'unknown type');
    assert.equal((await api('emp', '/leave/requests', { method: 'POST', body: { type: 'ANNUAL', startDate: dayPlus(FUTURE), endDate: dayPlus(200) } })).status, 400, 'too long');
    future = await ok(await api('emp', '/leave/requests', { method: 'POST', body: { type: 'ANNUAL', startDate: dayPlus(FUTURE), endDate: dayPlus(FUTURE + 1), reason: 'Family visit' } }), 201, LeaveRequestSchema);
    assert.equal(future.status, 'PENDING');
    assert.equal(future.days, 2);
    assert.equal(future.canCancel, true);
    assert.equal(future.canDecide, false, 'not by the requester');
    assert.equal((await notes('lead', 'LEAVE_REQUESTED')).length, 1, 'the manager is told');
    assert.equal(await audits('LEAVE_REQUESTED'), 1);
    assert.equal((await api('emp', '/leave/requests', { method: 'POST', body: { type: 'SICK', startDate: dayPlus(FUTURE + 1), endDate: dayPlus(FUTURE + 2) } })).status, 409, 'overlaps an open request');
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
    await attendance.recomputeDailySummaryForUser(ORG, U.emp.id, dayPlus(FUTURE));
    const decided = await ok(await api('lead', `/leave/requests/${future.id}/decide`, { method: 'POST', body: { approved: true, note: 'Enjoy' } }), 200, LeaveRequestSchema);
    assert.equal(decided.status, 'APPROVED');
    assert.equal((await adminPool.query(`SELECT expected_seconds FROM attendance_daily WHERE org_id = $1 AND user_id = $2 AND work_date = $3`, [ORG, U.emp.id, dayPlus(FUTURE)])).rows[0].expected_seconds, 0, 'approval refreshes existing daily expectations immediately');
    assert.equal(decided.decidedBy?.id, U.lead.id);
    assert.equal((await notes('emp', 'LEAVE_APPROVED')).length, 1);
    assert.equal((await api('lead', `/leave/requests/${future.id}/decide`, { method: 'POST', body: { approved: false, note: 'changed my mind' } })).status, 409, 'decided once');
    assert.equal(await audits('LEAVE_APPROVED'), 1);
  });

  it('approved leave: expected hours are zero, no absence flag, the day is LEAVE, the reminder stays quiet', async () => {
    const day = dayPlus(FUTURE);
    const daily = await attendance.computeDailySummary(ORG, U.emp.id, day);
    assert.equal(daily.dayStatus, 'LEAVE');
    assert.equal(daily.expectedSeconds, 0);
    assert.equal(daily.lateMinutes, 0);
    const late = new AttendanceStateMachine({ orgTimezone: TZ }).handleHeartbeat(null, {
      orgId: ORG, userId: U.emp.id, sessionId: 'leave-late', deviceId: 'test', sequenceNumber: 1, nonce: 'test', signature: 'test',
      activeSeconds: 30, idleSeconds: 0, inCall: false, tabVisible: true, windowFocused: true,
    }, new Date(`${day}T06:00:00Z`), '127.0.0.1').session;
    const compliance = await attendance.computeScheduleCompliance({ orgId: ORG, userId: U.emp.id, workDate: day, sessions: [late] });
    assert.equal(compliance.lateArrivalMinutes, 0);
    assert.equal(compliance.isAbsent, false);
    assert.deepEqual(compliance.flags, ['ON_LEAVE']);
    const other = await attendance.computeDailySummary(ORG, U.emp.id, dayPlus(FUTURE + 3));
    assert.equal(other.dayStatus, 'ABSENT', 'a scheduled day without leave or sessions is absent');
    assert.equal(other.expectedSeconds, 8 * 3600);
    const reminder = await attendance.clockInReminderDue(ORG, U.emp.id, new Date(`${day}T06:00:00Z`)); // 11:30 in Colombo, two hours after the 09:00 start
    assert.equal(reminder.due, false);
  });

  it('leave today shows as "On leave" on the live board and can no longer be cancelled once it has started', async () => {
    const today = dayPlus(0);
    const otherProcess = new PgLeaveProvider(app.get(PrismaService));
    assert.equal(await otherProcess.isUserOnApprovedLeave(ORG, U.emp.id, today), false);
    const sick = await ok(await api('emp', '/leave/requests', { method: 'POST', body: { type: 'SICK', startDate: today, endDate: today, reason: 'Flu' } }), 201, LeaveRequestSchema);
    await ok(await api('hr', `/leave/requests/${sick.id}/decide`, { method: 'POST', body: { approved: true } }), 200, LeaveRequestSchema);
    assert.equal(await otherProcess.isUserOnApprovedLeave(ORG, U.emp.id, today), true, 'approval is immediately visible on another API process');
    const board = await ok(await api('lead', '/attendance/live'), 200, LiveBoardSchema);
    assert.equal(board.find((r) => r.userId === U.emp.id)?.status, 'ON_LEAVE');
    const mine = await ok(await api('emp', '/leave/requests?scope=mine'), 200, LeaveRequestListSchema);
    assert.deepEqual(mine.items.map((r) => r.status).sort(), ['APPROVED', 'APPROVED']);
    assert.equal(mine.items.find((r) => r.id === sick.id)?.canCancel, false, 'started leave offers no cancel button');
    assert.equal((await api('lead', `/leave/requests/${sick.id}/cancel`, { method: 'POST' })).status, 403, 'only the requester cancels');
    // Cancelling after the first day has begun would turn days already taken into absences.
    assert.equal((await api('emp', `/leave/requests/${sick.id}/cancel`, { method: 'POST' })).status, 409);
    assert.equal(await otherProcess.isUserOnApprovedLeave(ORG, U.emp.id, today), true, 'the refused cancel changed nothing');
    // Leave that started in the past and runs on is refused too.
    const running = await adminPool.query<{ id: string }>(
      `INSERT INTO leave_requests (org_id, user_id, type, start_date, end_date, status, decided_by, decided_at) VALUES ($1, $2, 'ANNUAL', $3, $4, 'APPROVED', $5, now()) RETURNING id`,
      [ORG, U.emp.id, dayPlus(-3), dayPlus(5), U.hr.id]);
    assert.equal((await api('emp', `/leave/requests/${running.rows[0]!.id}/cancel`, { method: 'POST' })).status, 409, 'started three days ago, ends in five');
    assert.equal(await audits('LEAVE_CANCELLED'), 0);
  });

  it('approved leave that starts in the future can be cancelled, and that is visible at once', async () => {
    const day = dayPlus(60);
    const otherProcess = new PgLeaveProvider(app.get(PrismaService));
    const trip = await ok(await api('emp', '/leave/requests', { method: 'POST', body: { type: 'ANNUAL', startDate: day, endDate: day } }), 201, LeaveRequestSchema);
    await ok(await api('hr', `/leave/requests/${trip.id}/decide`, { method: 'POST', body: { approved: true } }), 200, LeaveRequestSchema);
    assert.equal(await otherProcess.isUserOnApprovedLeave(ORG, U.emp.id, day), true);
    assert.equal((await ok(await api('emp', `/leave/requests/${trip.id}`), 200, LeaveRequestSchema)).canCancel, true);
    const cancelled = await ok(await api('emp', `/leave/requests/${trip.id}/cancel`, { method: 'POST' }), 200, LeaveRequestSchema);
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(await otherProcess.isUserOnApprovedLeave(ORG, U.emp.id, day), false, 'cancellation is immediately visible on another API process');
    assert.equal(await audits('LEAVE_CANCELLED'), 1);
  });

  it('a rejected request tells the requester why', async () => {
    const r = await ok(await api('emp', '/leave/requests', { method: 'POST', body: { type: 'UNPAID', startDate: dayPlus(REJECT_DAY), endDate: dayPlus(REJECT_DAY) } }), 201, LeaveRequestSchema);
    const d = await ok(await api('lead', `/leave/requests/${r.id}/decide`, { method: 'POST', body: { approved: false, note: 'Release week' } }), 200, LeaveRequestSchema);
    assert.equal(d.status, 'REJECTED');
    assert.equal(d.decisionNote, 'Release week');
    assert.match((await notes('emp', 'LEAVE_REJECTED'))[0].title, /rejected|declined/i);
    assert.equal((await attendance.computeDailySummary(ORG, U.emp.id, dayPlus(REJECT_DAY))).dayStatus, 'ABSENT', 'rejected leave changes nothing');
  });

  it('other leave follows manager approval and cancellation restores expected hours', async () => {
    const day = dayPlus(OTHER_DAY);
    const request = await ok(await api('emp', '/leave/requests', { method: 'POST', body: { type: 'OTHER', startDate: day, endDate: day } }), 201, LeaveRequestSchema);
    const decision = await ok(await api('lead', `/leave/requests/${request.id}/decide`, { method: 'POST', body: { approved: true } }), 200, LeaveRequestSchema);
    assert.equal(decision.type, 'OTHER');
    await attendance.recomputeDailySummaryForUser(ORG, U.emp.id, day);
    await ok(await api('emp', `/leave/requests/${request.id}/cancel`, { method: 'POST' }), 200, LeaveRequestSchema);
    const row = (await adminPool.query(`SELECT expected_seconds FROM attendance_daily WHERE org_id = $1 AND user_id = $2 AND work_date = $3`, [ORG, U.emp.id, day])).rows[0];
    assert.equal(row.expected_seconds, 8 * 3600, 'cancellation refreshes persisted expectations');
  });

  it('HR keeps the public holiday calendar; Sri Lanka 2026 defaults load in one step', async () => {
    const empty = await ok(await api('emp', '/holidays?year=2026'), 200, HolidayListSchema);
    assert.equal(empty.items.length, 25, 'new organisations receive Sri Lanka defaults without HR intervention');
    assert.equal(empty.defaultsAvailable, true);
    assert.equal((await api('emp', '/holidays', { method: 'POST', body: { date: '2026-12-31', name: 'Company day' } })).status, 403);
    assert.equal((await api('lead', '/holidays/defaults', { method: 'POST', body: { year: 2026 } })).status, 403);
    const loaded = await ok(await api('hr', '/holidays/defaults', { method: 'POST', body: { year: 2026 } }), 200, HolidayListSchema);
    assert.equal(loaded.items.length, 25, 'the 2026 gazette: 25 dates (May Day and Vesak share 1 May)');
    assert.ok(loaded.items.some((h) => h.date === '2026-02-04' && /Independence/.test(h.name)));
    assert.ok(loaded.items.some((h) => h.date === '2026-05-01' && /Vesak/.test(h.name)));
    assert.equal((await ok(await api('hr', '/holidays/defaults', { method: 'POST', body: { year: 2026 } }), 200, HolidayListSchema)).items.length, 25, 'loading again adds nothing');
    assert.equal((await api('hr', '/holidays/defaults', { method: 'POST', body: { year: 2031 } })).status, 404, 'no built-in calendar for that year');
    const otherProcess = new PgHolidayProvider(app.get(PrismaService));
    assert.equal(await otherProcess.isHoliday(ORG, '2026-12-31'), false);
    await attendance.recomputeDailySummaryForUser(ORG, U.emp.id, '2026-12-31');
    const added = await ok(await api('hr', '/holidays', { method: 'POST', body: { date: '2026-12-31', name: 'Company day' } }), 201, HolidayListSchema);
    assert.equal(added.items.length, 26);
    assert.equal((await adminPool.query(`SELECT expected_seconds FROM attendance_daily WHERE org_id = $1 AND user_id = $2 AND work_date = '2026-12-31'`, [ORG, U.emp.id])).rows[0].expected_seconds, 0, 'HR calendar edits refresh persisted expectations');
    assert.equal(await otherProcess.isHoliday(ORG, '2026-12-31'), true, 'HR changes reach every API process immediately');
    const renamed = await ok(await api('hr', '/holidays', { method: 'POST', body: { date: '2026-12-31', name: 'Company closure' } }), 201, HolidayListSchema);
    assert.equal(renamed.items.length, 26, 'one row per date');
    assert.equal(renamed.items.find((h) => h.date === '2026-12-31')?.name, 'Company closure');
    const id = renamed.items.find((h) => h.date === '2026-12-31')!.id;
    assert.equal((await ok(await api('hr', `/holidays/${id}`, { method: 'DELETE' }), 200, HolidayListSchema)).items.length, 25);
    assert.equal(await audits('HOLIDAY_ADDED'), 2);
    assert.equal(await audits('HOLIDAY_REMOVED'), 1);
    assert.equal(await audits('HOLIDAYS_DEFAULTS_LOADED'), 0, 'already provisioned defaults do not produce a duplicate audit');
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
      assert.equal((await c.query(`SELECT 1 FROM public_holidays WHERE org_id = $1`, [ORG])).rowCount, 0);
      assert.equal((await c.query(`SELECT 1 FROM public_holidays`)).rowCount, 25, 'only this tenant’s default calendar is visible');
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
