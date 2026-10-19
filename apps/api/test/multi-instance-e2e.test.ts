/**
 * Two API instances sharing only Postgres and Redis (ADR 020, COORDINATION=redis): Socket.IO rooms
 * span instances, rate limits are counted once for both, and concurrent heartbeats for one person
 * arriving at different instances never lose an update (distributed session lock).
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { AttendanceGateway } from '../src/attendance/attendance.gateway.ts';
import { signHeartbeatPayload } from '../../../packages/shared/src/attendance/heartbeat-signer.ts';
import { CONSENT_NOTICES } from '../../../packages/shared/src/index.ts';
import { resetOrgs } from './support/reset-orgs.ts';

const ORG = 'a8a80000-0000-4000-8000-000000000001';
const USER = { id: 'a8a80000-0000-4000-8000-000000000011', email: 'mia@multi.test' };
const PASSWORD = 'ComplexPassword123!';
const PORTS = [3083, 3084] as const;
const REDIS_DB = '8';

describe('Multi-instance coordination (ADR 020)', { concurrency: false }, () => {
  const apps: INestApplication[] = [];
  let adminPool: pg.Pool;
  const sockets: Socket[] = [];
  let login: { accessToken: string; sessionId: string; sessionSecret: string };
  const url = (i: number) => `http://localhost:${PORTS[i]}`;
  function socket(i: number): Promise<Socket> {
    const s = io(url(i), { transports: ['websocket'], reconnection: false, auth: { token: login.accessToken } });
    sockets.push(s);
    return new Promise((res, rej) => { s.once('connect', () => res(s)); s.once('connect_error', rej); });
  }

  before(async () => {
    Object.assign(process.env, {
      COORDINATION: 'redis', REDIS_DB, BREACHED_PASSWORD_CHECK: 'local', MAIL_TRANSPORT: 'memory', JOBS_ENABLED: 'false',
      RATE_LIMIT_LOGIN: '5', RATE_LIMIT_HEARTBEAT: '1000',
    });
    const r = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: Number(process.env.REDIS_PORT || 6379), db: Number(REDIS_DB) });
    await r.flushdb();
    r.disconnect();
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await resetOrgs(adminPool, [ORG]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Multi Ltd', 'multi-e2e')`, [ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status) VALUES ($1, $2, $3, 'Mia Multi', 'EMPLOYEE', $4, 'ACTIVE')`, [USER.id, ORG, USER.email, hash]);
    await adminPool.query(`INSERT INTO monitoring_consents (org_id, user_id, notice_version, consent_type, granted, accepted_at) VALUES ($1, $2, $3, 'MONITORING', true, now())`, [ORG, USER.id, CONSENT_NOTICES.MONITORING.version]);
    for (const port of PORTS) {
      const app = await NestFactory.create(AppModule, { logger: false });
      configureApp(app);
      await app.listen(port);
      apps.push(app);
    }
    const res = await fetch(`${url(0)}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: USER.email, password: PASSWORD }) });
    login = (await res.json()) as typeof login;
  });

  after(async () => {
    for (const s of sockets) s.disconnect();
    for (const app of apps) await app.close();
    await resetOrgs(adminPool, [ORG]);
    await adminPool.end();
    for (const k of ['COORDINATION', 'REDIS_DB', 'RATE_LIMIT_LOGIN']) delete process.env[k];
  });

  it('health reports the database and Redis on both instances', async () => {
    for (let i = 0; i < 2; i += 1) {
      const h = await (await fetch(`${url(i)}/health`)).json();
      assert.deepEqual(h, { status: 'ok', db: 'ok', redis: 'ok' });
    }
  });

  it('an event emitted on instance B reaches a socket held by instance A (Redis adapter)', async () => {
    const s = await socket(0);
    const got = new Promise<{ n: number }>((res) => s.once('test:ping', res));
    apps[1]!.get(AttendanceGateway).notifyUser(USER.id, 'test:ping', { n: 7 });
    const msg = await Promise.race([got, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('not delivered across instances')), 5000))]);
    assert.equal(msg.n, 7);
  });

  it('login rate limits are counted once across both instances', async () => {
    const bad = (i: number) => fetch(`${url(i)}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: USER.email, password: 'wrong-password-123' }) });
    // One successful login above + four wrong ones alternating = the limit of 5.
    for (let i = 0; i < 4; i += 1) assert.notEqual((await bad(i % 2)).status, 429, `attempt ${i + 2}`);
    assert.equal((await bad(1)).status, 429, 'the 6th attempt, on either instance, is refused');
    assert.equal((await bad(0)).status, 429);
  });

  it('concurrent heartbeats for one person on both instances lose no update (distributed lock)', async () => {
    const [a, b] = await Promise.all([socket(0), socket(1)]);
    let seq = Math.floor(Date.now() / 1000);
    const payloads = await Promise.all(Array.from({ length: 20 }, async () => {
      seq += 1;
      return signHeartbeatPayload({ orgId: ORG, userId: USER.id, deviceId: 'web-mia', sessionId: login.sessionId, sequenceNumber: seq, nonce: randomUUID(),
        activeSeconds: 30, idleSeconds: 0, tabVisible: true, windowFocused: true, inCall: false }, login.sessionSecret);
    }));
    // Sequence numbers must arrive in order per device, so send them one after another but
    // alternate the instance, and fire the two instances' streams together.
    const acks = await Promise.all([a, b].map(async (sock, which) => {
      const out: boolean[] = [];
      for (const [i, hb] of payloads.entries()) {
        if (i % 2 !== which) continue;
        out.push(((await sock.emitWithAck('presence:heartbeat', hb)) as { success: boolean }).success);
      }
      return out;
    }));
    const accepted = acks.flat().filter(Boolean).length;
    const s = (await adminPool.query(`SELECT active_seconds FROM attendance_sessions WHERE user_id = $1 AND status = 'OPEN'`, [USER.id])).rows[0];
    assert.equal(s.active_seconds, accepted * 30, `${accepted} accepted heartbeats, none lost`);
    assert.ok(accepted >= 10, `accepted ${accepted}`);
  });
});
