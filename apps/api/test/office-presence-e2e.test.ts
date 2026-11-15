/**
 * Office connection intervals (ADR 059, FR-REP-009) over the real office socket: the first
 * connection opens one interval however many tabs; a reload within the grace keeps it; a drop
 * ends it at the moment of the drop (the grace is never counted); leaving ends it now; the minute
 * refresh moves last_seen_at for connected people only; startup and the sweep close leftovers at
 * their last observation without touching fresh ones; a database failure never blocks the office;
 * another organisation sees nothing; only times are stored; attendance is not touched.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { io, type Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { OfficePresenceStore } from '../src/office/office-presence.ts';
import type { JoinAck, MoveAck } from '../../../packages/shared/src/office/index.ts';
import { resetOrgs } from './support/reset-orgs.ts';

const ORG = 'f1f50000-0000-4000-8000-000000000001';
const OTHER = 'f1f50000-0000-4000-8000-000000000002';
const PORT = 3117;
const PASSWORD = 'ComplexPassword123!';
const GRACE = 1500;
const u = (n: string) => `f1f50000-0000-4000-8000-0000000000${n}`;
const U = {
  a: { id: u('a1'), org: ORG, email: 'ana@presence.test' },
  b: { id: u('b1'), org: ORG, email: 'bo@presence.test' },
  c: { id: u('c1'), org: ORG, email: 'cy@presence.test' },
  d: { id: u('d1'), org: ORG, email: 'di@presence.test' },
  e: { id: u('e1'), org: ORG, email: 'ed@presence.test' },
  f: { id: u('f1'), org: ORG, email: 'fi@presence.test' },
  g: { id: u('a2'), org: ORG, email: 'gu@presence.test' },
  h: { id: u('b2'), org: ORG, email: 'ha@presence.test' },
  o: { id: u('c2'), org: OTHER, email: 'oz@presence-other.test' },
} as const;
type Who = keyof typeof U;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
interface Row { id: string; started_at: Date; ended_at: Date | null; last_seen_at: Date; end_reason: string | null }

describe('Office connection intervals (ADR 059)', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  let store: OfficePresenceStore;
  const base = `http://localhost:${PORT}`;
  const tokens = {} as Record<Who, string>;
  const sockets: Socket[] = [];
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  async function tab(who: Who): Promise<Socket> {
    const s = io(base, { transports: ['websocket'], reconnection: false, auth: { token: tokens[who], purpose: 'office' } });
    sockets.push(s);
    await new Promise<void>((res, rej) => { s.once('connect', () => res()); s.once('connect_error', rej); });
    const join = (await s.emitWithAck('office:join', { positions: true })) as JoinAck;
    assert.ok(join.ok, `${who} joins`);
    return s;
  }
  const rows = async (who: Who): Promise<Row[]> => {
    await store.flush();
    return (await adminPool.query<Row>(`SELECT id, started_at, ended_at, last_seen_at, end_reason FROM office_presence_intervals WHERE user_id = $1 ORDER BY started_at`, [U[who].id])).rows;
  };
  const seed = (who: Who, started: Date, lastSeen: Date) => adminPool.query(
    `INSERT INTO office_presence_intervals (org_id, user_id, started_at, last_seen_at) VALUES ($1, $2, $3, $4)`, [U[who].org, U[who].id, started, lastSeen]);

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    process.env.OFFICE_LEAVE_GRACE_MS = String(GRACE);
    process.env.OFFICE_PRESENCE_REFRESH_MS = '0'; // the test calls refresh() itself
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await resetOrgs(adminPool, [ORG, OTHER]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Presence Ltd', 'presence-e2e'), ($2, 'Presence Other Ltd', 'presence-other-e2e')`, [ORG, OTHER]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const x of Object.values(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status) VALUES ($1, $2, $3, $3, 'EMPLOYEE', $4, 'ACTIVE')`, [x.id, x.org, x.email, hash]);
    }
    // Left open by a process that stopped 10 minutes ago, and one a live process refreshed 30 s ago.
    await seed('d', minutesAgo(120), minutesAgo(10));
    await seed('e', minutesAgo(60), new Date(Date.now() - 30_000));
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    store = app.get(OfficePresenceStore);
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
      assert.ok(tokens[who], `login ${who}`);
    }
  });

  after(async () => {
    for (const s of sockets) s.disconnect();
    await store?.flush();
    await app?.close();
    await resetOrgs(adminPool, [ORG, OTHER]);
    await adminPool.end();
    delete process.env.OFFICE_PRESENCE_REFRESH_MS;
  });

  it('startup closes what a stopped process left open, at its last observation, and leaves fresh intervals alone', async () => {
    const [d] = await rows('d');
    assert.equal(d!.end_reason, 'SERVER_RESTART');
    assert.equal(d!.ended_at!.getTime(), d!.last_seen_at.getTime(), 'never counted past the last time it was seen');
    const [e] = await rows('e');
    assert.equal(e!.ended_at, null, 'another live process keeps this one fresh');
  });

  it('the first connection opens one interval; a second tab adds nothing; one tab closing keeps it open', async () => {
    const t0 = Date.now();
    const tab1 = await tab('a');
    const t1 = Date.now();
    let r = await rows('a');
    assert.equal(r.length, 1);
    assert.equal(r[0]!.ended_at, null);
    assert.ok(r[0]!.started_at.getTime() >= t0 - 5 && r[0]!.started_at.getTime() <= t1 + 5, 'server time of the join');
    const tab2 = await tab('a');
    r = await rows('a');
    assert.equal(r.length, 1, 'two tabs, one interval');
    tab2.disconnect();
    await wait(GRACE + 600);
    r = await rows('a');
    assert.deepEqual(r.map((x) => x.ended_at), [null], 'still connected through the first tab');
    tab1.disconnect();
  });

  it('a reload within the grace keeps the same interval: no gap, no second row, never ended', async () => {
    await wait(GRACE + 600); // the previous test's last tab is gone: its interval ended
    const tab1 = await tab('b');
    const [first] = await rows('b');
    tab1.disconnect();
    await wait(300);
    await tab('b'); // the same sign-in, back within the grace
    await wait(GRACE + 600);
    const r = await rows('b');
    assert.equal(r.length, 1);
    assert.equal(r[0]!.id, first!.id);
    assert.equal(r[0]!.ended_at, null);
  });

  it('a drop without return ends the interval at the moment of the drop: the grace is not counted', async () => {
    const ended = (await rows('a'))[0]!;
    assert.equal(ended.end_reason, 'DROPPED');
    const s = await tab('c');
    await wait(200);
    const before = Date.now();
    s.disconnect();
    await wait(GRACE + 700);
    const [r] = await rows('c');
    assert.equal(r!.end_reason, 'DROPPED');
    assert.ok(r!.ended_at!.getTime() >= before - 5 && r!.ended_at!.getTime() < before + 400, `ended at the drop (${r!.ended_at!.getTime() - before} ms after), not after the ${GRACE} ms grace`);
  });

  it('leaving the office ends the interval at once', async () => {
    const s = await tab('f');
    await wait(200);
    const t = Date.now();
    await s.emitWithAck('office:leave', {});
    const [r] = await rows('f');
    assert.equal(r!.end_reason, 'LEFT');
    assert.ok(Math.abs(r!.ended_at!.getTime() - t) < 400);
  });

  it('the minute refresh moves last_seen for people connected now only; the sweep closes intervals nobody refreshes', async () => {
    await adminPool.query(`UPDATE office_presence_intervals SET started_at = $2, last_seen_at = $2 WHERE user_id = $1 AND ended_at IS NULL`, [U.b.id, minutesAgo(2)]);
    const leftoverStart = minutesAgo(30);
    await seed('h', leftoverStart, minutesAgo(5)); // nobody behind it
    const now = Date.now();
    await store.refresh(now);
    const [b] = await rows('b');
    assert.equal(b!.last_seen_at.getTime(), now, 'connected: seen now');
    const [h] = await rows('h');
    assert.equal(h!.end_reason, 'SERVER_RESTART');
    assert.equal(h!.ended_at!.getTime(), h!.last_seen_at.getTime());
    const [f] = await rows('f');
    assert.ok(f!.last_seen_at.getTime() < now, 'a person who left is not refreshed');
  });

  it('a leftover from a previous process is closed at its last observation when the person connects again', async () => {
    const seen = new Date(Date.now() - 40_000); // fresh enough for the sweep, but not this process's
    await seed('g', minutesAgo(20), seen);
    await tab('g');
    const r = await rows('g');
    assert.equal(r.length, 2);
    assert.deepEqual({ reason: r[0]!.end_reason, end: r[0]!.ended_at!.getTime() }, { reason: 'SERVER_RESTART', end: seen.getTime() });
    assert.equal(r[1]!.ended_at, null);
  });

  it('a failing database never blocks joining or moving; the failure is counted, not thrown', async () => {
    const real = Reflect.get(store, 'prisma') as unknown;
    const failing = { runWithTenantContext: () => Promise.reject(Object.assign(new Error('down'), { code: '57P01' })), getPool: () => ({ query: () => Promise.reject(Object.assign(new Error('down'), { code: '57P01' })) }) };
    Reflect.set(store, 'prisma', failing);
    try {
      const failures = store.stats.failures;
      const s = await tab('e');
      const ack = (await s.emitWithAck('office:join', { positions: true })) as JoinAck;
      assert.ok(ack.ok);
      await wait(120);
      const move = (await s.emitWithAck('office:move', { x: ack.self.x + 10, y: ack.self.y, dir: 0 })) as MoveAck;
      assert.ok(move.ok, JSON.stringify(move));
      await store.refresh();
      await store.flush();
      assert.ok(store.stats.failures > failures, 'counted');
    } finally {
      Reflect.set(store, 'prisma', real);
    }
  });

  it('another organisation sees none of it; only times are stored; attendance is not touched', async () => {
    await tab('o');
    await store.flush();
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE hrvo_app');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [OTHER]);
      const seen = await c.query<{ user_id: string }>(`SELECT DISTINCT user_id FROM office_presence_intervals`);
      assert.deepEqual(seen.rows.map((r) => r.user_id), [U.o.id], 'the other organisation sees only its own');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
      const mine = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM office_presence_intervals WHERE user_id = $1`, [U.o.id]);
      assert.equal(mine.rows[0]!.n, 0);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    const cols = await adminPool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'office_presence_intervals' ORDER BY ordinal_position`);
    assert.deepEqual(cols.rows.map((r) => r.column_name), ['id', 'org_id', 'user_id', 'started_at', 'ended_at', 'last_seen_at', 'end_reason', 'created_at'], 'no room, position, desk or activity');
    const att = await adminPool.query<{ n: number }>(`SELECT (SELECT count(*) FROM attendance_sessions WHERE org_id = ANY($1::uuid[])) + (SELECT count(*) FROM presence_events WHERE org_id = ANY($1::uuid[])) AS n`, [[ORG, OTHER]]);
    assert.equal(Number(att.rows[0]!.n), 0, 'no attendance written by the office');
  });
});
