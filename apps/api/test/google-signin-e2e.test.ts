/**
 * Sign in with Google (FR-AUTH-005; ADR 037) against a fake Google that checks PKCE, the client
 * secret and the nonce, and signs ID tokens with its own RSA key published as a JWKS.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import pg from 'pg';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { MAIL_TRANSPORT } from '../src/common/mailer.ts';
import type { InMemoryMailTransport } from '../src/common/mailer.ts';
import { refreshCookie, refreshWithCookie } from './support/refresh-cookie.ts';
import { freshCode } from './support/totp.ts';

const PORT = 3084;
const G_PORT = 3085;
const CLIENT_ID = 'hrvo-test-client';
const CLIENT_SECRET = 'hrvo-test-secret';
const PASSWORD = 'GoogleSigninPass!2026';
const ORG = 'facade00-0000-4000-8000-000000000001';
const SLUGS = ['google-ws', 'google-ws-2', 'gsignup'];
const U = {
  owner: { id: 'facade00-0000-4000-8000-000000000011', email: 'owner@gsso.test', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' },
  hr: { id: 'facade00-0000-4000-8000-000000000012', email: 'hr@gsso.test', secret: 'MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U' },
  emp: { id: 'facade00-0000-4000-8000-000000000013', email: 'emp@gsso.test' },
};

/** A minimal Google: /token checks the code, PKCE and secret; /certs publishes the key. */
class FakeGoogle {
  readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly kid = 'test-key-1';
  private readonly codes = new Map<string, { challenge: string; nonce: string; email: string; sub: string; emailVerified: boolean; name: string }>();
  tokenCalls = 0;
  server!: http.Server;

  issueCode(c: { challenge: string; nonce: string; email: string; sub: string; emailVerified?: boolean; name?: string }): string {
    const code = randomBytes(12).toString('hex');
    this.codes.set(code, { ...c, emailVerified: c.emailVerified ?? true, name: c.name ?? 'Google Person' });
    return code;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      if (req.url === '/certs') {
        const jwk = this.keys.publicKey.export({ format: 'jwk' }) as Record<string, string>;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ keys: [{ ...jwk, kid: this.kid, alg: 'RS256', use: 'sig' }] }));
        return;
      }
      if (req.url === '/token' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          this.tokenCalls += 1;
          const p = new URLSearchParams(body);
          const entry = this.codes.get(p.get('code') ?? '');
          const challenge = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
          if (!entry || p.get('grant_type') !== 'authorization_code' || p.get('client_id') !== CLIENT_ID || p.get('client_secret') !== CLIENT_SECRET || challenge !== entry.challenge) {
            res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          this.codes.delete(p.get('code')!);
          const idToken = jwt.sign(
            { sub: entry.sub, email: entry.email, email_verified: entry.emailVerified, name: entry.name, nonce: entry.nonce },
            this.keys.privateKey, { algorithm: 'RS256', keyid: this.kid, issuer: `http://localhost:${G_PORT}`, audience: CLIENT_ID, expiresIn: 300 },
          );
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: 'ya29.fake', id_token: idToken, token_type: 'Bearer', expires_in: 3600 }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => this.server.listen(G_PORT, '127.0.0.1', r));
  }
}

interface Flow { cookie: string; state: string; nonce: string; challenge: string }

describe('Sign in with Google (FR-AUTH-005; ADR 037)', { concurrency: false }, () => {
  let app: INestApplication;
  let base: string;
  let adminPool: pg.Pool;
  let outbox: InMemoryMailTransport;
  const google = new FakeGoogle();

  const json = (path: string, body: unknown, token?: string) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  async function start(body: Record<string, unknown>): Promise<Flow> {
    const res = await json('/auth/google/start', body);
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('hrvo_oauth='));
    assert.ok(cookie, 'state cookie');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Path=\/auth\/google/);
    const { authorizeUrl } = JSON.parse(text) as { authorizeUrl: string };
    const u = new URL(authorizeUrl);
    assert.equal(u.origin, `http://localhost:${G_PORT}`);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('client_id'), CLIENT_ID);
    assert.match(u.searchParams.get('scope') ?? '', /openid/);
    return { cookie: cookie.split(';')[0]!, state: u.searchParams.get('state')!, nonce: u.searchParams.get('nonce')!, challenge: u.searchParams.get('code_challenge')! };
  }
  async function callback(flow: Flow, account: { email: string; sub: string; emailVerified?: boolean; name?: string }, override: Record<string, string> = {}) {
    const code = google.issueCode({ challenge: flow.challenge, nonce: flow.nonce, ...account });
    const q = new URLSearchParams({ code, state: flow.state, ...override });
    const res = await fetch(`${base}/auth/google/callback?${q.toString()}`, { redirect: 'manual', headers: { Cookie: flow.cookie } });
    assert.equal(res.status, 302, await res.text());
    const location = new URL(res.headers.get('location')!);
    const cookies = res.headers.getSetCookie();
    const refresh = cookies.find((c) => c.startsWith('refreshToken=') && !/refreshToken=;/.test(c));
    return { location, sso: location.searchParams.get('sso'), code: location.searchParams.get('code'), fragmentToken: /#token=(.+)$/.exec(location.hash)?.[1] ?? null, refresh: refresh ? refreshCookie(res) : null, cleared: cookies.some((c) => c.startsWith('hrvo_oauth=;') || /hrvo_oauth=.*Expires=Thu, 01 Jan 1970/.test(c)) };
  }
  const auditCount = async (org: string, action: string) =>
    (await adminPool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = $2`, [org, action])).rows[0].n as number;

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.RATE_LIMIT_SIGNUP = '1000';
    process.env.RATE_LIMIT_OAUTH = '1000';
    process.env.JOBS_ENABLED = 'false';
    process.env.AUTH_MFA_ENFORCEMENT = '';
    process.env.APP_WEB_URL = 'http://localhost:3000';
    process.env.GOOGLE_OAUTH_CLIENT_ID = CLIENT_ID;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = CLIENT_SECRET;
    process.env.GOOGLE_OAUTH_AUTH_URL = `http://localhost:${G_PORT}/auth`;
    process.env.GOOGLE_OAUTH_TOKEN_URL = `http://localhost:${G_PORT}/token`;
    process.env.GOOGLE_OIDC_JWKS_URL = `http://localhost:${G_PORT}/certs`;
    process.env.GOOGLE_OIDC_ISSUER = `http://localhost:${G_PORT}`;
    process.env.GOOGLE_SIGNIN_REDIRECT_URL = `http://localhost:${PORT}/auth/google/callback`;
    await google.start();
    const conn = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev' };
    adminPool = new pg.Pool({ ...conn, user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await adminPool.query(`DELETE FROM organizations WHERE id = $1 OR slug = ANY($2::text[])`, [ORG, SLUGS]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Google Workspace Ltd', 'google-ws')`, [ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    await adminPool.query(
      `INSERT INTO users (id, org_id, email, display_name, role, is_owner, password_hash, status, mfa_enabled, mfa_secret) VALUES
         ($1, $2, $3, 'Omar Owner', 'SUPER_ADMIN', true, $8, 'ACTIVE', true, $4),
         ($5, $2, $6, 'Hana HR', 'HR_MANAGER', false, $8, 'ACTIVE', true, $7),
         ($9, $2, $10, 'Eve Employee', 'EMPLOYEE', false, $8, 'ACTIVE', false, NULL)`,
      [U.owner.id, ORG, U.owner.email, U.owner.secret, U.hr.id, U.hr.email, U.hr.secret, hash, U.emp.id, U.emp.email],
    );
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    base = `http://localhost:${PORT}`;
    outbox = app.get<InMemoryMailTransport>(MAIL_TRANSPORT, { strict: false });
  });

  after(async () => {
    await app?.close();
    await new Promise<void>((r) => google.server.close(() => r()));
    await adminPool.query(`DELETE FROM organizations WHERE id = $1 OR slug = ANY($2::text[])`, [ORG, SLUGS]);
    await adminPool.end();
  });

  it('is refused while no client id and secret are configured', async () => {
    const saved = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    try {
      assert.equal((await json('/auth/google/start', { mode: 'login' })).status, 503);
    } finally {
      process.env.GOOGLE_OAUTH_CLIENT_SECRET = saved;
    }
  });

  it('links an existing account by its verified address, then signs in by subject; the employee gets a session straight away', async () => {
    const flow = await start({ mode: 'login', returnTo: '/tasks' });
    const r = await callback(flow, { email: 'EMP@gsso.test', sub: 'google-sub-emp' });
    assert.equal(r.sso, 'ok', r.location.toString());
    assert.equal(r.location.searchParams.get('returnTo'), '/tasks');
    assert.ok(r.refresh, 'refresh cookie set by the callback');
    assert.ok(r.cleared, 'state cookie removed');
    const session = await refreshWithCookie(base, r.refresh!);
    assert.equal(session.status, 200);
    const body = (await session.json()) as { accessToken: string; user: { id: string } };
    assert.equal(body.user.id, U.emp.id);
    const me = await fetch(`${base}/me/access`, { headers: { Authorization: `Bearer ${body.accessToken}` } });
    assert.equal(me.status, 200);
    const ident = (await adminPool.query(`SELECT subject, email FROM oauth_identities WHERE user_id = $1`, [U.emp.id])).rows[0];
    assert.deepEqual(ident, { subject: 'google-sub-emp', email: 'emp@gsso.test' });
    assert.equal(await auditCount(ORG, 'GOOGLE_IDENTITY_LINKED'), 1);
    assert.equal(await auditCount(ORG, 'LOGIN_SUCCESS_GOOGLE'), 1);
    // Second time: found by the Google subject even if the address differs now.
    const again = await callback(await start({ mode: 'login' }), { email: 'renamed@gsso.test', sub: 'google-sub-emp' });
    assert.equal(again.sso, 'ok');
    assert.equal(await auditCount(ORG, 'GOOGLE_IDENTITY_LINKED'), 1, 'not linked twice');
  });

  it('a role that needs 2FA still answers the TOTP challenge after Google; the enrolment path for an unenrolled one', async () => {
    const r = await callback(await start({ mode: 'login', returnTo: '/admin/roles' }), { email: U.hr.email, sub: 'google-sub-hr' });
    assert.equal(r.sso, 'totp');
    assert.ok(r.fragmentToken, 'challenge token in the fragment');
    assert.equal(r.refresh, null, 'no session before the code');
    const bad = await json('/auth/google/totp', { challengeToken: r.fragmentToken, code: '000000' });
    assert.equal(bad.status, 401);
    const good = await json('/auth/google/totp', { challengeToken: r.fragmentToken, code: await freshCode(U.hr.secret) });
    const goodText = await good.text();
    assert.equal(good.status, 200, goodText);
    const body = JSON.parse(goodText) as { accessToken: string; refreshToken?: string };
    assert.equal(body.refreshToken, undefined, 'refresh token only as the cookie');
    assert.ok(refreshCookie(good));
    assert.equal((await fetch(`${base}/me/access`, { headers: { Authorization: `Bearer ${body.accessToken}` } })).status, 200);

    // An owner invited by Google without 2FA yet is sent to enrolment with an enrolment token.
    await adminPool.query(`UPDATE users SET mfa_enabled = false, mfa_secret = NULL WHERE id = $1`, [U.owner.id]);
    const enrol = await callback(await start({ mode: 'login' }), { email: U.owner.email, sub: 'google-sub-owner' });
    assert.equal(enrol.sso, 'enroll');
    assert.equal(enrol.location.pathname, '/login');
    assert.ok(enrol.fragmentToken);
    const setup = await json('/auth/2fa/setup', {}, enrol.fragmentToken!);
    assert.equal(setup.status, 200, 'the enrolment token opens 2FA setup');
  });

  it('with "2FA after Google" switched off by the owner, Google alone signs an HR manager in', async () => {
    await adminPool.query(`UPDATE organizations SET mfa_for_sso = false WHERE id = $1`, [ORG]);
    try {
      const r = await callback(await start({ mode: 'login' }), { email: U.hr.email, sub: 'google-sub-hr' });
      assert.equal(r.sso, 'ok');
      assert.ok(r.refresh);
    } finally {
      await adminPool.query(`UPDATE organizations SET mfa_for_sso = true WHERE id = $1`, [ORG]);
    }
  });

  it('an invited person must use the invited address; a match creates the account without a password', async () => {
    const hrToken = await (async () => {
      const r = await callback(await start({ mode: 'login' }), { email: U.hr.email, sub: 'google-sub-hr' });
      const totp = await json('/auth/google/totp', { challengeToken: r.fragmentToken, code: await freshCode(U.hr.secret) });
      return ((await totp.json()) as { accessToken: string }).accessToken;
    })();
    const invite = await json('/auth/invitations/invite', { email: 'newbie@gsso.test', role: 'EMPLOYEE' }, hrToken);
    assert.equal(invite.status, 201, await invite.text());
    const token = /#token=([0-9a-f]{64})/.exec([...outbox.outbox].reverse().find((m) => m.to === 'newbie@gsso.test')?.text ?? '')?.[1];
    assert.ok(token);
    const mismatch = await callback(await start({ mode: 'invite', inviteToken: token }), { email: 'someone-else@gsso.test', sub: 'google-sub-x' });
    assert.equal(mismatch.sso, 'error');
    assert.equal(mismatch.code, 'email_mismatch');
    assert.equal(mismatch.location.pathname, '/accept-invitation');
    assert.equal((await adminPool.query(`SELECT accepted_at FROM invitations WHERE org_id = $1 AND email = 'newbie@gsso.test'`, [ORG])).rows[0].accepted_at, null, 'still pending');
    const ok = await callback(await start({ mode: 'invite', inviteToken: token, displayName: 'Nia Newbie' }), { email: 'Newbie@gsso.test', sub: 'google-sub-newbie' });
    assert.equal(ok.sso, 'ok', ok.location.toString());
    const user = (await adminPool.query(`SELECT display_name, role, password_hash, email_verified_at FROM users WHERE org_id = $1 AND email = 'newbie@gsso.test'`, [ORG])).rows[0];
    assert.equal(user.display_name, 'Nia Newbie');
    assert.equal(user.role, 'EMPLOYEE');
    assert.equal(user.password_hash, null);
    assert.ok(user.email_verified_at);
    const reuse = await callback(await start({ mode: 'invite', inviteToken: token }), { email: 'newbie@gsso.test', sub: 'google-sub-newbie' });
    assert.equal(reuse.code, 'invitation_invalid', 'single use');
  });

  it('an unknown address is refused unless the owner enabled joining by domain', async () => {
    const refused = await callback(await start({ mode: 'login' }), { email: 'stranger@gsso.test', sub: 'google-sub-stranger' });
    assert.equal(refused.code, 'no_account');
    assert.equal((await adminPool.query(`SELECT count(*)::int AS n FROM users WHERE org_id = $1 AND email = 'stranger@gsso.test'`, [ORG])).rows[0].n, 0);
    await adminPool.query(`UPDATE organizations SET sso_auto_join_domain = 'gsso.test' WHERE id = $1`, [ORG]);
    const joined = await callback(await start({ mode: 'login' }), { email: 'stranger@gsso.test', sub: 'google-sub-stranger', name: 'Stan Stranger' });
    assert.equal(joined.sso, 'ok', joined.location.toString());
    const u = (await adminPool.query(`SELECT role, display_name FROM users WHERE org_id = $1 AND email = 'stranger@gsso.test'`, [ORG])).rows[0];
    assert.deepEqual(u, { role: 'EMPLOYEE', display_name: 'Stan Stranger' });
    assert.equal(await auditCount(ORG, 'USER_JOINED_VIA_SSO'), 1);
    const other = await callback(await start({ mode: 'login' }), { email: 'nobody@elsewhere.test', sub: 'google-sub-nobody' });
    assert.equal(other.code, 'no_account', 'another domain still needs an invitation');
  });

  it('creates a workspace from a Google account (verified by Google) and makes the person its owner', async () => {
    const r = await callback(await start({ mode: 'signup', workspaceName: 'GSignup', displayName: 'Gail Founder' }), { email: 'gail@gsignup.test', sub: 'google-sub-gail' });
    assert.equal(r.sso, 'enroll', `${r.location} (owners must set up 2FA)`);
    const org = (await adminPool.query(`SELECT id FROM organizations WHERE slug = 'gsignup'`)).rows[0];
    assert.ok(org);
    const owner = (await adminPool.query(`SELECT role, is_owner, password_hash, email_verified_at FROM users WHERE org_id = $1`, [org.id])).rows[0];
    assert.equal(owner.role, 'SUPER_ADMIN');
    assert.equal(owner.is_owner, true);
    assert.equal(owner.password_hash, null);
    assert.ok(owner.email_verified_at, 'no e-mail verification needed');
    assert.equal(await auditCount(org.id, 'WORKSPACE_CREATED'), 1);
  });

  it('refuses an unverified Google address, a wrong state, a missing cookie and a denied consent', async () => {
    const unverified = await callback(await start({ mode: 'login' }), { email: U.emp.email, sub: 'google-sub-emp', emailVerified: false });
    assert.equal(unverified.code, 'unverified_email');
    const wrongState = await callback(await start({ mode: 'login' }), { email: U.emp.email, sub: 'google-sub-emp' }, { state: 'forged' });
    assert.equal(wrongState.code, 'invalid_state');
    const flow = await start({ mode: 'login' });
    const noCookie = await fetch(`${base}/auth/google/callback?code=x&state=${flow.state}`, { redirect: 'manual' });
    assert.equal(noCookie.status, 302);
    assert.match(noCookie.headers.get('location') ?? '', /code=invalid_state/);
    const denied = await callback(flow, { email: U.emp.email, sub: 'google-sub-emp' }, { error: 'access_denied' });
    assert.equal(denied.code, 'denied');
    // A code whose PKCE verifier does not match the challenge is refused by Google (and so by us).
    const other = await start({ mode: 'login' });
    const code = google.issueCode({ challenge: 'not-the-challenge', nonce: other.nonce, email: U.emp.email, sub: 'google-sub-emp' });
    const bad = await fetch(`${base}/auth/google/callback?code=${code}&state=${other.state}`, { redirect: 'manual', headers: { Cookie: other.cookie } });
    assert.match(bad.headers.get('location') ?? '', /code=failed/);
  });

  it('a suspended person is not signed in by Google either', async () => {
    await adminPool.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [U.emp.id]);
    try {
      const r = await callback(await start({ mode: 'login' }), { email: U.emp.email, sub: 'google-sub-emp' });
      assert.equal(r.code, 'account_inactive');
      assert.equal(r.refresh, null);
    } finally {
      await adminPool.query(`UPDATE users SET status = 'ACTIVE' WHERE id = $1`, [U.emp.id]);
    }
  });
});
