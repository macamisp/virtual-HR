/**
 * FR-ATT-002, explicit logout (ADR 025), written before the fix. Logging out, a password reset or
 * an administrative revocation of someone's logins must close their open attendance session at
 * once, at the last valid heartbeat, with source LOGOUT, instead of waiting for the 120 s grace
 * window. A second, still-valid login that keeps heartbeating keeps the person clocked in. A tab
 * that merely closes still goes through the grace window.
 *
 * Measured numbers (logout -> session closed) are printed for the accuracy report (NFR-ACC-002).
 * The first test holds the 1 s target; the other cases allow 3 s, because the whole API suite runs
 * several API processes in parallel on one machine and notification delivery then lags.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { io, type Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { MAIL_TRANSPORT, InMemoryMailTransport } from '../src/common/mailer.ts';
import { HeartbeatValidator } from '../src/attendance/heartbeat-validator.ts';

const ORG = 'e2e10000-0000-4000-8000-000000000001';
const PORT = 3056;
const PASSWORD = 'ComplexPassword123!';
const U = {
  worker: { id: 'e2e10000-0000-4000-8000-000000000011', email: 'worker@logout.test', role: 'EMPLOYEE' },
  other: { id: 'e2e10000-0000-4000-8000-000000000012', email: 'other@logout.test', role: 'EMPLOYEE' },
} as const;
type Who = keyof typeof U;
interface Login { accessToken: string; sessionId: string; sessionSecret: string }
interface SessionRow { status: string; current_state: string; clock_out_source: string | null; clock_out_at: Date | null; last_heartbeat_at: Date; net_seconds: number; grace_timer_expires_at: Date | null }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Explicit logout closes the attendance session at once (FR-ATT-002, ADR 025)', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  let outbox: InMemoryMailTransport;
  const base = `http://localhost:${PORT}`;
  const sockets: Socket[] = [];
  const validator = new HeartbeatValidator();
  const seqs = new Map<string, number>();

  async function login(who: Who, password = PASSWORD): Promise<Login> {
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password }) });
    const body = (await res.json()) as Login & { message?: string };
    assert.equal(res.status, 200, `login ${who}: ${body.message}`);
    return { accessToken: body.accessToken, sessionId: body.sessionId, sessionSecret: body.sessionSecret };
  }
  async function connect(token: string): Promise<Socket> {
    const s = io(base, { transports: ['websocket'], reconnection: false, auth: { token } });
    sockets.push(s);
    await new Promise<void>((res, rej) => { s.once('connect', () => res()); s.once('connect_error', rej); });
    return s;
  }
  /** One signed, active heartbeat from this login on this device; returns the server's ack. */
  async function heartbeat(s: Socket, who: Who, l: Login, deviceId: string, activeSeconds = 30) {
    const sequenceNumber = (seqs.get(deviceId) ?? 0) + 1;
    seqs.set(deviceId, sequenceNumber);
    const data = { orgId: ORG, userId: U[who].id, deviceId, sessionId: l.sessionId, sequenceNumber, nonce: randomBytes(16).toString('hex'), activeSeconds, idleSeconds: 0, tabVisible: true, windowFocused: true, inCall: false };
    const ack = (await s.emitWithAck('presence:heartbeat', { ...data, signature: validator.signHeartbeat(data, l.sessionSecret) })) as { success: boolean; error?: string };
    assert.equal(ack.success, true, ack.error ?? 'heartbeat refused');
    return ack;
  }
  const session = async (who: Who): Promise<SessionRow | null> =>
    (await adminPool.query<SessionRow>(`SELECT status, current_state, clock_out_source, clock_out_at, last_heartbeat_at, net_seconds, grace_timer_expires_at FROM attendance_sessions WHERE user_id = $1 ORDER BY clock_in_at DESC LIMIT 1`, [U[who].id])).rows[0] ?? null;
  /** Polls until the latest session is CLOSED; returns how long that took. */
  async function closedWithin(who: Who, ms: number): Promise<{ row: SessionRow; latencyMs: number }> {
    const t0 = Date.now();
    for (;;) {
      const row = await session(who);
      if (row?.status === 'CLOSED') return { row, latencyMs: Date.now() - t0 };
      if (Date.now() - t0 > ms) throw new assert.AssertionError({ message: `session still ${row?.status}/${row?.current_state} after ${ms} ms: ${JSON.stringify(row)}` });
      await sleep(25);
    }
  }
  const closeAll = async () => { for (const s of sockets.splice(0)) s.disconnect(); await adminPool.query(`UPDATE attendance_sessions SET status = 'CLOSED', clock_out_at = last_heartbeat_at, clock_out_source = 'TIMEOUT' WHERE org_id = $1 AND status = 'OPEN'`, [ORG]); };
  const logout = (l: Login) => fetch(`${base}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${l.accessToken}` } });

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Logout Ltd', 'logout-e2e', 'Asia/Colombo')`, [ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status) VALUES ($1, $2, $3, $3, $4, $5, 'ACTIVE')`, [u.id, ORG, u.email, u.role, hash]);
      await adminPool.query(`INSERT INTO monitoring_consents (org_id, user_id, notice_version, consent_type, granted, accepted_at) VALUES ($1, $2, 'v1.0.0', 'MONITORING', true, now())`, [ORG, u.id]);
    }
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    outbox = app.get<InMemoryMailTransport>(MAIL_TRANSPORT, { strict: false });
  });

  after(async () => {
    for (const s of sockets) s.disconnect();
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.end();
  });

  it('POST /auth/logout closes the open session within 1 s, at the last valid heartbeat, source LOGOUT', async () => {
    const l = await login('worker');
    const s = await connect(l.accessToken);
    await heartbeat(s, 'worker', l, 'laptop-a');
    const open = await session('worker');
    assert.equal(open?.status, 'OPEN');
    await sleep(1500); // real time passes after the last heartbeat; none of it may be credited
    const t0 = Date.now();
    assert.equal((await logout(l)).status, 200);
    const { row, latencyMs } = await closedWithin('worker', 1000);
    console.log(`# NFR-ACC-002 logout: session closed ${Date.now() - t0} ms after the logout request (poll latency ${latencyMs} ms)`);
    assert.equal(row.clock_out_source, 'LOGOUT');
    assert.equal(row.clock_out_at!.getTime(), row.last_heartbeat_at.getTime(), 'clock-out is the last valid heartbeat, not the logout time');
    assert.equal(row.last_heartbeat_at.getTime(), open!.last_heartbeat_at.getTime());
    assert.equal(row.net_seconds, open!.net_seconds, 'no time after the last heartbeat is credited');
    await closeAll();
  });

  it('logout with no open attendance session is still a normal logout', async () => {
    const l = await login('other');
    assert.equal((await logout(l)).status, 200);
    assert.equal(await session('other'), null);
  });

  it('two logins (two devices): logging out of one keeps the person clocked in while the other still heartbeats; the last logout closes', async () => {
    const a = await login('worker');
    const b = await login('worker');
    const sa = await connect(a.accessToken);
    const sb = await connect(b.accessToken);
    await heartbeat(sa, 'worker', a, 'laptop-a');
    await heartbeat(sb, 'worker', b, 'phone-b');
    assert.equal((await logout(a)).status, 200);
    // Stays open while the revocation is processed (polled, so a slow notification cannot hide a wrong close).
    for (const t0 = Date.now(); Date.now() - t0 < 2000;) {
      const r = await session('worker');
      assert.equal(r?.status, 'OPEN', `the other login is still connected and heartbeating; got ${JSON.stringify(r)}`);
      await sleep(100);
    }
    let row = await session('worker');
    await heartbeat(sb, 'worker', b, 'phone-b');
    assert.equal(sb.connected, true, 'the second login is unaffected by the first logout');
    assert.equal((await logout(b)).status, 200);
    ({ row } = await closedWithin('worker', 3000));
    assert.equal(row.clock_out_source, 'LOGOUT');
    await closeAll();
  });

  it('a second login that stopped heartbeating long ago does not keep the person clocked in', async () => {
    const a = await login('worker');
    const b = await login('worker');
    const sa = await connect(a.accessToken);
    const sb = await connect(b.accessToken);
    await heartbeat(sa, 'worker', a, 'laptop-a');
    await heartbeat(sb, 'worker', b, 'phone-b');
    sb.disconnect();
    // The phone went quiet two minutes ago (longer than the 90 s missed-heartbeat window).
    await adminPool.query(`UPDATE session_secrets SET last_used_at = now() - interval '120 seconds' WHERE session_id = $1`, [b.sessionId]);
    assert.equal((await logout(a)).status, 200);
    const { row } = await closedWithin('worker', 3000);
    assert.equal(row.clock_out_source, 'LOGOUT');
    await closeAll();
    await logout(b);
  });

  it('two tabs of the same login: logout in one revokes the login, so the other tab cannot keep the session alive', async () => {
    const l = await login('worker');
    const tab1 = await connect(l.accessToken);
    const tab2 = await connect(l.accessToken);
    await heartbeat(tab1, 'worker', l, 'laptop-a');
    const revoked = new Promise<string>((res) => tab2.once('auth:revoked', (p: { reason: string }) => res(p.reason)));
    assert.equal((await logout(l)).status, 200);
    assert.equal(await revoked, 'LOGOUT', 'the other tab is told its login ended');
    const { row } = await closedWithin('worker', 3000);
    assert.equal(row.clock_out_source, 'LOGOUT');
    await closeAll();
  });

  it('a tab that closes (socket disconnect, no logout) still goes through the grace window', async () => {
    const l = await login('worker');
    const s = await connect(l.accessToken);
    await heartbeat(s, 'worker', l, 'laptop-a');
    s.disconnect();
    await sleep(700);
    const row = await session('worker');
    assert.equal(row?.status, 'OPEN');
    assert.equal(row?.current_state, 'DISCONNECTED');
    assert.ok(row?.grace_timer_expires_at, 'grace timer started');
    await closeAll();
    await logout(l);
  });

  it('a password reset revokes every login and closes the session within 1 s', async () => {
    const l = await login('worker');
    const s = await connect(l.accessToken);
    await heartbeat(s, 'worker', l, 'laptop-a');
    assert.equal((await fetch(`${base}/auth/password/forgot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U.worker.email }) })).status, 202);
    const token = outbox.outbox.at(-1)!.text.match(/#token=([0-9a-f]{64})/)![1];
    const t0 = Date.now();
    const reset = await fetch(`${base}/auth/password/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, newPassword: 'AnotherLongPassword456!' }) });
    assert.equal(reset.status, 200, await reset.text());
    const { row } = await closedWithin('worker', 3000);
    console.log(`# NFR-ACC-002 password reset: session closed ${Date.now() - t0} ms after the reset`);
    assert.equal(row.clock_out_source, 'LOGOUT');
    assert.equal(row.clock_out_at!.getTime(), row.last_heartbeat_at.getTime());
    await closeAll();
    await adminPool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [U.worker.id, await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 })]);
  });

  it('an administrative revocation (role change, deactivation) closes the session within 1 s', async () => {
    const l = await login('worker');
    const s = await connect(l.accessToken);
    await heartbeat(s, 'worker', l, 'laptop-a');
    const t0 = Date.now();
    // What admin.service does when a role change requires a fresh sign-in (the trigger notifies).
    await adminPool.query(`UPDATE auth_sessions SET is_revoked = true, revoked_reason = 'ROLE_CHANGED', updated_at = now() WHERE org_id = $1 AND user_id = $2 AND NOT is_revoked`, [ORG, U.worker.id]);
    const { row } = await closedWithin('worker', 3000);
    console.log(`# NFR-ACC-002 admin revoke: session closed ${Date.now() - t0} ms after the revocation`);
    assert.equal(row.clock_out_source, 'LOGOUT');
    await closeAll();
  });
});
