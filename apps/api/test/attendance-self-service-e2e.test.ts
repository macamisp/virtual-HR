/**
 * Self-service attendance endpoints used by apps/web (SRS 8.3):
 * consent status, today, days, break start/end, my corrections, review queue, live board scoping.
 * FR-ATT-007, 013, 015, 016, 020; FR-AUD-004.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { formatInTimeZone } from 'date-fns-tz';
import { io, Socket } from 'socket.io-client';
import argon2 from 'argon2';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { signHeartbeatPayload } from '../../../packages/shared/src/attendance/heartbeat-signer.ts';
import {
  BreakResultSchema,
  ConsentStatusSchema,
  CorrectionQueueSchema,
  CorrectionListSchema,
  CorrectionSchema,
  LiveBoardSchema,
  MyDaysSchema,
  MyTodaySchema,
  TransparencySchema,
} from '../../../packages/shared/src/attendance/api.ts';

const ORG = '55550000-0000-4000-8000-000000000001';
const SLUG = 'self-service-e2e';
const TEAM = '55550000-0000-4000-8000-000000000101';
const PASSWORD = 'ComplexPassword123!';
const U = {
  emp: { id: '55550000-0000-4000-8000-000000000011', email: 'emp@self.test', role: 'EMPLOYEE' },
  other: { id: '55550000-0000-4000-8000-000000000012', email: 'other@self.test', role: 'EMPLOYEE' },
  lead: { id: '55550000-0000-4000-8000-000000000013', email: 'lead@self.test', role: 'TEAM_LEAD' },
  lead2: { id: '55550000-0000-4000-8000-000000000014', email: 'lead2@self.test', role: 'TEAM_LEAD' },
  hrm: { id: '55550000-0000-4000-8000-000000000015', email: 'hrm@self.test', role: 'HR_MANAGER' },
} as const;

interface Login { accessToken: string; sessionId: string; sessionSecret: string }

describe('Attendance self-service API (apps/web contract)', { concurrency: false }, () => {
  let app: INestApplication;
  let base: string;
  let port: number;
  let adminPool: pg.Pool;
  const sockets: Socket[] = [];

  async function login(email: string): Promise<Login> {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    assert.equal(res.status, 200);
    return (await res.json()) as Login;
  }

  function api(token: string, path: string, init: RequestInit = {}) {
    return fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
  }

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
    await adminPool.query(`DELETE FROM organizations WHERE id = $1 OR slug = $2`, [ORG, SLUG]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Self Service Ltd', $2)`, [ORG, SLUG]);
    await adminPool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Ops')`, [TEAM, ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(U)) {
      await adminPool.query(
        `INSERT INTO users (id, org_id, email, display_name, role, team_id, password_hash, status, mfa_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', false)`,
        [u.id, ORG, u.email, u.email.split('@')[0], u.role, u.role === 'HR_MANAGER' || u.id === U.lead2.id ? null : TEAM, hash],
      );
    }
    await adminPool.query(`UPDATE users SET manager_id = $1 WHERE id IN ($2, $3)`, [U.lead.id, U.emp.id, U.other.id]);
    // HR_MANAGER requires 2FA (FR-AUTH-004); enrollment is covered elsewhere, so pre-enable it here.
    await adminPool.query(`UPDATE users SET mfa_enabled = true, mfa_secret = $1 WHERE id = $2`, ['KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD', U.hrm.id]);

    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    port = 3051;
    await app.listen(port);
    base = `http://localhost:${port}`;
  });

  after(async () => {
    for (const s of sockets) s.disconnect();
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.end();
  });

  let emp: Login;

  it('GET /attendance/consent reports false, then true after POST (FR-AUD-004)', async () => {
    emp = await login(U.emp.email);
    const before = ConsentStatusSchema.parse(await (await api(emp.accessToken, '/attendance/consent')).json());
    assert.equal(before.accepted, false);
    assert.equal(before.noticeVersion, 'v1.0.0');
    const post = await api(emp.accessToken, '/attendance/consent', { method: 'POST', body: JSON.stringify({ noticeVersion: before.noticeVersion }) });
    assert.equal(post.status, 201);
    const after = ConsentStatusSchema.parse(await (await api(emp.accessToken, '/attendance/consent')).json());
    assert.equal(after.accepted, true);
    assert.ok(after.acceptedAt);
  });

  it('GET /attendance/me/today is OFFLINE before the first heartbeat', async () => {
    const today = MyTodaySchema.parse(await (await api(emp.accessToken, '/attendance/me/today')).json());
    assert.equal(today.state, 'OFFLINE');
    assert.equal(today.trackingSince, null);
    assert.equal(today.sessionCount, 0);
  });

  it('a WebCrypto-signed heartbeat clocks in; today shows ACTIVE with server-side trackingSince', async () => {
    const socket = io(`http://localhost:${port}`, { transports: ['websocket'], reconnection: false, auth: { token: emp.accessToken } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    const hb = await signHeartbeatPayload({
      orgId: ORG,
      userId: U.emp.id,
      deviceId: 'web-e2e',
      sessionId: emp.sessionId,
      sequenceNumber: 1,
      nonce: randomBytes(16).toString('hex'),
      activeSeconds: 30,
      idleSeconds: 0,
      tabVisible: true,
      windowFocused: true,
      inCall: false,
    }, emp.sessionSecret);
    const ack = (await socket.emitWithAck('presence:heartbeat', hb)) as { success: boolean; currentState: string };
    assert.equal(ack.success, true);
    const today = MyTodaySchema.parse(await (await api(emp.accessToken, '/attendance/me/today')).json());
    assert.equal(today.state, 'ACTIVE');
    assert.ok(today.trackingSince);
    assert.ok(Date.now() - Date.parse(today.trackingSince) < 10_000);
    assert.equal(today.totals.activeSeconds, 30);
  });

  it('accepted heartbeats are recorded as raw presence events the user can see (FR-ATT-020)', async () => {
    const info = TransparencySchema.parse(await (await api(emp.accessToken, '/attendance/me/events')).json());
    assert.ok(info.events.length >= 1);
    assert.equal(info.events[0].eventType, 'HEARTBEAT');
    assert.equal(info.events[0].state, 'ACTIVE');
  });

  it('closing one of two sockets (e.g. a second tab) does not mark the user DISCONNECTED', async () => {
    const second = io(`http://localhost:${port}`, { transports: ['websocket'], reconnection: false, auth: { token: emp.accessToken } });
    await new Promise<void>((resolve, reject) => {
      second.once('connect', () => resolve());
      second.once('connect_error', reject);
    });
    second.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    const today = MyTodaySchema.parse(await (await api(emp.accessToken, '/attendance/me/today')).json());
    assert.equal(today.state, 'ACTIVE');
  });

  it('break start/end works, broadcasts presence and rejects invalid transitions with 409 (FR-ATT-007)', async () => {
    const socket = sockets[0];
    const update = new Promise<{ userId: string; state: string }>((resolve) => socket.once('presence:update', resolve));
    const start = await api(emp.accessToken, '/attendance/break/start', { method: 'POST' });
    assert.equal(start.status, 200);
    assert.equal(BreakResultSchema.parse(await start.json()).state, 'ON_BREAK');
    assert.deepEqual(await update, { userId: U.emp.id, state: 'ON_BREAK', actionTaken: 'Open break segment' });

    const today = MyTodaySchema.parse(await (await api(emp.accessToken, '/attendance/me/today')).json());
    assert.equal(today.state, 'ON_BREAK');
    assert.ok(today.onBreakSince);

    assert.equal((await api(emp.accessToken, '/attendance/break/start', { method: 'POST' })).status, 409);
    await new Promise((r) => setTimeout(r, 1100));
    const end = await api(emp.accessToken, '/attendance/break/end', { method: 'POST' });
    assert.equal(end.status, 200);
    const ended = BreakResultSchema.parse(await end.json());
    assert.equal(ended.state, 'ACTIVE');
    assert.ok(ended.totals.breakSeconds >= 1);
    assert.equal((await api(emp.accessToken, '/attendance/break/end', { method: 'POST' })).status, 409);
  });

  it('break with no open session is 409, not 500', async () => {
    const other = await login(U.other.email);
    assert.equal((await api(other.accessToken, '/attendance/break/start', { method: 'POST' })).status, 409);
  });

  it('GET /attendance/me/days returns today with totals and validates the range', async () => {
    const today = MyTodaySchema.parse(await (await api(emp.accessToken, '/attendance/me/today')).json());
    const days = MyDaysSchema.parse(
      await (await api(emp.accessToken, `/attendance/me/days?from=${today.workDate}&to=${today.workDate}`)).json(),
    );
    assert.equal(days.length, 1);
    assert.equal(days[0].workDate, today.workDate);
    assert.equal(days[0].open, true);
    assert.ok(days[0].breakSeconds >= 1);
    assert.equal((await api(emp.accessToken, '/attendance/me/days?from=2026-01-01&to=2026-12-31')).status, 400);
    assert.equal((await api(emp.accessToken, '/attendance/me/days?from=2026-10-10&to=2026-10-01')).status, 400);
  });

  it('corrections: requester sees own list; queue is scoped to the requester\'s manager (FR-ATT-013)', async () => {
    const create = await api(emp.accessToken, '/attendance/corrections', {
      method: 'POST',
      body: JSON.stringify({ requestedIn: '2026-10-12T03:30:00.000Z', requestedOut: '2026-10-12T11:30:00.000Z', reason: 'Forgot laptop at home' }),
    });
    assert.equal(create.status, 201);
    // The web client validates this body; every contract field must be present (nulls included).
    const created = CorrectionSchema.parse(await create.json());
    assert.equal(created.reviewerId, null);
    const mine = CorrectionListSchema.parse(await (await api(emp.accessToken, '/attendance/me/corrections')).json());
    assert.equal(mine.length, 1);
    assert.equal(mine[0].status, 'PENDING');

    // Employees cannot see the queue
    assert.equal((await api(emp.accessToken, '/attendance/corrections')).status, 403);

    const lead = await login(U.lead.email);
    const queue = CorrectionQueueSchema.parse(await (await api(lead.accessToken, '/attendance/corrections')).json());
    assert.equal(queue.length, 1);
    assert.equal(queue[0].requesterEmail, U.emp.email);

    // A lead who is not the requester's manager sees nothing and cannot review (403, not 500)
    const lead2 = await login(U.lead2.email);
    assert.deepEqual(await (await api(lead2.accessToken, '/attendance/corrections')).json(), []);
    const denied = await api(lead2.accessToken, `/attendance/corrections/${queue[0].id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'APPROVED' }),
    });
    assert.equal(denied.status, 403);

    const reject = await api(lead.accessToken, `/attendance/corrections/${queue[0].id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'REJECTED', reviewNote: 'No evidence attached' }),
    });
    assert.equal(reject.status, 200);
    assert.deepEqual(await (await api(lead.accessToken, '/attendance/corrections')).json(), []);
    const after = CorrectionListSchema.parse(await (await api(emp.accessToken, '/attendance/me/corrections')).json());
    assert.equal(after[0].status, 'REJECTED');
    assert.equal(after[0].reviewNote, 'No evidence attached');
  });

  it('live board: employee 403; team lead sees own team with hasClockedInToday; HR_MANAGER sees org (FR-ATT-016)', async () => {
    assert.equal((await api(emp.accessToken, '/attendance/live')).status, 403);

    const lead = await login(U.lead.email);
    const board = LiveBoardSchema.parse(await (await api(lead.accessToken, '/attendance/live')).json());
    const empRow = board.find((r) => r.userId === U.emp.id);
    const otherRow = board.find((r) => r.userId === U.other.id);
    assert.equal(empRow?.status, 'ACTIVE');
    assert.equal(empRow?.hasClockedInToday, true);
    assert.equal(otherRow?.status, 'OFFLINE');
    assert.equal(otherRow?.hasClockedInToday, false);
    assert.ok(!board.some((r) => r.userId === U.hrm.id), 'team-scoped');

    const { generateSync } = await import('otplib');
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: U.hrm.email, password: PASSWORD, totpCode: generateSync({ secret: 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD' }) }),
    });
    const hrm = (await res.json()) as Login;
    const orgBoard = await api(hrm.accessToken, '/attendance/live');
    assert.equal(orgBoard.status, 200);
    assert.ok(LiveBoardSchema.parse(await orgBoard.json()).some((r) => r.userId === U.hrm.id));
  });
  it('AC-04: after a server-side closure (TIMEOUT or DISCONNECT) today offers a correction for the gap', async () => {
    const now = new Date();
    const workDate = formatInTimeZone(now, 'Asia/Colombo', 'yyyy-MM-dd');
    const closedAt = new Date(now.getTime() - 2 * 3_600_000);
    const inserted = await adminPool.query(
      `INSERT INTO attendance_sessions (org_id, user_id, device_id, work_date, clock_in_at, clock_out_at, clock_in_source, clock_out_source, last_heartbeat_at, ip_in, status)
       VALUES ($1, $2, 'old-laptop', $3, $4, $5, 'AUTO', 'TIMEOUT', $5, '127.0.0.1', 'CLOSED') RETURNING id`,
      [ORG, U.emp.id, workDate, new Date(now.getTime() - 3 * 3_600_000), closedAt],
    );
    try {
      const today = MyTodaySchema.parse(await (await api(emp.accessToken, '/attendance/me/today')).json());
      assert.ok(today.lastClosed, 'the closed session is reported');
      assert.equal(today.lastClosed!.source, 'TIMEOUT');
      assert.equal(today.lastClosed!.at, closedAt.toISOString());
      // Unaccounted until the next session started (or until now when none did).
      const resumedAt = today.trackingSince ? Date.parse(today.trackingSince) : now.getTime();
      assert.equal(today.lastClosed!.minutesUnaccounted, Math.max(0, Math.floor((resumedAt - closedAt.getTime()) / 60_000)));
    } finally {
      await adminPool.query(`DELETE FROM attendance_sessions WHERE id = $1`, [inserted.rows[0].id]);
    }
  });

});
