/**
 * ADR 049 §1 (FR-WT-001, FR-WT-002, FR-WT-005, FR-WT-006): verified calls, meeting intervals for
 * the person and their manager in scope, and meeting time in timesheets, reports, exports and the
 * live board. Sessions and segments are written directly (the state machine has its own tests).
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
import { AttendanceService } from '../src/attendance/attendance.service.ts';
import { HeartbeatValidator } from '../src/attendance/heartbeat-validator.ts';
import { LiveBoardSchema, MeetingIntervalListSchema } from '../../../packages/shared/src/attendance/api.ts';
import { TimesheetDetailSchema } from '../../../packages/shared/src/timesheets/types.ts';
import { AttendanceReportSchema } from '../../../packages/shared/src/reports/types.ts';
import { AttendanceState, type HeartbeatPayload } from '../../../packages/shared/src/attendance/types.ts';
import { freshCode } from './support/totp.ts';
import { PrismaService } from '../src/common/prisma.service.ts';
import { refreshDay } from '../src/timesheets/timesheet-store.ts';

const ORG = '3e070000-0000-4000-8000-000000000001';
const OTHER = '3e070000-0000-4000-8000-000000000002';
const TEAM = '3e070000-0000-4000-8000-000000000101';
const TEAM2 = '3e070000-0000-4000-8000-000000000102';
const MEETING = '3e070000-0000-4000-8000-000000000501';
const PORT = 3062;
const PASSWORD = 'ComplexPassword123!';
const MFA_SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const U = {
  hr: { id: '3e070000-0000-4000-8000-000000000011', email: 'hr@mt.test', role: 'HR', team: null as string | null },
  lead: { id: '3e070000-0000-4000-8000-000000000012', email: 'lead@mt.test', role: 'TEAM_LEAD', team: TEAM as string | null },
  emp: { id: '3e070000-0000-4000-8000-000000000013', email: 'emp@mt.test', role: 'EMPLOYEE', team: TEAM as string | null },
  lead2: { id: '3e070000-0000-4000-8000-000000000014', email: 'lead2@mt.test', role: 'TEAM_LEAD', team: TEAM2 as string | null },
  peer: { id: '3e070000-0000-4000-8000-000000000015', email: 'peer@mt.test', role: 'EMPLOYEE', team: TEAM as string | null },
} as const;
type Who = keyof typeof U;
const TZ = 'Asia/Colombo';
const YESTERDAY = formatInTimeZone(new Date(Date.now() - 86_400_000), TZ, 'yyyy-MM-dd');
const at = (hhmm: string) => new Date(`${YESTERDAY}T${hhmm}:00+05:30`);

describe('ADR 049: meeting time is verified, listed and shown everywhere', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
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

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    const pgBase = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev' };
    adminPool = new pg.Pool({ ...pgBase, user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Meeting Time Ltd', 'mt-e2e', $3), ($2, 'Other', 'mt-e2e-other', $3)`, [ORG, OTHER, TZ]);
    await adminPool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $3, 'Alpha'), ($2, $3, 'Beta')`, [TEAM, TEAM2, ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const [k, u] of Object.entries(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, team_id, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`, [u.id, ORG, u.email, k, u.role, u.team, hash]);
    }
    await adminPool.query(`UPDATE users SET manager_id = $1 WHERE id = $2`, [U.lead.id, U.emp.id]);
    await adminPool.query(`UPDATE users SET mfa_enabled = true, mfa_secret = $1 WHERE id = $2`, [MFA_SECRET, U.hr.id]);
    await adminPool.query(`UPDATE teams SET lead_id = $1 WHERE id = $2`, [U.lead.id, TEAM]);
    await adminPool.query(
      `INSERT INTO meetings (id, org_id, type, status, title, host_id, livekit_room_name, scheduled_start, scheduled_end)
       VALUES ($1, $2, 'SCHEDULED', 'ENDED', 'Sprint planning', $3, 'mt-room', $4, $5)`,
      [MEETING, ORG, U.lead.id, at('10:00'), at('11:00')]);
    // Yesterday: 09:00-12:00 session, 30 min room call and 45 min meeting (all in net).
    const S = '3e070000-0000-4000-8000-000000000901';
    await adminPool.query(
      `INSERT INTO attendance_sessions (id, org_id, user_id, device_id, work_date, clock_in_at, clock_out_at, clock_in_source, clock_out_source,
         active_seconds, idle_seconds, break_seconds, meeting_seconds, net_seconds, last_heartbeat_at, ip_in, flags, status, current_state, consecutive_idle_seconds)
       VALUES ($1, $2, $3, 'd1', $4, $5, $6, 'AUTO_HEARTBEAT', 'LOGOUT', 6300, 0, 0, 4500, 10800, $6, '127.0.0.1', '{}', 'CLOSED', 'OFFLINE', 0)`,
      [S, ORG, U.emp.id, YESTERDAY, at('09:00'), at('12:00')]);
    await adminPool.query(
      `INSERT INTO attendance_segments (org_id, session_id, state, started_at, ended_at, duration_seconds, call_kind, call_meeting_id, flags) VALUES
         ($1, $2, 'IN_MEETING', $3, $4, 1800, 'ROOM', NULL, '{}'),
         ($1, $2, 'IN_MEETING', $5, $6, 2700, 'MEETING', $7, '{}')`,
      [ORG, S, at('09:15'), at('09:45'), at('10:00'), at('10:45'), MEETING]);
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    attendance = app.get(AttendanceService);
    await attendance.recomputeDailySummaryForUser(ORG, U.emp.id, YESTERDAY);
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
  });

  it('FR-WT-002: the real server check refuses a call nobody else is in (not in the office)', async () => {
    const secret = attendance.generateSessionSecret();
    const sid = '3e070000-0000-4000-8000-0000000009aa';
    await attendance.registerSessionSecret(sid, secret, ORG);
    await attendance.recordMonitoringConsent({ orgId: ORG, userId: U.peer.id, noticeVersion: 'v1.0.0' });
    const v = new HeartbeatValidator();
    let seq = 0;
    const send = (over: Partial<HeartbeatPayload>) => {
      seq += 1;
      const hb: Omit<HeartbeatPayload, 'signature'> = { orgId: ORG, userId: U.peer.id, deviceId: 'peer-d', sessionId: sid, sequenceNumber: seq, nonce: `mt-${seq}-${Date.now()}`,
        activeSeconds: 30, idleSeconds: 0, tabVisible: true, windowFocused: true, inCall: false, ...over };
      return attendance.ingestHeartbeat({ ...hb, signature: v.signHeartbeat(hb, secret) });
    };
    await send({});
    const solo = await send({ inCall: true, activeSeconds: 0, idleSeconds: 30 });
    assert.equal(solo.currentState, AttendanceState.ACTIVE, 'not in the office, so not in a call');
    const fake = await send({ inCall: true, activeSeconds: 0, idleSeconds: 30, meetingId: MEETING });
    assert.equal(fake.currentState, AttendanceState.ACTIVE, 'an ended meeting nobody is connected to');
    await attendance.onExplicitLogout(U.peer.id, undefined, ORG);
  });

  it('FR-WT-005: the person lists their meeting intervals with titles', async () => {
    const r = await ok(await api('emp', `/attendance/me/meetings?from=${YESTERDAY}&to=${YESTERDAY}`), 200, MeetingIntervalListSchema);
    assert.equal(r.totalSeconds, 4500);
    assert.deepEqual(r.intervals.map((i) => [i.kind, i.durationSeconds, i.title]), [['ROOM', 1800, null], ['MEETING', 2700, 'Sprint planning']]);
    assert.equal(r.intervals[1]!.meetingId, MEETING);
    assert.equal((await api('emp', `/attendance/me/meetings?from=${YESTERDAY}&to=2099-01-01`)).status, 400, 'range limit');
  });

  it('FR-WT-005: the manager sees a report\'s intervals without titles; other teams and peers cannot', async () => {
    const r = await ok(await api('lead', `/attendance/users/${U.emp.id}/meetings?from=${YESTERDAY}&to=${YESTERDAY}`), 200, MeetingIntervalListSchema);
    assert.equal(r.totalSeconds, 4500);
    assert.ok(r.intervals.every((i) => i.title === null), 'meeting titles stay with the person');
    assert.equal((await ok(await api('hr', `/attendance/users/${U.emp.id}/meetings?from=${YESTERDAY}&to=${YESTERDAY}`), 200, MeetingIntervalListSchema)).intervals.length, 2);
    assert.equal((await api('lead2', `/attendance/users/${U.emp.id}/meetings?from=${YESTERDAY}&to=${YESTERDAY}`)).status, 404, 'another team');
    assert.equal((await api('peer', `/attendance/users/${U.emp.id}/meetings?from=${YESTERDAY}&to=${YESTERDAY}`)).status, 403, 'no team permission');
    assert.equal((await api('hr', `/attendance/users/not-a-uuid/meetings?from=${YESTERDAY}&to=${YESTERDAY}`)).status, 400);
  });

  it('FR-WT-006: meeting minutes on the timesheet day and period, as part of attendance', async () => {
    await app.get(PrismaService).runWithTenantContext(ORG, (db) => refreshDay(db, ORG, U.emp.id, YESTERDAY));
    const id = (await adminPool.query(`SELECT timesheet_id FROM timesheet_days WHERE user_id = $1 AND work_date = $2`, [U.emp.id, YESTERDAY])).rows[0].timesheet_id as string;
    const sheet = await ok(await api('emp', `/timesheets/${id}`), 200, TimesheetDetailSchema);
    const day = sheet.days.find((d) => d.date === YESTERDAY)!;
    assert.equal(day.attendanceMinutes, 180);
    assert.equal(day.meetingMinutes, 75);
    assert.equal(sheet.meetingMinutes, 75);
  });

  it('FR-WT-006: the attendance report and the CSV export carry meeting hours', async () => {
    const rep = await ok(await api('hr', `/reports/attendance?from=${YESTERDAY}&to=${YESTERDAY}&groupBy=user&userId=${U.emp.id}`), 200, AttendanceReportSchema);
    assert.equal(rep.totals.meetingMinutes, 75);
    const csv = await (await api('hr', `/attendance/export?startDate=${YESTERDAY}&endDate=${YESTERDAY}&userId=${U.emp.id}&format=csv`)).text();
    const [head, row] = csv.trim().split('\n');
    assert.ok(head!.endsWith(',status,meeting_hours'), 'appended last');
    assert.ok(row!.endsWith(',1.25'), row);
  });

  it('FR-WT-006: the live board reports today\'s meeting seconds', async () => {
    const board = await ok(await api('lead', '/attendance/live'), 200, LiveBoardSchema);
    assert.ok(board.every((e) => typeof e.todayMeetingSeconds === 'number'));
  });

  it('RLS: another organisation never sees the segments', async () => {
    const appPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGUSER || 'hrvo_app', password: process.env.PGPASSWORD || 'hrvo_app_pass' });
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [OTHER]);
      const n = (await c.query(`SELECT count(*)::int AS n FROM attendance_segments WHERE call_kind IS NOT NULL`)).rows[0].n as number;
      assert.equal(n, 0);
    } finally {
      await c.query('ROLLBACK');
      c.release();
      await appPool.end();
    }
  });
});
