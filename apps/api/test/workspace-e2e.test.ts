/**
 * Self-service workspaces, owners, invitations and configurable roles (ADR 037):
 * FR-AUTH-001 (invitations), FR-AUTH-006 (RBAC, custom roles, delegation), FR-AUTH-009 (sessions
 * end at once), FR-ORG-001 (profile, time zone, work week), FR-ORG-009 (offboarding).
 * Google sign-in (FR-AUTH-005) is in google-signin-e2e.test.ts.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import pg from 'pg';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { MAIL_TRANSPORT } from '../src/common/mailer.ts';
import type { InMemoryMailTransport } from '../src/common/mailer.ts';
import { freshCode } from './support/totp.ts';
import { Permission } from '../../../packages/shared/src/auth/types.ts';
import type { AdminUserRow, MyAccess, CustomRole } from '../../../packages/shared/src/admin/types.ts';
import type { EffectiveAccess, InvitationRow, OrgProfile, OwnershipTransfer, SignupResponse, VerifyEmailResponse } from '../../../packages/shared/src/auth/workspace.ts';

const PORT = 3083;
const PASSWORD = 'WorkspaceOwnerPass!2026';
const OTHER = 'cafe0000-0000-4000-8000-000000000002';
const OTHER_ADMIN = { id: 'cafe0000-0000-4000-8000-000000000021', email: 'admin@other-ws.test', secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' };
const SLUGS = ['acme-signup', 'acme-signup-2', 'beta-signup', 'other-ws'];

interface Session { accessToken: string; user: { id: string; orgId: string; role: string } }

describe('Self-service workspaces, owners and roles (FR-AUTH-001/006/009, FR-ORG-001/009; ADR 037)', { concurrency: false }, () => {
  let app: INestApplication;
  let base: string;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  let outbox: InMemoryMailTransport;

  const req = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json', ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  async function ok<T>(res: Response, status: number): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return JSON.parse(text || 'null') as T;
  }
  const lastMailTo = (email: string) => [...outbox.outbox].reverse().find((m) => m.to === email);
  const tokenIn = (text: string | undefined) => /#token=([0-9a-f]{64})/.exec(text ?? '')?.[1];
  const auditCount = async (org: string, action: string) =>
    (await adminPool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = $2`, [org, action])).rows[0].n as number;

  /** Owners and admins must enrol TOTP on first sign-in; returns the secret and the session. */
  async function enrol(enrollmentToken: string): Promise<{ secret: string; session: Session }> {
    const setup = await ok<{ secret: string }>(await req('/auth/2fa/setup', { body: {}, token: enrollmentToken }), 200);
    const verified = await ok<Session & { success: true }>(await req('/auth/2fa/verify', { body: { code: await freshCode(setup.secret) }, token: enrollmentToken }), 200);
    return { secret: setup.secret, session: verified };
  }
  async function login(email: string, extra: Record<string, unknown> = {}): Promise<Response> {
    return req('/auth/login', { body: { email, password: PASSWORD, ...extra } });
  }

  // The first workspace and its owner, created by the signup tests and reused afterwards.
  let acme: { orgId: string; ownerId: string; ownerSecret: string; ownerToken: string };
  let member: { id: string; token: string; email: string };

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.RATE_LIMIT_SIGNUP = '1000';
    // ADR 039: this suite resends at once; the per-address cooldown has its own test (account-emails-e2e).
    process.env.VERIFICATION_RESEND_COOLDOWN_SECONDS = '0';
    process.env.JOBS_ENABLED = 'false';
    process.env.AUTH_MFA_ENFORCEMENT = '';
    process.env.SIGNUP_BLOCK_DISPOSABLE_EMAILS = 'true';
    process.env.APP_WEB_URL = 'http://localhost:3000';
    const conn = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev' };
    adminPool = new pg.Pool({ ...conn, user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    appPool = new pg.Pool({ ...conn, user: process.env.PGUSER || 'hrvo_app', password: process.env.PGPASSWORD || 'hrvo_app_pass' });
    await adminPool.query(`DELETE FROM organizations WHERE id = $1 OR slug = ANY($2::text[])`, [OTHER, SLUGS]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Other Ltd', 'other-ws')`, [OTHER]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    await adminPool.query(
      `INSERT INTO users (id, org_id, email, display_name, role, password_hash, status, mfa_enabled, mfa_secret, email_verified_at)
       VALUES ($1, $2, $3, 'Olga Other', 'ADMIN', $4, 'ACTIVE', true, $5, now())`,
      [OTHER_ADMIN.id, OTHER, OTHER_ADMIN.email, hash, OTHER_ADMIN.secret],
    );
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    base = `http://localhost:${PORT}`;
    outbox = app.get<InMemoryMailTransport>(MAIL_TRANSPORT, { strict: false });
  });

  after(async () => {
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = $1 OR slug = ANY($2::text[])`, [OTHER, SLUGS]);
    await adminPool.end();
    await appPool.end();
  });

  describe('1. Workspace signup creates an isolated tenant with an owner', () => {
    it('creates the organisation, its owner (SUPER_ADMIN, is_owner) and sends a verification link', async () => {
      const res = await ok<SignupResponse>(await req('/auth/signup', { body: { workspaceName: 'Acme Signup', email: 'owner@signup.test', password: PASSWORD, displayName: 'Oona Owner' } }), 201);
      assert.equal(res.workspace.slug, 'acme-signup');
      const org = (await adminPool.query(`SELECT id, timezone, work_week, onboarded_at FROM organizations WHERE slug = 'acme-signup'`)).rows[0];
      assert.ok(org, 'organisation row');
      assert.equal(org.onboarded_at, null, 'onboarding not done yet');
      assert.deepEqual(org.work_week, [1, 2, 3, 4, 5]);
      const owner = (await adminPool.query(`SELECT id, role, is_owner, status, email_verified_at FROM users WHERE org_id = $1`, [org.id])).rows[0];
      assert.equal(owner.role, 'SUPER_ADMIN');
      assert.equal(owner.is_owner, true);
      assert.equal(owner.status, 'ACTIVE');
      assert.equal(owner.email_verified_at, null);
      assert.equal(await auditCount(org.id, 'WORKSPACE_CREATED'), 1);
      const mail = lastMailTo('owner@signup.test');
      assert.ok(mail && /verify-email#token=/.test(mail.text), 'verification e-mail with a fragment token');
      acme = { orgId: org.id, ownerId: owner.id, ownerSecret: '', ownerToken: '' };
    });

    it('refuses sign-in until the address is verified, then needs 2FA enrolment (owner)', async () => {
      const refused = await login('owner@signup.test');
      assert.equal(refused.status, 403);
      assert.match(await refused.text(), /EMAIL_NOT_VERIFIED/);
      // Resend: a new link; the old one no longer works.
      const first = tokenIn(lastMailTo('owner@signup.test')?.text)!;
      await ok(await req('/auth/email/resend', { body: { email: 'owner@signup.test' } }), 202);
      const second = tokenIn(lastMailTo('owner@signup.test')?.text)!;
      assert.notEqual(first, second);
      assert.equal((await req('/auth/email/verify', { body: { token: first } })).status, 400, 'superseded link');
      const verified = await ok<VerifyEmailResponse>(await req('/auth/email/verify', { body: { token: second } }), 200);
      assert.deepEqual(verified, { success: true, email: 'owner@signup.test', alreadyVerified: false });
      // ADR 039: opening the link again (a second click, a mail scanner) says so instead of failing.
      const again = await ok<VerifyEmailResponse>(await req('/auth/email/verify', { body: { token: second } }), 200);
      assert.equal(again.alreadyVerified, true, 'single use: a second open verifies nothing new');
      assert.equal(await auditCount(acme.orgId, 'EMAIL_VERIFIED'), 1);

      const needsSetup = await ok<{ requires2faSetup: true; enrollmentToken: string }>(await login('owner@signup.test'), 200);
      assert.equal(needsSetup.requires2faSetup, true, 'owners must set up 2FA');
      const { secret, session } = await enrol(needsSetup.enrollmentToken);
      acme.ownerSecret = secret;
      acme.ownerToken = session.accessToken;
      const me = await ok<MyAccess>(await req('/me/access', { token: acme.ownerToken }), 200);
      assert.equal(me.isOwner, true);
      assert.ok(me.permissions.includes(Permission.ORG_OWNER), 'owners hold org.owner');
      assert.ok(me.permissions.includes(Permission.ROLES_MANAGE));
    });

    it('a second workspace with the same name gets a different slug; disposable addresses are refused', async () => {
      const res = await ok<SignupResponse>(await req('/auth/signup', { body: { workspaceName: 'Acme Signup', email: 'other-owner@signup.test', password: PASSWORD, displayName: 'Two' } }), 201);
      assert.equal(res.workspace.slug, 'acme-signup-2');
      const bad = await req('/auth/signup', { body: { workspaceName: 'Throwaway', email: 'x@mailinator.com', password: PASSWORD, displayName: 'Temp' } });
      assert.equal(bad.status, 400);
      assert.match(await bad.text(), /disposable/i);
      assert.equal((await req('/auth/signup', { body: { workspaceName: 'Weak', email: 'w@signup.test', password: 'password123456', displayName: 'Weak' } })).status, 400, 'breached password');
    });

    it('the owner finishes onboarding: name, time zone, work week', async () => {
      const before = await ok<OrgProfile>(await req('/org/profile', { token: acme.ownerToken }), 200);
      assert.equal(before.onboardedAt, null);
      assert.equal(before.ownerCount, 1);
      const after = await ok<OrgProfile>(await req('/org/profile', { method: 'PUT', token: acme.ownerToken, body: { name: 'Acme Signup Ltd', timezone: 'Europe/Berlin', workWeek: [1, 2, 3, 4], onboarded: true } }), 200);
      assert.equal(after.name, 'Acme Signup Ltd');
      assert.equal(after.timezone, 'Europe/Berlin');
      assert.deepEqual(after.workWeek, [1, 2, 3, 4]);
      assert.ok(after.onboardedAt);
      assert.equal((await req('/org/profile', { method: 'PUT', token: acme.ownerToken, body: { timezone: 'Mars/Olympus' } })).status, 400);
      assert.equal(await auditCount(acme.orgId, 'ORG_PROFILE_UPDATED'), 1);
    });
  });

  describe('2. Invitations (FR-AUTH-001): invite, resend, revoke, accept', () => {
    let invitation: InvitationRow;
    it('an invitation is e-mailed, listed as pending, and resending issues a fresh link', async () => {
      const created = await ok<{ id: string }>(await req('/auth/invitations/invite', { token: acme.ownerToken, body: { email: 'member@signup.test', role: 'EMPLOYEE' } }), 201);
      const first = tokenIn(lastMailTo('member@signup.test')?.text);
      assert.ok(first, 'invitation e-mail carries the accept link');
      const list = await ok<InvitationRow[]>(await req('/auth/invitations', { token: acme.ownerToken }), 200);
      invitation = list.find((i) => i.id === created.id)!;
      assert.equal(invitation.status, 'PENDING');
      assert.equal(invitation.invitedBy.id, acme.ownerId);
      const resent = await ok<InvitationRow>(await req(`/auth/invitations/${created.id}/resend`, { token: acme.ownerToken, body: {} }), 200);
      assert.ok(new Date(resent.lastSentAt) >= new Date(invitation.lastSentAt));
      const second = tokenIn(lastMailTo('member@signup.test')?.text);
      assert.ok(second && second !== first, 'a new token');
      assert.equal((await req('/auth/invitations/accept', { body: { inviteToken: first, password: PASSWORD, displayName: 'Old link' } })).status, 400, 'the old link is dead');
      assert.equal(await auditCount(acme.orgId, 'INVITATION_RESENT'), 1);
    });

    it('a revoked invitation cannot be accepted; a new one can, and the address counts as verified', async () => {
      const revoked = await ok<InvitationRow>(await req(`/auth/invitations/${invitation.id}/revoke`, { token: acme.ownerToken, body: {} }), 200);
      assert.equal(revoked.status, 'REVOKED');
      const token = tokenIn(lastMailTo('member@signup.test')?.text)!;
      assert.equal((await req('/auth/invitations/accept', { body: { inviteToken: token, password: PASSWORD, displayName: 'Mia Member' } })).status, 400);
      await ok(await req('/auth/invitations/invite', { token: acme.ownerToken, body: { email: 'member@signup.test', role: 'EMPLOYEE' } }), 201);
      const fresh = tokenIn(lastMailTo('member@signup.test')?.text)!;
      await ok(await req('/auth/invitations/accept', { body: { inviteToken: fresh, password: PASSWORD, displayName: 'Mia Member' } }), 201);
      const session = await ok<Session>(await login('member@signup.test'), 200);
      member = { id: session.user.id, token: session.accessToken, email: 'member@signup.test' };
      const row = (await adminPool.query(`SELECT email_verified_at FROM users WHERE id = $1`, [member.id])).rows[0];
      assert.ok(row.email_verified_at, 'accepting an invitation verifies the address');
      assert.equal((await req(`/auth/invitations/${invitation.id}/resend`, { token: acme.ownerToken, body: {} })).status, 409, 'a revoked invitation cannot be resent');
    });

    it('an owner of workspace A cannot see or touch invitations of workspace B', async () => {
      const otherToken = (await ok<Session>(await login(OTHER_ADMIN.email, { totpCode: await freshCode(OTHER_ADMIN.secret) }), 200)).accessToken;
      await ok(await req('/auth/invitations/invite', { token: otherToken, body: { email: 'someone@other-ws.test', role: 'EMPLOYEE' } }), 201);
      const mine = await ok<InvitationRow[]>(await req('/auth/invitations', { token: acme.ownerToken }), 200);
      assert.ok(mine.every((i) => i.email.endsWith('@signup.test')), 'only own invitations');
      const theirs = await ok<InvitationRow[]>(await req('/auth/invitations', { token: otherToken }), 200);
      assert.deepEqual(theirs.map((i) => i.email), ['someone@other-ws.test']);
      assert.equal((await req(`/auth/invitations/${invitation.id}/revoke`, { token: otherToken, body: {} })).status, 404);
      const users = await ok<AdminUserRow[]>(await req('/admin/users', { token: otherToken }), 200);
      assert.deepEqual(users.map((u) => u.id), [OTHER_ADMIN.id], 'users of B only');
    });
  });

  describe('3. Delegation and escalation attempts all fail (FR-AUTH-006)', () => {
    let admin: { id: string; token: string; secret: string };
    let clerk: CustomRole;

    it('the owner makes the member an Admin; the member\'s old session ends at once and 2FA is required', async () => {
      await ok(await req(`/admin/users/${member.id}/role`, { method: 'PUT', token: acme.ownerToken, body: { role: 'ADMIN' } }), 200);
      assert.equal((await req('/me/access', { token: member.token })).status, 401, 'old token revoked');
      const needsSetup = await ok<{ requires2faSetup: true; enrollmentToken: string }>(await login(member.email), 200);
      const { secret, session } = await enrol(needsSetup.enrollmentToken);
      admin = { id: member.id, token: session.accessToken, secret };
      assert.equal(await auditCount(acme.orgId, 'USER_ROLE_CHANGED'), 1);
    });

    it('an Admin cannot touch the Owner: role, status, ownership', async () => {
      assert.equal((await req(`/admin/users/${acme.ownerId}/role`, { method: 'PUT', token: admin.token, body: { role: 'EMPLOYEE' } })).status, 403);
      assert.equal((await req(`/admin/users/${acme.ownerId}/status`, { method: 'PUT', token: admin.token, body: { status: 'SUSPENDED' } })).status, 403);
      assert.equal((await req(`/org/owners/${acme.ownerId}/remove`, { token: admin.token, body: { password: PASSWORD } })).status, 403);
      assert.equal((await req('/org/ownership/transfers', { token: admin.token, body: { newOwnerId: admin.id, password: PASSWORD } })).status, 403, 'org.owner is not held by admins');
    });

    it('nobody changes their own role or status; nobody assigns what they do not hold', async () => {
      assert.equal((await req(`/admin/users/${admin.id}/role`, { method: 'PUT', token: admin.token, body: { role: 'SUPER_ADMIN' } })).status, 403, 'own role');
      assert.equal((await req(`/admin/users/${admin.id}/status`, { method: 'PUT', token: admin.token, body: { status: 'SUSPENDED' } })).status, 403, 'own status');
      assert.equal((await req(`/admin/users/${acme.ownerId}/role`, { method: 'PUT', token: acme.ownerToken, body: { role: 'EMPLOYEE' } })).status, 403, 'the owner cannot demote themselves');
      // An Admin may not create a role holding vault.recover (HR managers only) or org.owner (nobody).
      const escalate = await req('/admin/roles', { token: admin.token, body: { name: 'Sneaky', baseRole: 'EMPLOYEE', addedPermissions: [Permission.VAULT_RECOVER] } });
      assert.equal(escalate.status, 403);
      const ownerPerm = await req('/admin/roles', { token: acme.ownerToken, body: { name: 'Fake owner', baseRole: 'ADMIN', addedPermissions: [Permission.ORG_OWNER] } });
      assert.equal(ownerPerm.status, 403, 'org.owner cannot be granted through a role, not even by an owner');
      assert.match(await ownerPerm.text(), /owner/i);
    });

    it('a role id from another organisation is not found; a user without roles.manage gets 403', async () => {
      const otherToken = (await ok<Session>(await login(OTHER_ADMIN.email, { totpCode: await freshCode(OTHER_ADMIN.secret) }), 200)).accessToken;
      const foreign = await ok<CustomRole>(await req('/admin/roles', { token: otherToken, body: { name: 'Foreign', baseRole: 'EMPLOYEE', addedPermissions: [Permission.TIMESHEETS_READ_ALL] } }), 201);
      assert.equal((await req(`/admin/users/${admin.id}/role`, { method: 'PUT', token: acme.ownerToken, body: { role: 'EMPLOYEE', customRoleId: foreign.id } })).status, 404, 'tampered role id');
      await ok(await req('/auth/invitations/invite', { token: acme.ownerToken, body: { email: 'lead@signup.test', role: 'TEAM_LEAD' } }), 201);
      await ok(await req('/auth/invitations/accept', { body: { inviteToken: tokenIn(lastMailTo('lead@signup.test')?.text)!, password: PASSWORD, displayName: 'Lee Lead' } }), 201);
      const lead = await ok<Session>(await login('lead@signup.test'), 200);
      assert.equal((await req('/admin/roles', { token: lead.accessToken })).status, 403);
      assert.equal((await req(`/admin/users/${admin.id}/role`, { method: 'PUT', token: lead.accessToken, body: { role: 'EMPLOYEE' } })).status, 403);
    });

    it('a permission removed from a role blocks the very next request (same token)', async () => {
      clerk = await ok<CustomRole>(await req('/admin/roles', { token: acme.ownerToken, body: { name: 'Payroll clerk', baseRole: 'EMPLOYEE', addedPermissions: [Permission.TIMESHEETS_READ_ALL] } }), 201);
      await ok(await req('/auth/invitations/invite', { token: acme.ownerToken, body: { email: 'clerk@signup.test', role: 'EMPLOYEE' } }), 201);
      await ok(await req('/auth/invitations/accept', { body: { inviteToken: tokenIn(lastMailTo('clerk@signup.test')?.text)!, password: PASSWORD, displayName: 'Cleo Clerk' } }), 201);
      const clerkSession = await ok<Session>(await login('clerk@signup.test'), 200);
      assert.equal((await req('/rates', { token: clerkSession.accessToken })).status, 403, 'a member cannot read rates');
      await ok(await req(`/admin/users/${clerkSession.user.id}/role`, { method: 'PUT', token: acme.ownerToken, body: { role: 'EMPLOYEE', customRoleId: clerk.id } }), 200);
      assert.equal((await req('/rates', { token: clerkSession.accessToken })).status, 200, 'a custom-role change applies to the next request, same token');
      await ok(await req(`/admin/roles/${clerk.id}`, { method: 'PUT', token: acme.ownerToken, body: { name: 'Payroll clerk', baseRole: 'EMPLOYEE', addedPermissions: [], version: clerk.version } }), 200);
      assert.equal((await req('/rates', { token: clerkSession.accessToken })).status, 403, 'blocked immediately, same token');
      const me = await ok<MyAccess>(await req('/me/access', { token: clerkSession.accessToken }), 200);
      assert.ok(!me.permissions.includes(Permission.TIMESHEETS_READ_ALL));
    });

    it('effective access shows permissions with descriptions and what the person can see', async () => {
      const access = await ok<EffectiveAccess>(await req(`/admin/users/${admin.id}/access`, { token: acme.ownerToken }), 200);
      assert.equal(access.user.role, 'ADMIN');
      assert.equal(access.user.isOwner, false);
      assert.equal(access.user.roleLabel, 'Admin');
      const adminItem = access.groups.flatMap((g) => g.items).find((i) => i.permission === Permission.USERS_MANAGE)!;
      assert.equal(adminItem.granted, true);
      assert.ok(adminItem.description.length > 20, 'plain-language description');
      const ownerItem = access.groups.flatMap((g) => g.items).find((i) => i.permission === Permission.ORG_OWNER)!;
      assert.equal(ownerItem.granted, false);
      assert.equal(access.areas.find((a) => a.key === 'owner')?.visible, false);
      assert.equal(access.areas.find((a) => a.key === 'admin-roles')?.visible, true);
      const ownerAccess = await ok<EffectiveAccess>(await req(`/admin/users/${acme.ownerId}/access`, { token: admin.token }), 200);
      assert.equal(ownerAccess.user.isOwner, true);
      assert.equal(ownerAccess.areas.find((a) => a.key === 'owner')?.visible, true);
      assert.equal((await req(`/admin/users/${OTHER_ADMIN.id}/access`, { token: acme.ownerToken })).status, 404, 'other organisation');
    });

    it('a job title is descriptive only', async () => {
      const me = await ok<MyAccess>(await req('/me/profile', { method: 'PUT', token: admin.token, body: { jobTitle: 'Tech Lead' } }), 200);
      assert.equal(me.jobTitle, 'Tech Lead');
      const before = (await ok<MyAccess>(await req('/me/access', { token: admin.token }), 200)).permissions;
      const row = await ok<AdminUserRow>(await req(`/admin/users/${admin.id}/profile`, { method: 'PUT', token: acme.ownerToken, body: { jobTitle: 'Developer' } }), 200);
      assert.equal(row.jobTitle, 'Developer');
      assert.deepEqual((await ok<MyAccess>(await req('/me/access', { token: admin.token }), 200)).permissions, before, 'no access change');
      assert.equal(await auditCount(acme.orgId, 'USER_PROFILE_UPDATED'), 2);
    });

    describe('4. Suspend, reactivate and offboard (FR-ORG-009, FR-AUTH-009)', () => {
      it('a suspended person cannot sign in and their sessions end; reactivation restores access', async () => {
        const lead = await ok<Session>(await login('lead@signup.test'), 200);
        const row = await ok<AdminUserRow>(await req(`/admin/users/${lead.user.id}/status`, { method: 'PUT', token: admin.token, body: { status: 'SUSPENDED' } }), 200);
        assert.equal(row.status, 'SUSPENDED');
        assert.equal((await req('/me/access', { token: lead.accessToken })).status, 401);
        assert.equal((await login('lead@signup.test')).status, 401);
        assert.equal(await auditCount(acme.orgId, 'USER_SUSPENDED'), 1);
        await ok(await req(`/admin/users/${lead.user.id}/status`, { method: 'PUT', token: admin.token, body: { status: 'ACTIVE' } }), 200);
        await ok(await login('lead@signup.test'), 200);
        assert.equal(await auditCount(acme.orgId, 'USER_REACTIVATED'), 1);
      });

      it('offboarding ends sessions, reassigns open tasks and cannot be undone to ACTIVE by mistake', async () => {
        const lead = await ok<Session>(await login('lead@signup.test'), 200);
        const task = await ok<{ id: string }>(await req('/tasks', { token: acme.ownerToken, body: { title: 'Hand over', assigneeId: lead.user.id } }), 201);
        const row = await ok<AdminUserRow>(await req(`/admin/users/${lead.user.id}/status`, { method: 'PUT', token: acme.ownerToken, body: { status: 'OFFBOARDED', reassignTasksTo: admin.id } }), 200);
        assert.equal(row.status, 'OFFBOARDED');
        assert.equal((await req('/me/access', { token: lead.accessToken })).status, 401);
        const t = (await adminPool.query(`SELECT assignee_id FROM tasks WHERE id = $1`, [task.id])).rows[0];
        assert.equal(t.assignee_id, admin.id, 'open task reassigned');
        assert.equal(await auditCount(acme.orgId, 'USER_OFFBOARDED'), 1);
        assert.equal((await req(`/admin/users/${lead.user.id}/status`, { method: 'PUT', token: acme.ownerToken, body: { status: 'ACTIVE' } })).status, 409, 'offboarded is final');
      });
    });

    describe('5. Ownership: transfer with acceptance, several owners, last-owner protection', () => {
      let transfer: OwnershipTransfer;
      it('the owner cannot give up or lose the last ownership', async () => {
        assert.equal((await req(`/org/owners/${acme.ownerId}/remove`, { token: acme.ownerToken, body: { password: PASSWORD } })).status, 409);
        assert.equal((await req(`/admin/users/${acme.ownerId}/status`, { method: 'PUT', token: acme.ownerToken, body: { status: 'SUSPENDED' } })).status, 403, 'own status');
      });

      it('a transfer needs re-authentication and the new owner\'s acceptance', async () => {
        const noAuth = await req('/org/ownership/transfers', { token: acme.ownerToken, body: { newOwnerId: admin.id, password: 'wrong-password-here' } });
        assert.equal(noAuth.status, 401);
        transfer = await ok<OwnershipTransfer>(await req('/org/ownership/transfers', { token: acme.ownerToken, body: { newOwnerId: admin.id, password: PASSWORD } }), 201);
        assert.equal(transfer.status, 'PENDING');
        assert.equal(transfer.to.id, admin.id);
        const stillOwner = (await adminPool.query(`SELECT is_owner FROM users WHERE id = $1`, [admin.id])).rows[0];
        assert.equal(stillOwner.is_owner, false, 'nothing changes before acceptance');
        const mail = lastMailTo(member.email);
        assert.ok(mail && /ownership/i.test(mail.subject), 'the new owner is told by e-mail');
        // Only the recipient accepts.
        assert.equal((await req(`/org/ownership/transfers/${transfer.id}/accept`, { token: acme.ownerToken, body: {} })).status, 403);
        const mine = await ok<OwnershipTransfer[]>(await req('/org/ownership/transfers', { token: admin.token }), 200);
        assert.deepEqual(mine.map((t) => t.id), [transfer.id]);
        await ok(await req(`/org/ownership/transfers/${transfer.id}/accept`, { token: admin.token, body: {} }), 200);
        const rows = (await adminPool.query(`SELECT id, role, is_owner FROM users WHERE id = ANY($1::uuid[]) ORDER BY is_owner`, [[acme.ownerId, admin.id]])).rows;
        assert.deepEqual(rows.map((r) => [r.id, r.role, r.is_owner]), [[acme.ownerId, 'ADMIN', false], [admin.id, 'SUPER_ADMIN', true]]);
        assert.equal(await auditCount(acme.orgId, 'OWNERSHIP_TRANSFER_ACCEPTED'), 1);
        // Both sessions were refreshed: the old owner's token is gone, the new owner's too.
        assert.equal((await req('/me/access', { token: acme.ownerToken })).status, 401);
        assert.equal((await req('/me/access', { token: admin.token })).status, 401);
      });

      it('the previous owner is now an Admin who cannot touch the new owner; two owners are possible; the last one stays', async () => {
        const oldOwner = await ok<Session>(await login('owner@signup.test', { totpCode: await freshCode(acme.ownerSecret) }), 200);
        assert.equal(oldOwner.user.role, 'ADMIN');
        assert.equal((await req(`/admin/users/${admin.id}/role`, { method: 'PUT', token: oldOwner.accessToken, body: { role: 'EMPLOYEE' } })).status, 403);
        const newOwner = await ok<Session>(await login(member.email, { totpCode: await freshCode(admin.secret) }), 200);
        // Share ownership with the previous owner again (keepOwnership), accepted by them.
        const share = await ok<OwnershipTransfer>(await req('/org/ownership/transfers', { token: newOwner.accessToken, body: { newOwnerId: acme.ownerId, keepOwnership: true, password: PASSWORD } }), 201);
        await ok(await req(`/org/ownership/transfers/${share.id}/accept`, { token: oldOwner.accessToken, body: {} }), 200);
        const owners = (await adminPool.query(`SELECT count(*)::int AS n FROM users WHERE org_id = $1 AND is_owner`, [acme.orgId])).rows[0].n;
        assert.equal(owners, 2);
        const profile = await ok<OrgProfile>(await req('/org/profile', { token: (await ok<Session>(await login(member.email, { totpCode: await freshCode(admin.secret) }), 200)).accessToken }), 200);
        assert.equal(profile.ownerCount, 2);
        // With two owners, one can step down; then the last one cannot.
        const ownerA = await ok<Session>(await login('owner@signup.test', { totpCode: await freshCode(acme.ownerSecret) }), 200);
        await ok(await req(`/org/owners/${admin.id}/remove`, { token: ownerA.accessToken, body: { totpCode: await freshCode(acme.ownerSecret) } }), 200);
        assert.equal((await adminPool.query(`SELECT is_owner, role FROM users WHERE id = $1`, [admin.id])).rows[0].is_owner, false);
        assert.equal((await req(`/org/owners/${acme.ownerId}/remove`, { token: ownerA.accessToken, body: { password: PASSWORD } })).status, 409, 'last owner');
        assert.equal(await auditCount(acme.orgId, 'OWNERSHIP_REMOVED'), 1);
        acme.ownerToken = ownerA.accessToken;
      });

      it('sign-in settings are owner-only: an Admin with org.manage may rename, but not change Google auto-join', async () => {
        const adminNow = await ok<Session>(await login(member.email, { totpCode: await freshCode(admin.secret) }), 200);
        assert.equal(adminNow.user.role, 'SUPER_ADMIN', 'still a super admin, no longer an owner');
        await ok(await req('/org/profile', { method: 'PUT', token: adminNow.accessToken, body: { name: 'Acme Renamed' } }), 200);
        assert.equal((await req('/org/profile', { method: 'PUT', token: adminNow.accessToken, body: { ssoAutoJoinDomain: 'signup.test' } })).status, 403);
        // ADR 039: joining is by invitation; domain auto-join is off until the owner turns it on,
        // and only for the owner's own domain, never a public mail service.
        assert.equal((await ok<OrgProfile>(await req('/org/profile', { token: acme.ownerToken }), 200)).ssoAutoJoinDomain, null, 'off by default');
        const gmail = await req('/org/profile', { method: 'PUT', token: acme.ownerToken, body: { ssoAutoJoinDomain: 'gmail.com' } });
        assert.equal(gmail.status, 400);
        assert.match(await gmail.text(), /public e-mail service/);
        const foreign = await req('/org/profile', { method: 'PUT', token: acme.ownerToken, body: { ssoAutoJoinDomain: 'other-company.test' } });
        assert.equal(foreign.status, 400);
        assert.match(await foreign.text(), /signup\.test/);
        const updated = await ok<OrgProfile>(await req('/org/profile', { method: 'PUT', token: acme.ownerToken, body: { ssoAutoJoinDomain: 'signup.test', mfaForSso: false } }), 200);
        assert.equal(updated.ssoAutoJoinDomain, 'signup.test');
        assert.equal(updated.mfaForSso, false);
      });
    });
  });

  describe('6. One address, several workspaces', () => {
    it('sign-in asks which workspace is meant, then verifies the chosen one', async () => {
      await ok(await req('/auth/signup', { body: { workspaceName: 'Beta Signup', email: 'owner@signup.test', password: PASSWORD, displayName: 'Oona Owner' } }), 201);
      const choose = await ok<{ chooseWorkspace: true; workspaces: Array<{ slug: string; name: string }> }>(await login('owner@signup.test'), 200);
      assert.equal(choose.chooseWorkspace, true);
      assert.deepEqual(choose.workspaces.map((w) => w.slug).sort(), ['acme-signup', 'beta-signup']);
      const unverified = await login('owner@signup.test', { workspace: 'beta-signup' });
      assert.equal(unverified.status, 403);
      assert.match(await unverified.text(), /EMAIL_NOT_VERIFIED/);
      const token = tokenIn(lastMailTo('owner@signup.test')?.text)!;
      await ok(await req('/auth/email/verify', { body: { token } }), 200);
      const beta = await ok<{ requires2faSetup: true }>(await login('owner@signup.test', { workspace: 'beta-signup' }), 200);
      assert.equal(beta.requires2faSetup, true);
      assert.equal((await login('owner@signup.test', { workspace: 'nope' })).status, 401, 'unknown workspace is a plain failure');
    });

    it('rows of the new tables are invisible across tenants (RLS)', async () => {
      const c = await appPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [OTHER]);
        assert.equal((await c.query(`SELECT * FROM ownership_transfers`)).rows.length, 0);
        assert.equal((await c.query(`SELECT * FROM email_verification_tokens`)).rows.length, 0);
        assert.equal((await c.query(`SELECT * FROM oauth_identities`)).rows.length, 0);
        await assert.rejects(c.query(`INSERT INTO ownership_transfers (org_id, from_user_id, to_user_id, expires_at) VALUES ($1, $2, $3, now())`, [acme.orgId, acme.ownerId, member.id]), /row-level security/);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
      assert.ok((await adminPool.query(`SELECT count(*)::int AS n FROM ownership_transfers WHERE org_id = $1`, [acme.orgId])).rows[0].n >= 2);
    });
  });
});
