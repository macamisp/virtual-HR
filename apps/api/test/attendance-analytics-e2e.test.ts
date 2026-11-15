/**
 * HR attendance analytics end to end (FR-REP-009, ADR 059), real API and Postgres, Asia/Colombo:
 * the three measures for a seeded week (verified work with adjusted sessions left out, office time
 * merged over two tabs and cut at local midnight, meetings merged over a reconnect), grouping,
 * paging, sorting and filters; who sees what (owner, HR, auditor, manager, employee, another
 * organisation) with 404 for anyone out of scope; exports only with attendance.export, audited;
 * range validation; presence retention; the personal data export and the anonymisation preview.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { ScheduledWorkService } from '../src/notifications/scheduled-work.service.ts';
import { AttendanceAnalyticsSchema, PersonAnalyticsSchema } from '../../../packages/shared/src/reports/attendance-analytics.ts';
import type { AttendanceAnalytics, PersonAnalytics } from '../../../packages/shared/src/reports/attendance-analytics.ts';
import { freshCode } from './support/totp.ts';
import { resetOrgs } from './support/reset-orgs.ts';

const ORG = 'f1f60000-0000-4000-8000-000000000001';
const OTHER = 'f1f60000-0000-4000-8000-000000000002';
const T1 = 'f1f60000-0000-4000-8000-0000000000e1';
const T2 = 'f1f60000-0000-4000-8000-0000000000e2';
const M1 = 'f1f60000-0000-4000-8000-0000000000f1';
const M2 = 'f1f60000-0000-4000-8000-0000000000f2';
const PORT = 3118;
const PASSWORD = 'ComplexPassword123!';
const SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSR';
const u = (n: string) => `f1f60000-0000-4000-8000-0000000000${n}`;
const U = {
  owner: { id: u('01'), org: ORG, email: 'owner@analytics.test', role: 'SUPER_ADMIN', secret: `${SECRET}AA` },
  hr: { id: u('02'), org: ORG, email: 'hr@analytics.test', role: 'HR', secret: `${SECRET}AB` },
  auditor: { id: u('03'), org: ORG, email: 'audit@analytics.test', role: 'AUDITOR', secret: null },
  mgr: { id: u('04'), org: ORG, email: 'mgr@analytics.test', role: 'MANAGER', secret: null },
  emp1: { id: u('05'), org: ORG, email: 'emp1@analytics.test', role: 'EMPLOYEE', secret: null },
  emp2: { id: u('06'), org: ORG, email: 'emp2@analytics.test', role: 'EMPLOYEE', secret: null },
  ohr: { id: u('11'), org: OTHER, email: 'hr@analytics-other.test', role: 'HR', secret: `${SECRET}AC` },
  oemp: { id: u('12'), org: OTHER, email: 'emp@analytics-other.test', role: 'EMPLOYEE', secret: null },
} as const;
type Who = keyof typeof U;
const H = 3600;
const RANGE = 'from=2026-10-05&to=2026-10-11';
/** 2026-10-05 is a Monday. Colombo is UTC+05:30: 09:00 local is 03:30Z. */
const z = (s: string) => new Date(s);

describe('HR attendance analytics (ADR 059)', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  const base = `http://localhost:${PORT}`;
  const tokens = {} as Record<Who, string>;
  const get = (who: Who, path: string) => fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${tokens[who]}` } });
  const report = async (who: Who, query: string): Promise<AttendanceAnalytics> => {
    const r = await get(who, `/reports/attendance-analytics?${query}`);
    assert.equal(r.status, 200, `${who}: ${await r.clone().text()}`);
    return AttendanceAnalyticsSchema.parse(await r.json());
  };
  const person = async (who: Who, path: string): Promise<PersonAnalytics> => {
    const r = await get(who, path);
    assert.equal(r.status, 200, `${who}: ${await r.clone().text()}`);
    return PersonAnalyticsSchema.parse(await r.json());
  };

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    const q = (sql: string, params: unknown[] = []) => adminPool.query(sql, params);
    await resetOrgs(adminPool, [ORG, OTHER]);
    await q(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Analytics Ltd', 'analytics-e2e', 'Asia/Colombo'), ($2, 'Analytics Other', 'analytics-other-e2e', 'Asia/Colombo')`, [ORG, OTHER]);
    await q(`INSERT INTO teams (id, org_id, name) VALUES ($1, $3, 'Operations'), ($2, $3, 'Design')`, [T1, T2, ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const [who, x] of Object.entries(U)) {
      await q(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status, mfa_enabled, mfa_secret, is_owner) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8, $9)`,
        [x.id, x.org, x.email, who.toUpperCase(), x.role, hash, x.secret !== null, x.secret, who === 'owner']);
    }
    await q(`UPDATE users SET team_id = $1 WHERE id = ANY($2::uuid[])`, [T1, [U.mgr.id, U.emp1.id]]);
    await q(`UPDATE users SET team_id = $1 WHERE id = $2`, [T2, U.emp2.id]);
    await q(`UPDATE users SET manager_id = $1 WHERE id = $2`, [U.mgr.id, U.emp1.id]);

    const session = (id: string, userId: string, org: string, day: string, inAt: string, outAt: string | null, net: number, active: number, brk: number, meet: number, status = 'CLOSED') => q(
      `INSERT INTO attendance_sessions (id, org_id, user_id, device_id, work_date, clock_in_at, clock_out_at, clock_in_source, clock_out_source,
         active_seconds, idle_seconds, break_seconds, meeting_seconds, net_seconds, last_heartbeat_at, ip_in, status, current_state)
       VALUES ($1, $2, $3, 'web', $4, $5::timestamptz, $6::timestamptz, 'AUTO_HEARTBEAT', $7, $8, 0, $9, $10, $11, COALESCE($6::timestamptz, $5::timestamptz), '10.0.0.1', $12, $13)`,
      [id, org, userId, day, z(inAt), outAt ? z(outAt) : null, outAt ? 'LOGOUT' : null, active, brk, meet, net, status, outAt ? 'OFFLINE' : 'ACTIVE']);
    const S1 = u('a1');
    await session(S1, U.emp1.id, ORG, '2026-10-05', '2026-10-05T03:30:00Z', '2026-10-05T11:30:00Z', 25200, 23000, 1800, 3600);
    await session(u('a2'), U.emp1.id, ORG, '2026-10-05', '2026-10-05T02:00:00Z', '2026-10-05T12:00:00Z', 99999, 99999, 0, 0, 'ADJUSTED'); // replaced by a correction: never counted
    await session(u('a3'), U.emp1.id, ORG, '2026-10-06', '2026-10-06T03:30:00Z', '2026-10-06T07:30:00Z', 14400, 14400, 0, 0);
    await session(u('a4'), U.emp1.id, ORG, '2026-10-07', '2026-10-07T03:30:00Z', null, 3600, 3600, 0, 0, 'OPEN');
    await session(u('a5'), U.emp2.id, ORG, '2026-10-05', '2026-10-05T03:00:00Z', '2026-10-05T11:00:00Z', 28800, 28800, 0, 0);
    await session(u('a6'), U.oemp.id, OTHER, '2026-10-05', '2026-10-05T03:00:00Z', '2026-10-05T11:00:00Z', 30000, 30000, 0, 0);
    await q(`INSERT INTO attendance_segments (org_id, session_id, state, started_at, ended_at, duration_seconds) VALUES
      ($1, $2, 'ACTIVE', '2026-10-05T03:30:00Z', '2026-10-05T05:00:00Z', 5400), ($1, $2, 'IN_MEETING', '2026-10-05T05:00:00Z', '2026-10-05T06:00:00Z', 3600)`, [ORG, S1]);
    await q(`INSERT INTO attendance_daily (org_id, user_id, work_date, first_in, last_out, net_seconds, meeting_seconds, late_minutes, day_status) VALUES
      ($1, $2, '2026-10-05', '2026-10-05T03:30:00Z', '2026-10-05T11:30:00Z', 25200, 3600, 15, 'LATE'),
      ($1, $2, '2026-10-08', NULL, NULL, 0, 0, 0, 'LEAVE'),
      ($1, $3, '2026-10-05', '2026-10-05T03:00:00Z', '2026-10-05T11:00:00Z', 28800, 0, 0, 'PRESENT')`, [ORG, U.emp1.id, U.emp2.id]);
    // Office: two tabs on Monday morning (09:00-12:00 and 11:00-13:00 local: 4 h, not 5), and 23:00
    // Monday to 01:30 Tuesday (1 h Monday, 1.5 h Tuesday); Wednesday left open, last seen after 1 h.
    await q(`INSERT INTO office_presence_intervals (org_id, user_id, started_at, ended_at, last_seen_at, end_reason) VALUES
      ($1, $2, '2026-10-05T03:30:00Z', '2026-10-05T06:30:00Z', '2026-10-05T06:30:00Z', 'LEFT'),
      ($1, $2, '2026-10-05T05:30:00Z', '2026-10-05T07:30:00Z', '2026-10-05T07:30:00Z', 'DROPPED'),
      ($1, $2, '2026-10-05T17:30:00Z', '2026-10-05T20:00:00Z', '2026-10-05T20:00:00Z', 'LEFT')`, [ORG, U.emp1.id]);
    await q(`INSERT INTO office_presence_intervals (org_id, user_id, started_at, last_seen_at) VALUES ($1, $2, '2026-10-07T03:30:00Z', '2026-10-07T04:30:00Z')`, [ORG, U.emp1.id]);
    // Meetings: a reconnect in the review (05:00-05:40 and 05:30-06:00: 1 h); a call whose leave was never seen.
    await q(`INSERT INTO meetings (id, org_id, type, status, title, host_id, livekit_room_name, scheduled_start, scheduled_end, ended_at) VALUES
      ($1, $3, 'SCHEDULED', 'ENDED', 'Quarterly review', $4, 'an-m1', '2026-10-05T05:00:00Z', '2026-10-05T06:00:00Z', '2026-10-05T06:00:00Z'),
      ($2, $3, 'INSTANT', 'ENDED', 'Quick call', $4, 'an-m2', NULL, NULL, '2026-10-06T04:30:00Z')`, [M1, M2, ORG, U.mgr.id]);
    await q(`INSERT INTO meeting_participants (org_id, meeting_id, user_id, livekit_sid, joined_at, left_at) VALUES
      ($1, $2, $4, 'PA_1', '2026-10-05T05:00:00Z', '2026-10-05T05:40:00Z'), ($1, $2, $4, 'PA_2', '2026-10-05T05:30:00Z', '2026-10-05T06:00:00Z'),
      ($1, $3, $4, 'PA_3', '2026-10-06T04:00:00Z', NULL)`, [ORG, M1, M2, U.emp1.id]);
    await q(`INSERT INTO attendance_corrections (org_id, user_id, requested_in, requested_out, reason, status) VALUES ($1, $2, '2026-10-05T02:00:00Z', '2026-10-05T12:00:00Z', 'Forgot to sign in', 'APPROVED')`, [ORG, U.emp1.id]);

    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    for (const [who, x] of Object.entries(U) as Array<[Who, (typeof U)[Who]]>) {
      const body = { email: x.email, password: PASSWORD, ...(x.secret ? { totpCode: await freshCode(x.secret) } : {}) };
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
      assert.ok(tokens[who], `login ${who}`);
    }
  });

  after(async () => {
    await app?.close();
    await resetOrgs(adminPool, [ORG, OTHER]);
    await adminPool.end();
  });

  it('HR: one row per person and day, three measures apart; adjusted sessions, a second tab and midnight handled', async () => {
    const r = await report('hr', `${RANGE}&sort=date&dir=asc&pageSize=50`);
    assert.equal(r.scope, 'all');
    assert.equal(r.timezone, 'Asia/Colombo');
    assert.equal(r.canExport, true);
    assert.equal(r.officeDataFrom, '2026-10-05', 'inside the 90-day presence retention');
    const row = (who: Who, day: string) => r.rows.find((x) => x.user.id === U[who].id && x.period === day);
    assert.deepEqual(
      { ...row('emp1', '2026-10-05'), user: undefined },
      { user: undefined, period: '2026-10-05', daysWorked: 1, firstIn: '2026-10-05T03:30:00.000Z', lastOut: '2026-10-05T11:30:00.000Z', workSeconds: 25200, activeSeconds: 23000,
        breakSeconds: 1800, meetingSeconds: 3600, officeSeconds: 5 * H, lateMinutes: 15, earlyLeaveMinutes: 0, status: 'LATE', statusCounts: { LATE: 1 } },
      'work excludes the adjusted session; office: 4 h over two tabs plus 1 h before midnight');
    assert.equal(row('emp1', '2026-10-05')!.user.teamName, 'Operations');
    assert.deepEqual([row('emp1', '2026-10-06')!.workSeconds, row('emp1', '2026-10-06')!.officeSeconds, row('emp1', '2026-10-06')!.status], [14400, 1.5 * H, 'NOT_SUMMARISED']);
    assert.deepEqual([row('emp1', '2026-10-07')!.status, row('emp1', '2026-10-07')!.lastOut, row('emp1', '2026-10-07')!.officeSeconds], ['IN_PROGRESS', null, H], 'open: ends at the last observation');
    assert.deepEqual([row('emp1', '2026-10-08')!.status, row('emp1', '2026-10-08')!.daysWorked, row('emp1', '2026-10-08')!.workSeconds], ['LEAVE', 0, 0]);
    assert.equal(row('emp2', '2026-10-05')!.status, 'PRESENT');
    assert.equal(r.rows.length, 5);
    assert.ok(!r.rows.some((x) => x.user.id === U.oemp.id), 'never another organisation');
    assert.deepEqual(r.summary, { people: 6, peoplePresent: 2, daysWorked: 4, workSeconds: 72000, averageWorkSeconds: 18000, meetingSeconds: 3600, meetingSharePct: 5, officeSeconds: 7.5 * H,
      statusCounts: { LATE: 1, NOT_SUMMARISED: 1, IN_PROGRESS: 1, LEAVE: 1, PRESENT: 1 } });
    assert.deepEqual(r.teams.map((t) => t.name), ['Design', 'Operations']);
    assert.equal(r.people.length, 6);
  });

  it('weeks and months; paging and sorting; team and person filters', async () => {
    const w = await report('hr', `${RANGE}&groupBy=week&userId=${U.emp1.id}`);
    assert.equal(w.rows.length, 1);
    assert.deepEqual({ p: w.rows[0]!.period, d: w.rows[0]!.daysWorked, work: w.rows[0]!.workSeconds, office: w.rows[0]!.officeSeconds, status: w.rows[0]!.status, counts: w.rows[0]!.statusCounts },
      { p: '2026-10-05', d: 3, work: 43200, office: 7.5 * H, status: null, counts: { LATE: 1, NOT_SUMMARISED: 1, IN_PROGRESS: 1, LEAVE: 1 } });
    const m = await report('hr', `${RANGE}&groupBy=month&sort=name&dir=asc`);
    assert.deepEqual(m.rows.map((x) => [x.user.displayName, x.period, x.workSeconds]), [['EMP1', '2026-10', 43200], ['EMP2', '2026-10', 28800]]);
    const p1 = await report('hr', `${RANGE}&sort=work&dir=desc&pageSize=2&page=1`);
    assert.deepEqual([p1.totalRows, p1.rows.map((x) => x.workSeconds)], [5, [28800, 25200]]);
    const p3 = await report('hr', `${RANGE}&sort=work&dir=desc&pageSize=2&page=3`);
    assert.deepEqual(p3.rows.map((x) => x.workSeconds), [0]);
    assert.ok((await report('hr', `${RANGE}&teamId=${T1}`)).rows.every((x) => x.user.id === U.emp1.id));
    assert.ok((await report('hr', `${RANGE}&userId=${U.emp2.id}`)).rows.every((x) => x.user.id === U.emp2.id));
  });

  it('owner and auditor see the organisation as their permissions allow; the auditor may export', async () => {
    assert.equal((await report('owner', RANGE)).summary.people, 6);
    const a = await report('auditor', RANGE);
    assert.deepEqual([a.scope, a.canExport, a.rows.length], ['all', true, 5]);
  });

  it('manager: their team only, no export; anyone else is "not found", like nobody', async () => {
    const r = await report('mgr', RANGE);
    assert.equal(r.scope, 'team');
    assert.equal(r.canExport, false);
    assert.deepEqual(new Set(r.rows.map((x) => x.user.id)), new Set([U.emp1.id]));
    assert.deepEqual(r.people.map((p) => p.id).sort(), [U.emp1.id, U.mgr.id].sort());
    assert.equal((await report('mgr', `${RANGE}&userId=${U.emp2.id}`)).rows.length, 0, 'a filter never widens the scope');
    assert.equal((await get('mgr', `/reports/attendance-analytics?${RANGE}&format=csv`)).status, 403);
    const out = await get('mgr', `/reports/attendance-analytics/people/${U.emp2.id}?${RANGE}`);
    const none = await get('mgr', `/reports/attendance-analytics/people/f1f60000-0000-4000-8000-0000000000ff?${RANGE}`);
    assert.deepEqual([out.status, none.status], [404, 404]);
    assert.deepEqual(await out.json(), await none.json(), 'the same answer for someone hidden and someone missing');
    const d = await person('mgr', `/reports/attendance-analytics/people/${U.emp1.id}?${RANGE}`);
    assert.equal(d.self, false);
    assert.ok(d.meetings.every((m) => m.title === null), 'meeting titles only to the person');
  });

  it('employee: no reports, own detail only, with meeting titles; meetings merged over a reconnect', async () => {
    assert.equal((await get('emp1', `/reports/attendance-analytics?${RANGE}`)).status, 403);
    const other = await get('emp1', `/reports/attendance-analytics/people/${U.emp2.id}?${RANGE}`);
    const missing = await get('emp1', `/reports/attendance-analytics/people/f1f60000-0000-4000-8000-0000000000ff?${RANGE}`);
    assert.deepEqual([other.status, missing.status], [403, 403], 'refused before any lookup: nothing about anyone is revealed');
    const me = await person('emp1', `/attendance/me/analytics?${RANGE}`);
    assert.equal(me.self, true);
    assert.equal(me.user.id, U.emp1.id);
    assert.deepEqual({ work: me.total.workSeconds, meeting: me.total.meetingSeconds, office: me.total.officeSeconds, days: me.total.daysWorked }, { work: 43200, meeting: 3600, office: 7.5 * H, days: 3 });
    assert.deepEqual(me.meetings.map((m) => [m.title, m.kind, m.seconds, m.open]), [['Quick call', 'INSTANT', 1800, true], ['Quarterly review', 'SCHEDULED', H, false]]);
    assert.deepEqual(me.segments.map((s) => [s.state, s.seconds]), [['IN_MEETING', 3600], ['ACTIVE', 5400]]);
    // Wednesday's interval was seeded open but last seen weeks ago: the API's startup sweep closed it
    // at that last observation (still 1 h), as after a crash.
    assert.deepEqual(me.office.map((o) => [o.seconds, o.open, o.endReason]), [[H, false, 'SERVER_RESTART'], [2.5 * H, false, 'LEFT'], [2 * H, false, 'DROPPED'], [3 * H, false, 'LEFT']]);
    assert.equal(me.corrections.length, 1);
    assert.ok(!JSON.stringify(me).includes('Forgot to sign in'), 'no correction reason text');
    assert.ok(!JSON.stringify(me).includes('10.0.0.1'), 'no IP address');
    assert.deepEqual(me.days.map((d) => d.period), ['2026-10-08', '2026-10-07', '2026-10-06', '2026-10-05']);
    assert.deepEqual(me.weeks.map((d) => d.period), ['2026-10-05']);
    const viaHr = await person('hr', `/reports/attendance-analytics/people/${U.emp1.id}?${RANGE}`);
    assert.deepEqual(viaHr.meetings.map((m) => m.title), [null, null]);
    assert.equal(viaHr.total.workSeconds, me.total.workSeconds, 'the same numbers for HR and the person');
  });

  it('another organisation: none of these people, and their detail is "not found"', async () => {
    const r = await report('ohr', RANGE);
    assert.deepEqual(r.people.map((p) => p.id).sort(), [U.ohr.id, U.oemp.id].sort());
    assert.deepEqual(r.rows.map((x) => x.user.id), [U.oemp.id]);
    assert.equal((await get('ohr', `/reports/attendance-analytics/people/${U.emp1.id}?${RANGE}`)).status, 404);
  });

  it('exports: CSV, XLSX and PDF for HR, audited with filters and row count; the definitions travel with the file', async () => {
    const csv = await get('hr', `/reports/attendance-analytics?${RANGE}&format=csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(csv.headers.get('content-disposition') ?? '', /attendance-analytics-by-day-\d{4}-\d{2}-\d{2}\.csv/);
    const text = await csv.text();
    assert.match(text, /Verified work \(h\).*Confirmed meetings \(h\).*Office connected \(h\)/);
    assert.match(text, /EMP1,Operations,2026-10-05,1,2026-10-05 09:00,2026-10-05 17:00,7,6\.39,0\.5,1,5,15,0,Late/);
    for (const [fmt, type] of [['xlsx', /spreadsheetml/], ['pdf', /application\/pdf/]] as const) {
      const f = await get('hr', `/reports/attendance-analytics?${RANGE}&format=${fmt}`);
      assert.equal(f.status, 200, fmt);
      assert.match(f.headers.get('content-type') ?? '', type);
    }
    const audit = await adminPool.query<{ after: { report: string; rowCount: number; format: string; filters: { from: string } } }>(
      `SELECT after FROM audit_logs WHERE org_id = $1 AND action = 'REPORT_EXPORTED' AND actor_id = $2 ORDER BY created_at`, [ORG, U.hr.id]);
    assert.deepEqual(audit.rows.map((a) => [a.after.report, a.after.format, a.after.rowCount, a.after.filters.from]),
      [['attendance-analytics-by-day', 'csv', 5, '2026-10-05'], ['attendance-analytics-by-day', 'xlsx', 5, '2026-10-05'], ['attendance-analytics-by-day', 'pdf', 5, '2026-10-05']]);
    assert.equal((await get('emp1', `/reports/attendance-analytics?${RANGE}&format=csv`)).status, 403, 'never an employee');
  });

  it('validation: dates in order, at most 366 days, nothing unknown', async () => {
    for (const bad of ['from=2026-10-11&to=2026-10-05', 'from=2026-01-01&to=2027-01-03', `${RANGE}&orgId=${OTHER}`, `${RANGE}&pageSize=500`, `${RANGE}&groupBy=team`, 'from=yesterday&to=2026-10-05']) {
      assert.equal((await get('hr', `/reports/attendance-analytics?${bad}`)).status, 400, bad);
    }
    assert.equal((await get('hr', `/reports/attendance-analytics/people/not-a-uuid?${RANGE}`)).status, 404);
    assert.equal((await get('emp1', `/attendance/me/analytics?from=2026-01-01&to=2027-01-03`)).status, 400);
  });

  it('retention: ended office intervals older than the presence retention go; recent and open ones stay; the app role cannot delete', async () => {
    const now = new Date();
    const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
    await adminPool.query(`INSERT INTO office_presence_intervals (org_id, user_id, started_at, ended_at, last_seen_at, end_reason) VALUES
      ($1, $2, $3, $4, $4, 'LEFT'), ($1, $2, $5, $6, $6, 'LEFT')`, [ORG, U.emp2.id, days(120), days(119), days(10), days(9)]);
    await adminPool.query(`INSERT INTO office_presence_intervals (org_id, user_id, started_at, last_seen_at) VALUES ($1, $2, $3, $3)`, [ORG, U.mgr.id, days(100)]);
    await app.get(ScheduledWorkService).presenceRetention(now);
    const left = await adminPool.query<{ user_id: string; ended: boolean }>(`SELECT user_id, ended_at IS NOT NULL AS ended FROM office_presence_intervals WHERE user_id = ANY($1::uuid[]) ORDER BY started_at`, [[U.emp2.id, U.mgr.id]]);
    assert.deepEqual(left.rows.map((r) => [r.user_id, r.ended]), [[U.mgr.id, false], [U.emp2.id, true]], 'the 119-day-old one is gone; an open one is never deleted');
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE hrvo_app');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
      await assert.rejects(c.query(`DELETE FROM office_presence_intervals`), /permission denied/);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('privacy: the person\'s data export lists their office connection times; anonymisation will delete them', async () => {
    const r = await get('emp1', '/me/export?format=json');
    assert.equal(r.status, 200);
    const data = JSON.parse(await r.text()) as { attendance: { officeConnections: Array<{ started_at: string; end_reason: string | null }> } };
    assert.equal(data.attendance.officeConnections.length, 4);
    assert.deepEqual(Object.keys(data.attendance.officeConnections[0]!).sort(), ['end_reason', 'ended_at', 'last_seen_at', 'started_at']);
    const check = await get('owner', `/privacy/subjects/${U.emp1.id}/anonymisation-check`);
    assert.equal(check.status, 200, await check.clone().text());
    const c = (await check.json()) as { willRemove: Array<{ dataset: string; count: number; action: string }> };
    assert.deepEqual(c.willRemove.find((w) => w.dataset === 'Office connection times'), { dataset: 'Office connection times', count: 4, action: 'DELETE' });
  });
});
