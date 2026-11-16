/** D4 investigation: real HTTP requests under controlled row-lock and pool contention.
 * FR-VO-003, FR-VO-016. Never logs tokens, status messages or SQL parameters.
 */
import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import pg from 'pg';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { PrismaService } from '../src/common/prisma.service.ts';
import { resetOrgs } from './support/reset-orgs.ts';

describe('Office status request lifecycle (D4)', { concurrency: false }, () => {
  const org = randomUUID();
  const person = randomUUID();
  const password = randomBytes(24).toString('hex');
  let app: INestApplication;
  let admin: pg.Pool;
  let prisma: PrismaService;
  let token: string;
  let base: string;
  let oldMax: string | undefined;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
  async function until<T>(sample: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 5000;
    while (true) {
      const value = await sample();
      if (matches(value)) return value;
      assert.ok(Date.now() < deadline, 'controlled contention must become observable within 5 s');
      await pause();
    }
  }
  const status = (value: 'AUTO' | 'DND') => fetch(`${base}/office/me/status`, {
    method: 'PUT', signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: value }),
  });
  async function blockedPid(): Promise<number | null> {
    const r = await admin.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND usename = $1 AND wait_event_type = 'Lock'
      AND query LIKE 'UPDATE users SET vo_status =%'`, [process.env.PGUSER || 'hrvo_app']);
    return r.rows[0]?.pid ?? null;
  }
  before(async () => {
    oldMax = process.env.PG_POOL_MAX;
    process.env.PG_POOL_MAX = '2';
    process.env.JOBS_ENABLED = 'false';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    admin = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await admin.query(`INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Status lifecycle', $1::text)`, [org]);
    await admin.query(`INSERT INTO users (id, org_id, email, role, password_hash, status) VALUES ($1, $2, $3, 'EMPLOYEE', $4, 'ACTIVE')`,
      [person, org, `${person}@status.test`, await argon2.hash(password, { type: argon2.argon2id })]);
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    prisma = app.get(PrismaService);
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `${person}@status.test`, password }) });
    assert.equal(login.status, 200);
    token = (await login.json() as { accessToken: string }).accessToken;
    assert.ok(token);
  });
  after(async () => {
    await app?.close();
    if (admin) { await resetOrgs(admin, [org]); await admin.end(); }
    if (oldMax === undefined) delete process.env.PG_POOL_MAX; else process.env.PG_POOL_MAX = oldMax;
  });

  it('a status request waits on a known row lock and completes after release, with no leaked transaction', async () => {
    const lock = await admin.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [person]);
      const started = performance.now();
      const response = status('DND');
      const pid = await until(blockedPid, (p) => p !== null);
      assert.ok(pid);
      assert.ok(prisma.getPool().totalCount <= 2);
      await lock.query('ROLLBACK');
      const r = await response;
      assert.equal(r.status, 200);
      assert.equal((await r.json() as { status: string }).status, 'DND');
      const idle = await admin.query<{ state: string }>('SELECT state FROM pg_stat_activity WHERE pid = $1', [pid]);
      assert.equal(idle.rows[0]?.state, 'idle');
      console.log(JSON.stringify({ scenario: 'row-lock-released', durationMs: Math.round(performance.now() - started), poolWaiting: prisma.getPool().waitingCount }));
    } finally { await lock.query('ROLLBACK'); lock.release(); }
  });

  it('a request queued behind the two-connection pool completes when a connection is returned', async () => {
    const pool = prisma.getPool();
    const held = await Promise.all([pool.connect(), pool.connect()]);
    try {
      const started = performance.now();
      const response = status('AUTO');
      await until(async () => pool.waitingCount, (n) => n > 0);
      assert.equal(pool.totalCount, 2);
      held.pop()!.release();
      assert.equal((await response).status, 200);
      assert.equal(pool.waitingCount, 0);
      console.log(JSON.stringify({ scenario: 'pool-connection-returned', durationMs: Math.round(performance.now() - started), poolTotal: pool.totalCount, poolWaiting: pool.waitingCount }));
    } finally { held.forEach((client) => client.release()); }
  });

  it('a cancelled blocked query produces an HTTP error, rolls back, releases the connection and permits retry', async () => {
    const lock = await admin.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [person]);
      const response = status('DND');
      const pid = await until(blockedPid, (p) => p !== null);
      // Only the blocked status query in this test database; no backend is terminated.
      await admin.query('SELECT pg_cancel_backend($1)', [pid]);
      const r = await response;
      assert.equal(r.status, 500);
      assert.equal((await r.json() as { message: string }).message, 'Internal server error');
      await lock.query('ROLLBACK');
      assert.equal((await status('AUTO')).status, 200);
      assert.equal(prisma.getPool().waitingCount, 0);
    } finally { await lock.query('ROLLBACK'); lock.release(); }
  });
});
