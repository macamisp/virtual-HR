/**
 * Subcontractor weekly hours cap with 80 % and 100 % warnings (FR-ORG-004; ADR 034): the rule,
 * the week (Monday to Sunday, organisation time), and against the real API and Postgres that
 * logged time crossing 80 % and 100 % tells the subcontractor, their manager and HR once each;
 * time from another week does not count; a running timer that crosses the cap is caught by the
 * scheduled check without any write.
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
import { ScheduledWorkService } from '../src/notifications/scheduled-work.service.ts';
import { capStatus, weekOf } from '../src/timesheets/weekly-cap.ts';
import { WeeklyCapSchema } from '../../../packages/shared/src/timesheets/types.ts';

const ORG = '7a7a0000-0000-4000-8000-000000000001';
const PORT = 3114;
const TZ = 'Asia/Colombo';
const PASSWORD = 'ComplexPassword123!';
const U = {
  hr: { id: '7a7a0000-0000-4000-8000-000000000011', email: 'hr@cap.test', role: 'HR', manager: null as string | null },
  mgr: { id: '7a7a0000-0000-4000-8000-000000000012', email: 'mgr@cap.test', role: 'MANAGER', manager: null as string | null },
  sub: { id: '7a7a0000-0000-4000-8000-000000000013', email: 'sub@cap.test', role: 'SUBCONTRACTOR', manager: '7a7a0000-0000-4000-8000-000000000012' as string | null },
  timer: { id: '7a7a0000-0000-4000-8000-000000000014', email: 'timer@cap.test', role: 'SUBCONTRACTOR', manager: '7a7a0000-0000-4000-8000-000000000012' as string | null },
  emp: { id: '7a7a0000-0000-4000-8000-000000000015', email: 'emp@cap.test', role: 'EMPLOYEE', manager: null as string | null },
} as const;
type Who = 'sub' | 'timer' | 'emp';
const today = () => formatInTimeZone(new Date(), TZ, 'yyyy-MM-dd');

describe('Weekly hours cap: the rule and the week (FR-ORG-004)', () => {
  it('no cap is NONE; 80 % warns; 100 % is over', () => {
    assert.deepEqual(capStatus(null, 600), { level: 'NONE', percent: null });
    assert.deepEqual(capStatus(0, 600), { level: 'NONE', percent: null });
    assert.equal(capStatus(10, 479).level, 'UNDER');
    assert.deepEqual(capStatus(10, 480), { level: 'WARN', percent: 80 });
    assert.equal(capStatus(10, 599).level, 'WARN');
    assert.deepEqual(capStatus(10, 600), { level: 'OVER', percent: 100 });
    assert.deepEqual(capStatus(10, 630), { level: 'OVER', percent: 105 });
  });

  it('a week runs Monday to Sunday', () => {
    assert.deepEqual(weekOf('2026-10-19'), { start: '2026-10-19', end: '2026-10-25' }); // a Monday
    assert.deepEqual(weekOf('2026-10-25'), { start: '2026-10-19', end: '2026-10-25' }); // its Sunday
    assert.deepEqual(weekOf('2026-10-26'), { start: '2026-10-26', end: '2026-11-01' });
    assert.deepEqual(weekOf('2026-12-31'), { start: '2026-12-28', end: '2027-01-03' });
  });
});

describe('Weekly hours cap warnings (FR-ORG-004)', { concurrency: false }, () => {
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
  const log = (who: Who, minutes: number, workDate = today()) => api(who, '/time-entries', { method: 'POST', body: { workDate, minutes, reason: 'Work done offline' } });
  /** Cap notifications per recipient, after the post-commit listener has had time to run. */
  const caps = async (about: string, expect?: Record<string, number>) => {
    const read = async () => (await adminPool.query<{ user_id: string; type: string; n: number }>(
      `SELECT user_id, type, count(*)::int AS n FROM notifications WHERE org_id = $1 AND entity_id = $2 AND type LIKE 'WEEKLY_CAP_%' GROUP BY 1, 2`, [ORG, about])).rows;
    const key = (rows: Awaited<ReturnType<typeof read>>) => Object.fromEntries(rows.map((r) => [`${Object.entries(U).find(([, u]) => u.id === r.user_id)?.[0]}:${r.type}`, r.n]));
    for (let i = 0; i < 30; i += 1) {
      const got = key(await read());
      if (!expect || JSON.stringify(Object.entries(got).sort()) === JSON.stringify(Object.entries(expect).sort())) return got;
      await new Promise((r) => setTimeout(r, 100));
    }
    return key(await read());
  };

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    const pgBase = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev' };
    adminPool = new pg.Pool({ ...pgBase, user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Cap Ltd', 'cap-e2e', $2)`, [ORG, TZ]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const [k, u] of Object.entries(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')`, [u.id, ORG, u.email, k, u.role, hash]);
    }
    for (const u of Object.values(U)) if (u.manager) await adminPool.query(`UPDATE users SET manager_id = $1 WHERE id = $2`, [u.manager, u.id]);
    await adminPool.query(`INSERT INTO subcontractor_profiles (user_id, org_id, rate_type, rate, currency, weekly_hours_cap) VALUES ($1, $3, 'HOURLY', 2500, 'LKR', 10), ($2, $3, 'HOURLY', 2500, 'LKR', 1)`, [U.sub.id, U.timer.id, ORG]);
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    for (const who of ['sub', 'timer', 'emp'] as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
      assert.ok(tokens[who], `login ${who}`);
    }
  });

  after(async () => {
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.end();
  });

  it('reports this week\'s hours against the cap; no cap, no level', async () => {
    const s = await ok(await api('sub', '/timesheets/weekly-cap'), 200, WeeklyCapSchema);
    assert.deepEqual([s.capHours, s.loggedMinutes, s.level, s.weekStart], [10, 0, 'UNDER', weekOf(today()).start]);
    assert.equal((await ok(await api('emp', '/timesheets/weekly-cap'), 200, WeeklyCapSchema)).level, 'NONE');
  });

  it('80 % and 100 % reach the subcontractor, their manager and HR once each; another week does not count', async () => {
    await ok(await log('sub', 7 * 60), 201);
    await ok(await log('sub', 5 * 60, formatInTimeZone(new Date(Date.now() - 7 * 86_400_000), TZ, 'yyyy-MM-dd')), 201);
    assert.deepEqual(await caps(U.sub.id), {}, '7 h of 10 this week; last week\'s 5 h are another week');
    await ok(await log('sub', 60), 201);
    const warned = { 'sub:WEEKLY_CAP_WARNING': 1, 'mgr:WEEKLY_CAP_WARNING': 1, 'hr:WEEKLY_CAP_WARNING': 1 };
    assert.deepEqual(await caps(U.sub.id, warned), warned, '8 h = 80 %');
    await ok(await log('sub', 30), 201);
    assert.deepEqual(await caps(U.sub.id), warned, '85 %: no second warning');
    await ok(await log('sub', 120), 201);
    const reached = { ...warned, 'sub:WEEKLY_CAP_REACHED': 1, 'mgr:WEEKLY_CAP_REACHED': 1, 'hr:WEEKLY_CAP_REACHED': 1 };
    assert.deepEqual(await caps(U.sub.id, reached), reached, '10.5 h = 105 %');
    await ok(await log('sub', 15), 201);
    assert.deepEqual(await caps(U.sub.id), reached, 'still once each');
    const s = await ok(await api('sub', '/timesheets/weekly-cap'), 200, WeeklyCapSchema);
    assert.deepEqual([s.loggedMinutes, s.percent, s.level], [645, 107.5, 'OVER']);
    const title = (await adminPool.query<{ title: string }>(`SELECT title FROM notifications WHERE user_id = $1 AND type = 'WEEKLY_CAP_REACHED'`, [U.mgr.id])).rows[0]!.title;
    assert.equal(title, 'sub has reached their weekly hours cap');
  });

  it('a running timer that crosses the cap is caught by the scheduled check, without any write', async () => {
    await ok(await log('timer', 1), 201); // creates this week's timesheet
    const sheet = (await adminPool.query<{ timesheet_id: string }>(`SELECT timesheet_id FROM time_entries WHERE user_id = $1 LIMIT 1`, [U.timer.id])).rows[0]!.timesheet_id;
    await adminPool.query(`INSERT INTO time_entries (org_id, user_id, timesheet_id, work_date, started_at, source) VALUES ($1, $2, $3, $4::date, now() - interval '70 minutes', 'TIMER')`, [ORG, U.timer.id, sheet, today()]);
    assert.deepEqual(await caps(U.timer.id), {}, 'nothing was written, so nothing was checked yet');
    await app.get(ScheduledWorkService).timesheetReminders(new Date());
    const got = await caps(U.timer.id);
    assert.equal(got['timer:WEEKLY_CAP_REACHED'], 1, '71 min of a 1 h cap');
    assert.equal(got['mgr:WEEKLY_CAP_REACHED'], 1);
    await app.get(ScheduledWorkService).timesheetReminders(new Date());
    assert.equal((await caps(U.timer.id))['timer:WEEKLY_CAP_REACHED'], 1, 'the next run does not repeat it');
  });
});
