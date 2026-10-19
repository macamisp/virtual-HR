/**
 * Teams and the manager hierarchy (FR-ORG-006; ADR 031), against the real API and Postgres:
 * only users.manage (HR, admins) changes the structure; names are unique per organisation;
 * a person cannot manage themselves or anyone above them; another tenant's people do not exist;
 * every change is audited; and the hierarchy is the one approvals use.
 */
import 'reflect-metadata';
import { freshCode } from './support/totp.ts';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { OrgPersonSchema, OrgStructureSchema, OrgTeamSchema } from '../../../packages/shared/src/org/structure.ts';
import { LeaveRequestListSchema } from '../../../packages/shared/src/attendance/leave.ts';

const ORG = '0c0c0000-0000-4000-8000-000000000001';
const OTHER = '0c0c0000-0000-4000-8000-000000000002';
const TEAM = '0c0c0000-0000-4000-8000-000000000101';
const PORT = 3111;
const PASSWORD = 'ComplexPassword123!';
const MFA_SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD'; // test-only; HR must have 2FA enrolled (FR-AUTH-004)
const U = {
  hr: { id: '0c0c0000-0000-4000-8000-000000000011', email: 'hr@org.test', role: 'HR', status: 'ACTIVE', org: ORG },
  lead: { id: '0c0c0000-0000-4000-8000-000000000012', email: 'lead@org.test', role: 'TEAM_LEAD', status: 'ACTIVE', org: ORG },
  emp: { id: '0c0c0000-0000-4000-8000-000000000013', email: 'emp@org.test', role: 'EMPLOYEE', status: 'ACTIVE', org: ORG },
  sub: { id: '0c0c0000-0000-4000-8000-000000000014', email: 'sub@org.test', role: 'SUBCONTRACTOR', status: 'ACTIVE', org: ORG },
  gone: { id: '0c0c0000-0000-4000-8000-000000000015', email: 'gone@org.test', role: 'EMPLOYEE', status: 'SUSPENDED', org: ORG },
  stranger: { id: '0c0c0000-0000-4000-8000-000000000021', email: 'stranger@other.test', role: 'MANAGER', status: 'ACTIVE', org: OTHER },
} as const;
type Who = 'hr' | 'lead' | 'emp' | 'sub';

describe('Teams and manager hierarchy (FR-ORG-006)', { concurrency: false }, () => {
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
  const lastAudit = async (action: string) =>
    (await adminPool.query<{ entity_id: string; before: unknown; after: unknown }>(
      `SELECT entity_id, before, after FROM audit_logs WHERE org_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1`, [ORG, action])).rows[0];
  const place = (personId: string, teamId: string | null, managerId: string | null) => api('hr', `/org/people/${personId}/placement`, { method: 'PUT', body: { teamId, managerId } });

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    const pgBase = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev' };
    adminPool = new pg.Pool({ ...pgBase, user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Org Ltd', 'org-e2e', 'Asia/Colombo'), ($2, 'Other', 'org-e2e-other', 'Asia/Colombo')`, [ORG, OTHER]);
    await adminPool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Support')`, [TEAM, ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const [k, u] of Object.entries(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [u.id, u.org, u.email, k, u.role, hash, u.status]);
    }
    await adminPool.query(`UPDATE users SET mfa_enabled = true, mfa_secret = $1 WHERE id = $2`, [MFA_SECRET, U.hr.id]);
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    for (const who of ['hr', 'lead', 'emp', 'sub'] as Who[]) {
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

  it('only users.manage reads or changes the structure', async () => {
    for (const who of ['lead', 'emp', 'sub'] as Who[]) {
      assert.equal((await api(who, '/org/structure')).status, 403, `${who} reads`);
      assert.equal((await api(who, '/org/teams', { method: 'POST', body: { name: 'Mine' } })).status, 403, `${who} creates`);
      assert.equal((await api(who, `/org/teams/${TEAM}`, { method: 'PATCH', body: { name: 'Mine' } })).status, 403, `${who} renames`);
      assert.equal((await api(who, `/org/teams/${TEAM}`, { method: 'DELETE' })).status, 403, `${who} deletes`);
      assert.equal((await api(who, `/org/people/${U[who].id}/placement`, { method: 'PUT', body: { teamId: TEAM, managerId: null } })).status, 403, `${who} places themselves`);
    }
    const s = await ok(await api('hr', '/org/structure'), 200, OrgStructureSchema);
    assert.deepEqual(s.teams.map((t) => t.name), ['Support']);
    assert.ok(s.people.some((p) => p.id === U.gone.id && p.status === 'SUSPENDED'));
    assert.ok(!s.people.some((p) => p.id === U.stranger.id), 'another organisation is invisible');
  });

  it('creates and renames teams; names are unique per organisation, ignoring case; every change is audited', async () => {
    const t = await ok(await api('hr', '/org/teams', { method: 'POST', body: { name: 'Billing', leadId: U.lead.id } }), 201, OrgTeamSchema);
    assert.equal(t.lead?.id, U.lead.id);
    assert.deepEqual((await lastAudit('TEAM_CREATED'))!.after, { name: 'Billing', leadId: U.lead.id });
    assert.equal((await api('hr', '/org/teams', { method: 'POST', body: { name: 'support' } })).status, 409, 'same name, other case');
    assert.equal((await api('hr', '/org/teams', { method: 'POST', body: { name: '  ' } })).status, 400);
    assert.equal((await api('hr', '/org/teams', { method: 'POST', body: { name: 'Night', leadId: U.gone.id } })).status, 400, 'a suspended lead');
    assert.equal((await api('hr', '/org/teams', { method: 'POST', body: { name: 'Night', leadId: U.stranger.id } })).status, 404, 'a lead from another tenant');
    const renamed = await ok(await api('hr', `/org/teams/${t.id}`, { method: 'PATCH', body: { name: 'Billing and Payments', leadId: null } }), 200, OrgTeamSchema);
    assert.equal(renamed.name, 'Billing and Payments');
    assert.equal(renamed.lead, null);
    const audit = await lastAudit('TEAM_UPDATED');
    assert.deepEqual([audit!.before, audit!.after], [{ name: 'Billing', leadId: U.lead.id }, { name: 'Billing and Payments', leadId: null }]);
    assert.equal((await api('hr', `/org/teams/${t.id}`, { method: 'PATCH', body: { name: 'SUPPORT' } })).status, 409);
    assert.equal((await api('hr', `/org/teams/${t.id}`, { method: 'PATCH', body: {} })).status, 400, 'nothing to change');
  });

  it('places people in a team under a manager, refuses loops, and audits the move', async () => {
    const emp = await ok(await place(U.emp.id, TEAM, U.lead.id), 200, OrgPersonSchema);
    assert.deepEqual([emp.teamId, emp.managerId], [TEAM, U.lead.id]);
    const audit = await lastAudit('USER_PLACEMENT_CHANGED');
    assert.equal(audit!.entity_id, U.emp.id);
    assert.deepEqual([audit!.before, audit!.after], [{ teamId: null, managerId: null }, { teamId: TEAM, managerId: U.lead.id }]);
    await ok(await place(U.sub.id, TEAM, U.emp.id), 200, OrgPersonSchema);
    assert.equal((await place(U.lead.id, null, U.lead.id)).status, 400, 'own manager');
    assert.equal((await place(U.lead.id, null, U.emp.id)).status, 400, 'direct loop: emp reports to lead');
    assert.equal((await place(U.lead.id, null, U.sub.id)).status, 400, 'indirect loop: sub reports to emp, who reports to lead');
    assert.equal((await place(U.lead.id, null, U.gone.id)).status, 400, 'a suspended manager');
    assert.equal((await place(U.lead.id, null, U.stranger.id)).status, 404, 'a manager from another tenant');
    assert.equal((await place(U.stranger.id, null, null)).status, 404, 'a person from another tenant');
    assert.equal((await place(U.lead.id, '0c0c0000-0000-4000-8000-000000000999', null)).status, 404, 'an unknown team');
    const s = await ok(await api('hr', '/org/structure'), 200, OrgStructureSchema);
    assert.equal(s.people.find((p) => p.id === U.lead.id)?.managerId, null, 'refused moves changed nothing');
    assert.equal(s.teams.find((t) => t.id === TEAM)?.memberCount, 2);
  });

  it('two opposite placements at the same moment cannot build a loop', async () => {
    await ok(await place(U.lead.id, null, null), 200);
    await ok(await place(U.hr.id, null, null), 200);
    const [a, b] = await Promise.all([place(U.lead.id, null, U.hr.id), place(U.hr.id, null, U.lead.id)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 400], 'the lock serialises them; the second sees the loop');
    const rows = (await adminPool.query<{ id: string; manager_id: string | null }>(`SELECT id, manager_id FROM users WHERE id = ANY($1::uuid[])`, [[U.lead.id, U.hr.id]])).rows;
    assert.equal(rows.filter((r) => r.manager_id !== null).length, 1);
    await ok(await place(U.lead.id, null, null), 200);
    await ok(await place(U.hr.id, null, null), 200);
  });

  it('the hierarchy is the one approvals use: a new manager decides at once', async () => {
    await ok(await place(U.emp.id, TEAM, U.lead.id), 200);
    const day = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    await ok(await api('emp', '/leave/requests', { method: 'POST', body: { type: 'ANNUAL', startDate: day, endDate: day } }), 201);
    const queue = await ok(await api('lead', '/leave/requests?scope=team'), 200, LeaveRequestListSchema);
    assert.equal(queue.items.find((r) => r.user.id === U.emp.id)?.canDecide, true);
  });

  it('only an empty team can be deleted', async () => {
    assert.equal((await api('hr', `/org/teams/${TEAM}`, { method: 'DELETE' })).status, 409, 'Support still has members');
    const empty = await ok(await api('hr', '/org/teams', { method: 'POST', body: { name: 'Temporary' } }), 201, OrgTeamSchema);
    await ok(await api('hr', `/org/teams/${empty.id}`, { method: 'DELETE' }), 200);
    assert.deepEqual((await lastAudit('TEAM_DELETED'))!.before, { name: 'Temporary', leadId: null });
    assert.equal((await api('hr', `/org/teams/${empty.id}`, { method: 'DELETE' })).status, 404);
  });
});
