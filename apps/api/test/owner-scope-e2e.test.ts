/**
 * Owner status alone grants no extra data access (V3 security check; ADR 037):
 * - the database lets only a SUPER_ADMIN be a workspace owner (users_owner_role_check);
 * - the owner flag adds exactly one permission, org.owner (ownership and sign-in settings). Every
 *   other permission comes from the role and the custom role, and the flag never restores one that
 *   was removed;
 * - an owner is an owner of their own organisation only: another organisation's owner (a
 *   SUPER_ADMIN) sees none of this organisation's people over the API.
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
import { resolvePermissions } from '../src/common/permission-resolver.ts';
import { effectivePermissions, Permission } from '../../../packages/shared/src/auth/types.ts';
import { freshCode } from './support/totp.ts';
import { resetOrgs } from './support/reset-orgs.ts';

const ORG = 'f1f80000-0000-4000-8000-000000000001';
const OTHER = 'f1f80000-0000-4000-8000-000000000002';
const PORT = 3120;
const PASSWORD = 'ComplexPassword123!';
const COLLEAGUE = { id: 'f1f80000-0000-4000-8000-000000000012', email: 'colleague@owner-scope.test' };
const OTHER_OWNER = { id: 'f1f80000-0000-4000-8000-000000000021', email: 'owner@owner-scope-other.test', secret: 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSROW' };

describe('Owner status alone grants no extra data access', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  const base = `http://localhost:${PORT}`;
  let token = '';
  const get = (path: string) => fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await resetOrgs(adminPool, [ORG, OTHER]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Owner Scope Ltd', 'owner-scope-e2e'), ($2, 'Owner Scope Other', 'owner-scope-other-e2e')`, [ORG, OTHER]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status) VALUES ($1, $2, $3, 'Colleague', 'EMPLOYEE', $4, 'ACTIVE')`, [COLLEAGUE.id, ORG, COLLEAGUE.email, hash]);
    await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status, is_owner, mfa_enabled, mfa_secret, email_verified_at) VALUES ($1, $2, $3, 'Other Owner', 'SUPER_ADMIN', $4, 'ACTIVE', true, true, $5, now())`, [OTHER_OWNER.id, OTHER, OTHER_OWNER.email, hash, OTHER_OWNER.secret]);
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: OTHER_OWNER.email, password: PASSWORD, totpCode: await freshCode(OTHER_OWNER.secret) }) });
    token = ((await res.json()) as { accessToken: string }).accessToken;
    assert.ok(token, 'the other organisation\'s owner signs in');
  });

  after(async () => {
    await app?.close();
    await resetOrgs(adminPool, [ORG, OTHER]);
    await adminPool.end();
  });

  it('the database lets only a SUPER_ADMIN be an owner', async () => {
    await assert.rejects(adminPool.query(`INSERT INTO users (id, org_id, email, role, is_owner) VALUES ('f1f80000-0000-4000-8000-000000000013', $1, 'x@owner-scope.test', 'EMPLOYEE', true)`, [ORG]), { code: '23514' });
    await assert.rejects(adminPool.query(`UPDATE users SET is_owner = true WHERE id = $1`, [COLLEAGUE.id]), { code: '23514' });
  });

  it('the owner flag adds org.owner and nothing else; it never restores a removed permission', () => {
    const employee = effectivePermissions('EMPLOYEE', [], []).filter((p) => p !== Permission.ORG_OWNER);
    assert.deepEqual(new Set(resolvePermissions({ role: 'EMPLOYEE', added: [], removed: [], is_owner: true })), new Set([...employee, Permission.ORG_OWNER]));
    const trimmed = resolvePermissions({ role: 'SUPER_ADMIN', added: [], removed: [Permission.REPORTS_ALL, Permission.AUDIT_READ, Permission.ATTENDANCE_READ_ALL], is_owner: true });
    for (const p of [Permission.REPORTS_ALL, Permission.AUDIT_READ, Permission.ATTENDANCE_READ_ALL]) assert.ok(!trimmed.includes(p), `${p} stays removed for an owner`);
    assert.ok(trimmed.includes(Permission.ORG_OWNER));
    assert.ok(!resolvePermissions({ role: 'SUPER_ADMIN', added: [Permission.ORG_OWNER], removed: [], is_owner: false }).includes(Permission.ORG_OWNER), 'org.owner never comes from a role');
  });

  it('another organisation\'s owner sees none of this organisation\'s people', async () => {
    const R = '?from=2026-10-05&to=2026-10-11';
    assert.equal((await get(`/reports/attendance-analytics/people/${COLLEAGUE.id}${R}`)).status, 404);
    assert.ok([403, 404].includes((await get(`/privacy/subjects/${COLLEAGUE.id}/export`)).status));
    const people = await (await get('/admin/users')).text();
    assert.ok(!people.includes(COLLEAGUE.email), 'the user list is their own organisation only');
    const report = await (await get(`/reports/attendance-analytics${R}`)).text();
    assert.ok(!report.includes(COLLEAGUE.id), 'the analytics are their own organisation only');
  });
});
