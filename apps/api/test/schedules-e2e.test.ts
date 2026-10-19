/**
 * Work schedule editor (FR-ORG-005; ADR 032), against the real API and Postgres: only
 * schedules.manage edits; input is validated; versions of one scope never overlap and past days
 * keep theirs; another tenant's schedules are invisible; every change is audited; and a change
 * from today reaches today's stored expected hours at once (the compliance engine reads it).
 */
import 'reflect-metadata';
import { freshCode } from './support/totp.ts';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { formatInTimeZone } from 'date-fns-tz';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { AttendanceService } from '../src/attendance/attendance.service.ts';
import { PostgresAttendanceRepository } from '../src/attendance/attendance-repository.ts';
import { ScheduleOverviewSchema, ScheduleSchema } from '../../../packages/shared/src/org/schedules.ts';
import type { AttendanceSession } from '../../../packages/shared/src/attendance/types.ts';
import { LiveBoardSchema } from '../../../packages/shared/src/attendance/api.ts';

const ORG = '5d5d0000-0000-4000-8000-000000000001';
const OTHER = '5d5d0000-0000-4000-8000-000000000002';
const TEAM = '5d5d0000-0000-4000-8000-000000000101';
const PORT = 3112;
const TZ = 'Asia/Colombo';
const PASSWORD = 'ComplexPassword123!';
const MFA_SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD'; // test-only; HR must have 2FA enrolled (FR-AUTH-004)
const U = {
  hr: { id: '5d5d0000-0000-4000-8000-000000000011', email: 'hr@sched-api.test', role: 'HR', org: ORG },
  lead: { id: '5d5d0000-0000-4000-8000-000000000012', email: 'lead@sched-api.test', role: 'TEAM_LEAD', org: ORG },
  emp: { id: '5d5d0000-0000-4000-8000-000000000013', email: 'emp@sched-api.test', role: 'EMPLOYEE', org: ORG },
  sub: { id: '5d5d0000-0000-4000-8000-000000000014', email: 'sub@sched-api.test', role: 'SUBCONTRACTOR', org: ORG },
  stranger: { id: '5d5d0000-0000-4000-8000-000000000021', email: 'stranger@sched-api.test', role: 'EMPLOYEE', org: OTHER },
} as const;
type Who = 'hr' | 'lead' | 'emp' | 'sub';
const today = () => formatInTimeZone(new Date(), TZ, 'yyyy-MM-dd');
const plus = (n: number) => formatInTimeZone(new Date(Date.now() + n * 86_400_000), TZ, 'yyyy-MM-dd');
const day = (start: string, end: string, expectedHours: number) => ({ start, end, expectedHours });
const everyDay = (d: ReturnType<typeof day>) => Object.fromEntries(['1', '2', '3', '4', '5', '6', '7'].map((k) => [k, d]));
const body = (scope: unknown, effectiveFrom: string, extra: Record<string, unknown> = {}) =>
  ({ scope, effectiveFrom, days: everyDay(day('09:00', '17:00', 8)), flexible: false, lateGraceMinutes: 10, ...extra });

describe('Work schedule editor (FR-ORG-005)', { concurrency: false }, () => {
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
  const versionsOf = async (userId: string) =>
    (await adminPool.query<{ effective_from: string; effective_to: string | null }>(
      `SELECT to_char(effective_from, 'YYYY-MM-DD') AS effective_from, to_char(effective_to, 'YYYY-MM-DD') AS effective_to FROM work_schedules WHERE user_id = $1 ORDER BY effective_from`, [userId])).rows;

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    const pgBase = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev' };
    adminPool = new pg.Pool({ ...pgBase, user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Sched Ltd', 'sched-api', $3), ($2, 'Other', 'sched-api-other', $3)`, [ORG, OTHER, TZ]);
    await adminPool.query(`DELETE FROM public_holidays WHERE org_id = $1`, [ORG]); // expected hours must not depend on today's calendar
    await adminPool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Ops')`, [TEAM, ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const [k, u] of Object.entries(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status, team_id) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7)`,
        [u.id, u.org, u.email, k, u.role, hash, u.org === ORG ? TEAM : null]);
    }
    await adminPool.query(`UPDATE users SET mfa_enabled = true, mfa_secret = $1 WHERE id = $2`, [MFA_SECRET, U.hr.id]);
    await adminPool.query(`INSERT INTO work_schedules (org_id, user_id, days, flexible, grace_minutes, effective_from) VALUES ($1, $2, $3, false, 10, '2026-01-01')`,
      [OTHER, U.stranger.id, JSON.stringify(everyDay(day('07:00', '15:00', 8)))]);
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    for (const who of ['hr', 'lead', 'emp', 'sub'] as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD, ...(who === 'hr' ? { totpCode: await freshCode(MFA_SECRET) } : {}) }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
      assert.ok(tokens[who], `login ${who}`);
    }
  });

  after(async () => {
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.end();
  });

  it('only schedules.manage reads or edits schedules', async () => {
    for (const who of ['lead', 'emp', 'sub'] as Who[]) {
      assert.equal((await api(who, '/schedules')).status, 403, `${who} reads`);
      assert.equal((await api(who, '/schedules', { method: 'PUT', body: body({ kind: 'USER', userId: U[who].id }, today()) })).status, 403, `${who} edits their own`);
      assert.equal((await api(who, '/schedules/end', { method: 'POST', body: { scope: { kind: 'ORG' }, effectiveFrom: today() } })).status, 403, `${who} ends`);
    }
    const o = await ok(await api('hr', '/schedules'), 200, ScheduleOverviewSchema);
    assert.equal(o.today, today());
    assert.deepEqual(o.schedules, [], 'another tenant\'s schedule is invisible (RLS)');
    assert.ok(!o.people.some((p) => p.id === U.stranger.id));
  });

  it('validates days, grace, allowance, dates and the scope', async () => {
    const bad = async (b: unknown, status = 400) => assert.equal((await api('hr', '/schedules', { method: 'PUT', body: b })).status, status, JSON.stringify(b).slice(0, 120));
    await bad(body({ kind: 'ORG' }, today(), { days: { '1': day('17:00', '09:00', 8) } }));
    await bad(body({ kind: 'ORG' }, today(), { days: { '1': day('09:00', '13:00', 8) } }), 400);
    await bad(body({ kind: 'ORG' }, today(), { days: { '8': day('09:00', '17:00', 8) } }));
    await bad(body({ kind: 'ORG' }, today(), { days: {} }));
    await bad(body({ kind: 'ORG' }, today(), { lateGraceMinutes: 241 }));
    await bad(body({ kind: 'ORG' }, today(), { breakAllowanceMinutes: -1 }));
    await bad(body({ kind: 'ORG' }, today(), { days: { '1': day('9:00', '17:00', 8) } }));
    await bad(body({ kind: 'ORG' }, plus(-1)), 400);
    await bad(body({ kind: 'TEAM', teamId: '5d5d0000-0000-4000-8000-000000000999' }, today()), 404);
    await bad(body({ kind: 'USER', userId: U.stranger.id }, today()), 404);
    await bad({ ...body({ kind: 'ORG' }, today()), extra: 1 });
  });

  it('versions of one scope never overlap; a later change replaces future versions and ends the running one', async () => {
    const v1 = await ok(await api('hr', '/schedules', { method: 'PUT', body: body({ kind: 'USER', userId: U.lead.id }, plus(7), { breakAllowanceMinutes: 45 }) }), 200, ScheduleSchema);
    assert.deepEqual([v1.effectiveFrom, v1.effectiveTo, v1.breakAllowanceMinutes, v1.earlyLeaveGraceMinutes], [plus(7), null, 45, null]);
    await ok(await api('hr', '/schedules', { method: 'PUT', body: body({ kind: 'USER', userId: U.lead.id }, plus(3), { earlyLeaveGraceMinutes: 20 }) }), 200, ScheduleSchema);
    assert.deepEqual(await versionsOf(U.lead.id), [{ effective_from: plus(3), effective_to: null }], 'the +7 version would have started after +3, so it is replaced');
    await ok(await api('hr', '/schedules', { method: 'PUT', body: body({ kind: 'USER', userId: U.lead.id }, plus(10)) }), 200, ScheduleSchema);
    assert.deepEqual(await versionsOf(U.lead.id), [{ effective_from: plus(3), effective_to: plus(9) }, { effective_from: plus(10), effective_to: null }]);
    const audit = (await adminPool.query<{ before: { schedule: { effectiveFrom: string; earlyLeaveGraceMinutes: number } }; after: { scope: string; schedule: { effectiveFrom: string } } }>(
      `SELECT before, after FROM audit_logs WHERE org_id = $1 AND action = 'SCHEDULE_SET' ORDER BY created_at DESC LIMIT 1`, [ORG])).rows[0]!;
    assert.equal(audit.after.scope, `USER:${U.lead.id}`);
    assert.deepEqual([audit.before.schedule.effectiveFrom, audit.before.schedule.earlyLeaveGraceMinutes, audit.after.schedule.effectiveFrom], [plus(3), 20, plus(10)]);
    const o = await ok(await api('hr', '/schedules'), 200, ScheduleOverviewSchema);
    assert.equal(o.schedules.filter((s) => s.scope.kind === 'USER').length, 2, 'current and upcoming');
  });

  it('stopping a schedule from a date lets the next level apply; stopping nothing is 404', async () => {
    await ok(await api('hr', '/schedules/end', { method: 'POST', body: { scope: { kind: 'USER', userId: U.lead.id }, effectiveFrom: plus(5) } }), 200);
    assert.deepEqual(await versionsOf(U.lead.id), [{ effective_from: plus(3), effective_to: plus(4) }]);
    assert.equal((await adminPool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = 'SCHEDULE_ENDED'`, [ORG])).rows[0].n, 1);
    assert.equal((await api('hr', '/schedules/end', { method: 'POST', body: { scope: { kind: 'USER', userId: U.lead.id }, effectiveFrom: plus(5) } })).status, 404);
    assert.equal((await api('hr', '/schedules/end', { method: 'POST', body: { scope: { kind: 'TEAM', teamId: TEAM }, effectiveFrom: today() } })).status, 404);
  });

  it('a change from today reaches the compliance engine and today\'s stored day at once', async () => {
    const attendance = app.get(AttendanceService);
    const repo = app.get(PostgresAttendanceRepository);
    await ok(await api('hr', '/schedules', { method: 'PUT', body: body({ kind: 'ORG' }, today()) }), 200, ScheduleSchema);
    const d = today();
    const clockInAt = new Date(`${d}T00:30:00+05:30`);
    const clockOutAt = new Date(`${d}T01:30:00+05:30`);
    await repo.saveSession({
      id: crypto.randomUUID(), orgId: ORG, userId: U.emp.id, deviceId: 'web', workDate: d, clockInAt, clockOutAt, clockInSource: 'AUTO_HEARTBEAT', clockOutSource: 'LOGOUT',
      activeSeconds: 2400, idleSeconds: 0, breakSeconds: 1200, meetingSeconds: 0, netSeconds: 2400, lastHeartbeatAt: clockOutAt, ipIn: '127.0.0.1', ipOut: '127.0.0.1',
      flags: [], status: 'CLOSED', currentState: 'OFFLINE', segments: [], consecutiveIdleSeconds: 0,
    } as AttendanceSession);
    await attendance.recomputeDailySummaryForUser(ORG, U.emp.id, d);
    const stored = async () => (await adminPool.query<{ expected_seconds: number; excess_break_minutes: number }>(
      `SELECT expected_seconds, excess_break_minutes FROM attendance_daily WHERE org_id = $1 AND user_id = $2 AND work_date = $3`, [ORG, U.emp.id, d])).rows[0]!;
    assert.deepEqual(await stored(), { expected_seconds: 8 * 3600, excess_break_minutes: 0 }, 'organisation default');
    await ok(await api('hr', '/schedules', { method: 'PUT', body: body({ kind: 'TEAM', teamId: TEAM }, today(), { days: everyDay(day('08:00', '14:00', 6)), breakAllowanceMinutes: 5 }) }), 200, ScheduleSchema);
    assert.deepEqual(await stored(), { expected_seconds: 6 * 3600, excess_break_minutes: 15 }, 'the team schedule applies at once: 6 h expected, 20 min break against 5 allowed');
    const compliance = await attendance.computeScheduleCompliance({ orgId: ORG, userId: U.emp.id, workDate: d, sessions: [] });
    assert.equal(compliance.expectedSeconds, 6 * 3600);
    // The live board shows today's break against the allowance in force today.
    const board = await ok(await api('lead', '/attendance/live'), 200, LiveBoardSchema);
    const row = board.find((r) => r.userId === U.emp.id);
    assert.deepEqual([row?.todayBreakSeconds, row?.breakAllowanceSeconds], [1200, 300]);
    assert.equal(board.find((r) => r.userId === U.sub.id)?.breakAllowanceSeconds, null, 'no break today: no lookup, no badge');
  });
});
