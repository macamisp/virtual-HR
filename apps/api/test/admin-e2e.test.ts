/**
 * Administration end to end (ADR 011): FR-ADM-001 policy, FR-ADM-002 custom roles resolved
 * server-side, FR-ADM-004 retention, FR-ADM-006 audit viewer and chain verification,
 * FR-AUD-004 consent records. Real Postgres with RLS; permissions and tenancy for every route.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { generateSync } from 'otplib';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { AttendanceService } from '../src/attendance/attendance.service.ts';
import { ScheduledWorkService } from '../src/notifications/scheduled-work.service.ts';
import { Permission } from '../../../packages/shared/src/auth/types.ts';
import { CONSENT_NOTICES } from '../../../packages/shared/src/admin/types.ts';
import type { AdminUserRow, AuditRow, AuditVerification, ConsentOverview, CustomRole, MyAccess, OrgPolicy, RetentionOverview, RolesOverview } from '../../../packages/shared/src/admin/types.ts';

const ORG = 'adad0000-0000-4000-8000-000000000001';
const OTHER = 'adad0000-0000-4000-8000-000000000002';
const PASSWORD = 'ComplexPassword123!';
const SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const U = {
  admin: { id: 'adad0000-0000-4000-8000-000000000011', org: ORG, email: 'admin@adm.test', name: 'Ann Admin', role: 'ADMIN', mfa: true },
  hr: { id: 'adad0000-0000-4000-8000-000000000012', org: ORG, email: 'hr@adm.test', name: 'Hal HR', role: 'HR', mfa: true },
  lead: { id: 'adad0000-0000-4000-8000-000000000013', org: ORG, email: 'lead@adm.test', name: 'Lena Lead', role: 'TEAM_LEAD', mfa: false },
  emp: { id: 'adad0000-0000-4000-8000-000000000014', org: ORG, email: 'emp@adm.test', name: 'Eva Emp', role: 'EMPLOYEE', mfa: false },
  aud: { id: 'adad0000-0000-4000-8000-000000000015', org: ORG, email: 'aud@adm.test', name: 'Ada Aud', role: 'AUDITOR', mfa: false },
  temp: { id: 'adad0000-0000-4000-8000-000000000016', org: ORG, email: 'temp@adm.test', name: 'Tim Temp', role: 'EMPLOYEE', mfa: false },
  other: { id: 'adad0000-0000-4000-8000-000000000021', org: OTHER, email: 'admin@other.test', name: 'Otto Other', role: 'ADMIN', mfa: true },
} as const;
type Who = keyof typeof U;

const POLICY: OrgPolicy = {
  missedHeartbeatTimeoutSeconds: 60,
  disconnectGraceWindowSeconds: 60,
  idleThresholdSeconds: 180,
  pauseThresholdSeconds: 600,
  maxSessionLengthSeconds: 10 * 3600,
  paidBreakMinutesPerDay: 45,
  manualLimitMinutes: 90,
  variancePct: 10,
  vaultReauthMinutes: 5,
};

describe('Administration (FR-ADM-001, 002, 004, 006; FR-AUD-004)', { concurrency: false }, () => {
  let app: INestApplication;
  let base: string;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  const tokens = {} as Record<Who, string>;

  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  async function ok<T>(res: Response, status: number): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return JSON.parse(text || 'null') as T;
  }
  const auditCount = async (action: string) =>
    (await adminPool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = $2`, [ORG, action])).rows[0].n as number;

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    const conn = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev' };
    adminPool = new pg.Pool({ ...conn, user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    appPool = new pg.Pool({ ...conn, user: process.env.PGUSER || 'hrvo_app', password: process.env.PGPASSWORD || 'hrvo_app_pass' });
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    // Regression: ids crossing a digit boundary (99 -> 100) once broke chain verification (text ordering).
    await adminPool.query(`SELECT setval('audit_logs_id_seq', GREATEST((SELECT last_value FROM audit_logs_id_seq), 95))`);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Admin Ltd', 'adm-e2e'), ($2, 'Other Ltd', 'adm-other-e2e')`, [ORG, OTHER]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(U)) {
      await adminPool.query(
        `INSERT INTO users (id, org_id, email, display_name, role, password_hash, status, mfa_enabled, mfa_secret)
         VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8)`,
        [u.id, u.org, u.email, u.name, u.role, hash, u.mfa, u.mfa ? SECRET : null],
      );
    }
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(3099);
    base = 'http://localhost:3099';
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: U[who].email, password: PASSWORD, ...(U[who].mfa ? { totpCode: generateSync({ secret: SECRET }) } : {}) }),
      });
      const body = (await res.json()) as { accessToken: string };
      assert.ok(body.accessToken, `login ${who}`);
      tokens[who] = body.accessToken;
    }
  });

  after(async () => {
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.end();
    await appPool.end();
  });

  describe('Policy settings (FR-ADM-001)', { concurrency: false }, () => {
    it('admins read the defaults; other roles get 403', async () => {
      const p = await ok<OrgPolicy>(await api('admin', '/admin/policy'), 200);
      assert.equal(p.idleThresholdSeconds, 300);
      assert.equal(p.pauseThresholdSeconds, 900);
      assert.equal(p.maxSessionLengthSeconds, 14 * 3600);
      assert.equal(p.manualLimitMinutes, 120);
      for (const who of ['emp', 'lead', 'aud'] as Who[]) assert.equal((await api(who, '/admin/policy')).status, 403, who);
      assert.equal((await api('emp', '/admin/policy', { method: 'PUT', body: POLICY })).status, 403);
    });

    it('values outside SRS 6.4, a pause not above idle, or unknown fields are refused', async () => {
      for (const bad of [
        { ...POLICY, idleThresholdSeconds: 60 },
        { ...POLICY, maxSessionLengthSeconds: 20 * 3600 },
        { ...POLICY, pauseThresholdSeconds: 300, idleThresholdSeconds: 600 },
        { ...POLICY, variancePct: 80 },
        { ...POLICY, heartbeatIntervalSeconds: 5 },
      ]) assert.equal((await api('admin', '/admin/policy', { method: 'PUT', body: bad })).status, 400, JSON.stringify(bad));
    });

    it('a change is saved, audited with before and after, and the database also enforces the ranges', async () => {
      const saved = await ok<OrgPolicy>(await api('admin', '/admin/policy', { method: 'PUT', body: POLICY }), 200);
      assert.deepEqual(saved, POLICY);
      const audit = await adminPool.query(`SELECT before, after FROM audit_logs WHERE org_id = $1 AND action = 'ORG_POLICY_UPDATED'`, [ORG]);
      assert.equal(audit.rows.length, 1);
      assert.equal(audit.rows[0].before.idleThresholdSeconds, 300);
      assert.equal(audit.rows[0].after.idleThresholdSeconds, 180);
      // Timesheet settings read the same columns.
      const ts = await ok<{ manualLimitMinutes: number; variancePct: number }>(await api('admin', '/timesheets/settings'), 200);
      assert.equal(ts.manualLimitMinutes, 90);
      assert.equal(ts.variancePct, 10);
      await assert.rejects(adminPool.query(`UPDATE organizations SET att_idle_seconds = 30 WHERE id = $1`, [ORG]), /check/i);
    });

    it('the attendance engine uses the new policy at once (cache invalidated)', async () => {
      const service = app.get(AttendanceService);
      await service.recordMonitoringConsent({ orgId: ORG, userId: U.emp.id, noticeVersion: 'v1.0.0' });
      // getTransparencyEvents reads through the same per-org policy cache.
      await ok(await api('admin', '/admin/retention', { method: 'PUT', body: { presenceDays: 45, notificationsDays: 365 } }), 200);
      const info = await ok<{ retentionDays: number; plainLanguageNotice: string }>(await api('emp', '/attendance/me/events'), 200);
      assert.equal(info.retentionDays, 45);
      assert.match(info.plainLanguageNotice, /45 days/);
    });
  });

  describe('Retention settings (FR-ADM-004)', { concurrency: false }, () => {
    it('shows each data type, refuses out-of-range values and audits changes', async () => {
      const r = await ok<RetentionOverview>(await api('admin', '/admin/retention'), 200);
      assert.equal(r.presenceDays, 45);
      assert.deepEqual(r.notAvailable, ['Chat messages'], 'recordings have their own retention now (ADR 024); chat is not yet available');
      assert.equal(r.recordingsDays, 90);
      assert.equal((await api('admin', '/admin/retention', { method: 'PUT', body: { presenceDays: 5, notificationsDays: 365 } })).status, 400);
      assert.equal((await api('hr', '/admin/retention')).status, 200, 'HR holds org.manage');
      assert.equal((await api('lead', '/admin/retention')).status, 403);
      assert.equal(await auditCount('RETENTION_SETTINGS_UPDATED'), 1);
    });

    it('the daily job prunes presence events and notifications by the org settings', async () => {
      const now = new Date();
      const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
      await adminPool.query(
        `INSERT INTO presence_events (org_id, user_id, server_ts, event_type, state) VALUES ($1, $2, $3, 'HEARTBEAT', 'ACTIVE'), ($1, $2, $4, 'HEARTBEAT', 'ACTIVE')`,
        [ORG, U.emp.id, days(50), days(40)],
      );
      await adminPool.query(
        `INSERT INTO notifications (org_id, user_id, type, title, created_at) VALUES ($1, $2, 'TASK_ASSIGNED', 'old', $3), ($1, $2, 'TASK_ASSIGNED', 'recent', $4)`,
        [ORG, U.emp.id, days(400), days(300)],
      );
      await app.get(ScheduledWorkService).presenceRetention(now);
      const ev = await adminPool.query(`SELECT server_ts FROM presence_events WHERE org_id = $1 AND user_id = $2 AND server_ts < now() - interval '30 days'`, [ORG, U.emp.id]);
      assert.equal(ev.rows.length, 1, 'only the 40-day-old event is left (retention 45)');
      const n = await adminPool.query(`SELECT title FROM notifications WHERE org_id = $1 AND user_id = $2`, [ORG, U.emp.id]);
      assert.deepEqual(n.rows.map((r) => r.title), ['recent']);
      // The app role still cannot delete notifications.
      const c = await appPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
        await assert.rejects(c.query(`DELETE FROM notifications`), /permission denied/);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });
  });

  describe('Custom roles (FR-ADM-002)', { concurrency: false }, () => {
    let clerk: CustomRole;

    it('only roles.manage opens the roles screen', async () => {
      const r = await ok<RolesOverview>(await api('admin', '/admin/roles'), 200);
      assert.ok(r.builtIn.length >= 10);
      assert.deepEqual(r.custom, []);
      for (const who of ['hr', 'lead', 'emp', 'aud'] as Who[]) assert.equal((await api(who, '/admin/roles')).status, 403, who);
      assert.equal((await api('hr', '/admin/users')).status, 403);
    });

    it('creates a role from a base plus additions and removals (audited)', async () => {
      clerk = await ok<CustomRole>(await api('admin', '/admin/roles', {
        method: 'POST',
        body: { name: 'Payroll clerk', description: 'Reads timesheets', baseRole: 'EMPLOYEE', addedPermissions: [Permission.TIMESHEETS_READ_ALL], removedPermissions: [Permission.DOCUMENTS_USE] },
      }), 201);
      assert.ok(clerk.permissions.includes(Permission.TIMESHEETS_READ_ALL));
      assert.ok(!clerk.permissions.includes(Permission.DOCUMENTS_USE));
      assert.equal(clerk.version, 1);
      assert.equal(await auditCount('ROLE_CREATED'), 1);
      assert.equal((await api('admin', '/admin/roles', { method: 'POST', body: { name: 'Payroll clerk', baseRole: 'EMPLOYEE' } })).status, 409, 'unique name');
    });

    it('refuses escalation: SUPER_ADMIN base, 2FA-grade permissions on a non-2FA base, permissions the admin lacks', async () => {
      assert.equal((await api('admin', '/admin/roles', { method: 'POST', body: { name: 'Root', baseRole: 'SUPER_ADMIN' } })).status, 400);
      const sneaky = await api('admin', '/admin/roles', { method: 'POST', body: { name: 'Sneaky', baseRole: 'EMPLOYEE', addedPermissions: [Permission.ROLES_MANAGE] } });
      assert.equal(sneaky.status, 403);
      assert.match(await sneaky.text(), /two-factor/i);
      const beyond = await api('admin', '/admin/roles', { method: 'POST', body: { name: 'Recoverer', baseRole: 'HR', addedPermissions: [Permission.VAULT_RECOVER] } });
      assert.equal(beyond.status, 403, 'admins do not hold vault.recover');
    });

    it('assignment takes effect on the next request, with the same token', async () => {
      assert.equal((await api('emp', '/timesheets/reports?format=json&groupBy=user&from=2026-10-01&to=2026-10-07')).status, 403);
      assert.equal((await api('emp', '/documents')).status, 200);
      const row = await ok<AdminUserRow>(await api('admin', `/admin/users/${U.emp.id}/role`, { method: 'PUT', body: { role: 'EMPLOYEE', customRoleId: clerk.id } }), 200);
      assert.equal(row.customRoleName, 'Payroll clerk');
      assert.equal((await api('emp', '/timesheets/reports?format=json&groupBy=user&from=2026-10-01&to=2026-10-07')).status, 200);
      assert.equal((await api('emp', '/documents')).status, 403, 'removed permission');
      const me = await ok<MyAccess>(await api('emp', '/me/access'), 200);
      assert.equal(me.customRoleName, 'Payroll clerk');
      assert.ok(me.permissions.includes(Permission.TIMESHEETS_READ_ALL));
      assert.equal(await auditCount('USER_ROLE_CHANGED'), 1);
    });

    it('editing the role applies at once; a stale version is refused', async () => {
      const edited = await ok<CustomRole>(await api('admin', `/admin/roles/${clerk.id}`, {
        method: 'PUT', body: { name: 'Payroll clerk', baseRole: 'EMPLOYEE', addedPermissions: [Permission.TIMESHEETS_READ_ALL], removedPermissions: [], version: 1 },
      }), 200);
      assert.equal(edited.version, 2);
      assert.equal((await api('emp', '/documents')).status, 200);
      const stale = await api('admin', `/admin/roles/${clerk.id}`, { method: 'PUT', body: { name: 'X role', baseRole: 'EMPLOYEE', version: 1 } });
      assert.equal(stale.status, 409);
      assert.equal((await api('admin', `/admin/roles/${clerk.id}`, { method: 'DELETE' })).status, 409, 'still assigned');
    });

    it('admins cannot change their own role or hand out SUPER_ADMIN', async () => {
      assert.equal((await api('admin', `/admin/users/${U.admin.id}/role`, { method: 'PUT', body: { role: 'EMPLOYEE' } })).status, 403);
      assert.equal((await api('admin', `/admin/users/${U.lead.id}/role`, { method: 'PUT', body: { role: 'SUPER_ADMIN' } })).status, 403);
    });

    it('a role that needs 2FA revokes sessions of a user without it; their old token stops working', async () => {
      assert.equal((await api('temp', '/me/access')).status, 200);
      await ok(await api('admin', `/admin/users/${U.temp.id}/role`, { method: 'PUT', body: { role: 'HR' } }), 200);
      assert.equal((await api('temp', '/me/access')).status, 401);
      assert.equal((await api('temp', '/admin/retention')).status, 401, 'no HR access without 2FA');
      const sessions = await adminPool.query(`SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1 AND NOT is_revoked`, [U.temp.id]);
      assert.equal(sessions.rows[0].n, 0);
      const login = await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U.temp.email, password: PASSWORD }) })).json() as { requires2faSetup?: boolean };
      assert.equal(login.requires2faSetup, true);
    });

    it('roles and assignments are per organisation (RLS)', async () => {
      const theirs = await ok<RolesOverview>(await api('other', '/admin/roles'), 200);
      assert.deepEqual(theirs.custom, []);
      assert.equal((await api('other', `/admin/roles/${clerk.id}`, { method: 'PUT', body: { name: 'Stolen', baseRole: 'EMPLOYEE' } })).status, 404);
      assert.equal((await api('other', `/admin/roles/${clerk.id}`, { method: 'DELETE' })).status, 404);
      assert.equal((await api('other', `/admin/users/${U.emp.id}/role`, { method: 'PUT', body: { role: 'EMPLOYEE' } })).status, 404);
      assert.equal((await api('other', `/admin/users/${U.other.id}/role`, { method: 'PUT', body: { role: 'EMPLOYEE', customRoleId: clerk.id } })).status, 403, 'own role');
      const users = await ok<AdminUserRow[]>(await api('other', '/admin/users'), 200);
      assert.deepEqual(users.map((u) => u.id), [U.other.id]);
      const c = await appPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [OTHER]);
        assert.equal((await c.query(`SELECT * FROM org_roles`)).rows.length, 0);
        await assert.rejects(c.query(`INSERT INTO org_roles (org_id, name, base_role) VALUES ($1, 'Planted', 'EMPLOYEE')`, [ORG]), /row-level security/);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
      // The database refuses linking a user to another organisation's role.
      await assert.rejects(adminPool.query(`UPDATE users SET custom_role_id = $1 WHERE id = $2`, [clerk.id, U.other.id]), /another organisation/);
    });

    it('after reassignment the role can be deleted (audited)', async () => {
      await ok(await api('admin', `/admin/users/${U.emp.id}/role`, { method: 'PUT', body: { role: 'EMPLOYEE', customRoleId: null } }), 200);
      assert.equal((await api('emp', '/timesheets/reports?format=json&groupBy=user&from=2026-10-01&to=2026-10-07')).status, 403);
      assert.equal((await api('admin', `/admin/roles/${clerk.id}`, { method: 'DELETE' })).status, 204);
      assert.equal(await auditCount('ROLE_DELETED'), 1);
    });
  });

  describe('Consent records (FR-AUD-004)', { concurrency: false }, () => {
    it('lists monitoring, recording, AI and desktop-agent consents with the current notice versions', async () => {
      const list = await ok<ConsentOverview[]>(await api('emp', '/me/consents'), 200);
      assert.deepEqual(list.map((c) => c.type), ['MONITORING', 'RECORDING', 'AI', 'DESKTOP_AGENT']);
      assert.equal(list[0]!.granted, true, 'accepted earlier through the attendance notice');
      assert.equal(list[1]!.granted, null);
    });

    it('records giving and withdrawing with version and server time; history is kept', async () => {
      const v = CONSENT_NOTICES.RECORDING.version;
      await ok(await api('emp', '/me/consents', { method: 'POST', body: { type: 'RECORDING', granted: true, noticeVersion: v } }), 201);
      const after = await ok<ConsentOverview[]>(await api('emp', '/me/consents', { method: 'POST', body: { type: 'RECORDING', granted: false, noticeVersion: v } }), 201);
      const rec = after.find((c) => c.type === 'RECORDING')!;
      assert.equal(rec.granted, false);
      assert.equal(rec.history.length, 2);
      assert.ok(Math.abs(Date.parse(rec.history[0]!.at) - Date.now()) < 60_000);
      assert.equal(await auditCount('CONSENT_GIVEN'), 1);
      assert.equal(await auditCount('CONSENT_WITHDRAWN'), 1);
      assert.equal((await api('emp', '/me/consents', { method: 'POST', body: { type: 'AI', granted: true, noticeVersion: 'v0.9' } })).status, 409, 'old notice');
      assert.equal((await api('emp', '/me/consents', { method: 'POST', body: { type: 'MONITORING', granted: false, noticeVersion: 'v1.0.0' } })).status, 400, 'monitoring goes through the attendance notice');
    });

    it('records are append-only; other consent types never count as the monitoring notice', async () => {
      const c = await appPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
        await assert.rejects(c.query(`UPDATE monitoring_consents SET granted = true`), /permission denied/);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
      await adminPool.query(`INSERT INTO monitoring_consents (org_id, user_id, notice_version, consent_type, accepted_at) VALUES ($1, $2, 'v1.0.0', 'AI', now())`, [ORG, U.lead.id]);
      assert.equal(await app.get(AttendanceService).hasUserAcceptedNotice(ORG, U.lead.id, 'v1.0.0'), false);
    });

    it('HR and auditors see a person\'s consent history; team leads do not; no cross-org', async () => {
      const hist = await ok<ConsentOverview[]>(await api('hr', `/admin/users/${U.emp.id}/consents`), 200);
      assert.equal(hist.find((c) => c.type === 'RECORDING')!.history.length, 2);
      assert.equal((await api('aud', `/admin/users/${U.emp.id}/consents`)).status, 200);
      assert.equal((await api('lead', `/admin/users/${U.emp.id}/consents`)).status, 403);
      assert.equal((await api('other', `/admin/users/${U.emp.id}/consents`)).status, 404);
    });
  });

  describe('Audit log viewer (FR-ADM-006, FR-AUD-001)', { concurrency: false }, () => {
    it('filters by action, actor, entity and time; only this organisation', async () => {
      const roles = await ok<AuditRow[]>(await api('aud', '/audit-logs?action=ROLE_CREATED'), 200);
      assert.equal(roles.length, 1);
      assert.equal(roles[0]!.actor_name, U.admin.name);
      const byActor = await ok<AuditRow[]>(await api('aud', `/audit-logs?actorId=${U.emp.id}&limit=500`), 200);
      assert.ok(byActor.length > 0 && byActor.every((r) => r.actor_id === U.emp.id));
      const byEntity = await ok<AuditRow[]>(await api('aud', `/audit-logs?entityType=USER&entityId=${U.emp.id}`), 200);
      assert.ok(byEntity.some((r) => r.action === 'USER_ROLE_CHANGED'));
      const future = await ok<AuditRow[]>(await api('aud', `/audit-logs?from=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`), 200);
      assert.equal(future.length, 0);
      const theirs = await ok<AuditRow[]>(await api('other', '/audit-logs?limit=500'), 200);
      assert.ok(theirs.every((r) => r.org_id === OTHER));
      assert.equal((await api('aud', '/audit-logs?actorId=not-a-uuid')).status, 400);
      assert.equal((await api('emp', '/audit-logs')).status, 403);
      const facets = await ok<{ actions: string[] }>(await api('aud', '/audit-logs/facets'), 200);
      assert.ok(facets.actions.includes('ORG_POLICY_UPDATED'));
    });

    it('exports CSV of the filtered log, and the export is audited', async () => {
      const res = await api('aud', '/audit-logs/export?action=ROLE_CREATED');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
      assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="audit-log-/);
      const lines = (await res.text()).trim().split('\r\n');
      assert.match(lines[0]!, /id,time_utc,actor_id,actor,action/);
      assert.equal(lines.length, 2);
      assert.equal(await auditCount('AUDIT_LOG_EXPORTED'), 1);
    });

    it('verifies the chain and points at the first tampered entry', async () => {
      const good = await ok<AuditVerification>(await api('aud', '/audit-logs/verify'), 200);
      assert.equal(good.valid, true);
      assert.ok(good.checked > 5);
      const target = await adminPool.query(`SELECT id::text FROM audit_logs WHERE org_id = $1 AND action = 'ROLE_CREATED'`, [ORG]);
      await adminPool.query(`UPDATE audit_logs SET after = '{"name":"Forged"}' WHERE id = $1::bigint`, [target.rows[0].id]);
      const bad = await ok<AuditVerification>(await api('aud', '/audit-logs/verify'), 200);
      assert.equal(bad.valid, false);
      assert.equal(bad.brokenAtId, target.rows[0].id);
      const other = await ok<AuditVerification>(await api('other', '/audit-logs/verify'), 200);
      assert.equal(other.valid, true, 'another organisation\'s chain is separate');
    });
  });
});
