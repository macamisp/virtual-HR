/**
 * ADR 049 decisions D3 and D4 (FR-ATT-013), written before the fix:
 *  D3  a correction is decided once: a second approval is 409 and creates no second session;
 *  D4  reviewers are the requester's manager, a lead/manager of the requester's team, or HR,
 *      not any MANAGER in the organisation.
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
import { CorrectionQueueSchema, CorrectionSchema } from '../../../packages/shared/src/attendance/api.ts';
import { freshCode } from './support/totp.ts';

const ORG = 'c0440000-0000-4000-8000-000000000001';
const TEAM_A = 'c0440000-0000-4000-8000-000000000101';
const TEAM_B = 'c0440000-0000-4000-8000-000000000102';
const PORT = 3069;
const PASSWORD = 'ComplexPassword123!';
const MFA_SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const U = {
  emp: { id: 'c0440000-0000-4000-8000-000000000011', email: 'emp@corr.test', role: 'EMPLOYEE', team: TEAM_A as string | null },
  lead: { id: 'c0440000-0000-4000-8000-000000000012', email: 'lead@corr.test', role: 'TEAM_LEAD', team: TEAM_A as string | null },
  mgrA: { id: 'c0440000-0000-4000-8000-000000000013', email: 'mgra@corr.test', role: 'MANAGER', team: TEAM_A as string | null },
  mgrB: { id: 'c0440000-0000-4000-8000-000000000014', email: 'mgrb@corr.test', role: 'MANAGER', team: TEAM_B as string | null },
  hr: { id: 'c0440000-0000-4000-8000-000000000015', email: 'hr@corr.test', role: 'HR', team: null as string | null },
} as const;
type Who = keyof typeof U;
const TZ = 'Asia/Colombo';
const day = (n: number) => formatInTimeZone(new Date(Date.now() - n * 86_400_000), TZ, 'yyyy-MM-dd');

describe('Attendance corrections are decided once, by reviewers in scope (ADR 049 D3, D4)', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  const tokens = {} as Record<Who, string>;
  const base = `http://localhost:${PORT}`;
  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const request = async (n: number) => {
    const d = day(n);
    const res = await api('emp', '/attendance/corrections', { method: 'POST', body: { requestedIn: new Date(`${d}T09:00:00+05:30`).toISOString(), requestedOut: new Date(`${d}T17:00:00+05:30`).toISOString(), reason: 'Worked offline all day' } });
    assert.equal(res.status, 201, await res.clone().text());
    return CorrectionSchema.parse(await res.json());
  };
  const correctionSessions = async (d: string) => (await adminPool.query(`SELECT count(*)::int AS n FROM attendance_sessions WHERE user_id = $1 AND work_date = $2 AND clock_in_source = 'CORRECTION' AND status <> 'ADJUSTED'`, [U.emp.id, d])).rows[0].n as number;

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    const pgBase = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev' };
    adminPool = new pg.Pool({ ...pgBase, user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Corrections Ltd', 'corr-e2e', $2)`, [ORG, TZ]);
    await adminPool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $3, 'A'), ($2, $3, 'B')`, [TEAM_A, TEAM_B, ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const [k, u] of Object.entries(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, team_id, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`, [u.id, ORG, u.email, k, u.role, u.team, hash]);
    }
    await adminPool.query(`UPDATE users SET manager_id = $1 WHERE id = $2`, [U.lead.id, U.emp.id]);
    await adminPool.query(`UPDATE users SET mfa_enabled = true, mfa_secret = $1 WHERE id = $2`, [MFA_SECRET, U.hr.id]);
    for (const who of Object.keys(U) as Who[]) await adminPool.query(`INSERT INTO monitoring_consents (org_id, user_id, notice_version) VALUES ($1, $2, 'v1.0.0') ON CONFLICT DO NOTHING`, [ORG, U[who].id]).catch(() => undefined);
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD, ...(who === 'hr' ? { totpCode: await freshCode(MFA_SECRET) } : {}) }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
      assert.ok(tokens[who], `login ${who}`);
    }
  });

  after(async () => {
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.end();
  });

  it('D4: a manager of another team neither sees nor reviews the correction; the team\'s manager and HR do', async () => {
    const c = await request(1);
    const queueB = CorrectionQueueSchema.parse(await (await api('mgrB', '/attendance/corrections')).json());
    assert.ok(!queueB.some((q) => q.id === c.id), 'not in another team\'s queue');
    assert.equal((await api('mgrB', `/attendance/corrections/${c.id}`, { method: 'PATCH', body: { status: 'APPROVED' } })).status, 403);
    for (const who of ['lead', 'mgrA', 'hr'] as const) {
      const q = CorrectionQueueSchema.parse(await (await api(who, '/attendance/corrections')).json());
      assert.ok(q.some((x) => x.id === c.id), `${who} sees it`);
    }
    assert.equal((await api('mgrA', `/attendance/corrections/${c.id}`, { method: 'PATCH', body: { status: 'REJECTED', reviewNote: 'Please attach the client sign-off' } })).status, 200, 'a manager of the same team may decide');
  });

  it('D3: a decided correction cannot be decided again (409) and approval creates exactly one session', async () => {
    const c = await request(2);
    assert.equal((await api('lead', `/attendance/corrections/${c.id}`, { method: 'PATCH', body: { status: 'APPROVED' } })).status, 200);
    assert.equal(await correctionSessions(day(2)), 1);
    const again = await api('hr', `/attendance/corrections/${c.id}`, { method: 'PATCH', body: { status: 'APPROVED' } });
    assert.equal(again.status, 409, await again.text());
    assert.equal((await api('lead', `/attendance/corrections/${c.id}`, { method: 'PATCH', body: { status: 'REJECTED', reviewNote: 'changed my mind' } })).status, 409);
    assert.equal(await correctionSessions(day(2)), 1, 'no second CORRECTION session');
  });

  it('D3: two approvals at the same moment: one wins, the other gets 409', async () => {
    const c = await request(3);
    const [a, b] = await Promise.all([
      api('lead', `/attendance/corrections/${c.id}`, { method: 'PATCH', body: { status: 'APPROVED' } }),
      api('hr', `/attendance/corrections/${c.id}`, { method: 'PATCH', body: { status: 'APPROVED' } }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(await correctionSessions(day(3)), 1);
  });
});
