/**
 * Auth hardening E2E: password reset (FR-AUTH-008), auth audit events (FR-AUTH-011),
 * mandatory 2FA enrollment (FR-AUTH-004), socket lifecycle (FR-AUTH-003), security
 * baseline (helmet/CSP, CORS allow-list, rate limits, CSRF, cookie flags) and the
 * breached-password checker (FR-AUTH-002). See ADR 005.
 */
import 'reflect-metadata';
import { freshCode } from './support/totp.ts';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { io, Socket } from 'socket.io-client';
import argon2 from 'argon2';
import { generateSecret, generateSync } from 'otplib';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { MAIL_TRANSPORT, InMemoryMailTransport, createMailTransport } from '../src/common/mailer.ts';
import { AttendanceGateway } from '../src/attendance/attendance.gateway.ts';
import { signAccessToken } from '../src/auth/tokens.ts';
import { getCorsOrigins, getJwtSecret, refreshCookieOptions } from '../src/common/config.ts';
import {
  BreachCheckUnavailableError,
  HibpRangeChecker,
  createBreachedPasswordChecker,
} from '../src/auth/breached-password.ts';
import type { JwtPayload } from '../../../packages/shared/src/index.ts';
import { cookieValue, refreshCookie, refreshTokenFields, refreshWithCookie } from './support/refresh-cookie.ts';

const ORG = '99990000-0000-4000-8000-000000000001';
const SLUG = 'auth-hardening-e2e';
const PASSWORD = 'ComplexPassword123!';
const ALLOWED_ORIGIN = 'http://app.hrvo.test';
const EVIL_ORIGIN = 'http://evil.test';

const U = {
  hr: { id: '99990000-0000-4000-8000-000000000011', email: 'hr@hardening.test', role: 'HR' },
  admin: { id: '99990000-0000-4000-8000-000000000012', email: 'admin@hardening.test', role: 'ADMIN' },
  reset: { id: '99990000-0000-4000-8000-000000000013', email: 'reset@hardening.test', role: 'EMPLOYEE' },
  life: { id: '99990000-0000-4000-8000-000000000014', email: 'life@hardening.test', role: 'EMPLOYEE' },
  suspend: { id: '99990000-0000-4000-8000-000000000015', email: 'suspend@hardening.test', role: 'EMPLOYEE' },
  offboard: { id: '99990000-0000-4000-8000-000000000016', email: 'offboard@hardening.test', role: 'EMPLOYEE' },
  sweep: { id: '99990000-0000-4000-8000-000000000017', email: 'sweep@hardening.test', role: 'EMPLOYEE' },
  csrf: { id: '99990000-0000-4000-8000-000000000018', email: 'csrf@hardening.test', role: 'EMPLOYEE' },
  limits: { id: '99990000-0000-4000-8000-000000000019', email: 'limits@hardening.test', role: 'EMPLOYEE' },
  nobody: { id: '99990000-0000-4000-8000-000000000020', email: 'cookieonly@hardening.test', role: 'ADMIN' },
} as const;

interface LoginResult {
  accessToken?: string;
  sessionId?: string;
  sessionSecret?: string;
  enrollmentToken?: string;
  requires2fa?: boolean;
  requires2faSetup?: boolean;
  message?: string;
}

function decodeJwt(token: string): JwtPayload {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as JwtPayload;
}

/** Same user and session as `accessToken`, but expiring in `ttlSeconds`. */
function shortLivedCopy(accessToken: string, ttlSeconds: number): string {
  const c = decodeJwt(accessToken);
  return signAccessToken(
    { sub: c.sub, orgId: c.orgId, email: c.email, role: c.role, displayName: c.displayName, teamId: c.teamId, sid: c.sid as string },
    ttlSeconds,
  );
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('Auth hardening E2E (FR-AUTH-002/003/004/008/011, security baseline)', { concurrency: false }, () => {
  let app: INestApplication;
  let limitedApp: INestApplication;
  let base: string;
  let limitedBase: string;
  let mainPort: number;
  let limitedPort: number;
  let adminPool: pg.Pool;
  let outbox: InMemoryMailTransport;
  const sockets: Socket[] = [];

  async function startApp(port: number, limits: Record<string, string>): Promise<INestApplication> {
    return await withEnv(limits, async () => {
      const a = await NestFactory.create(AppModule, { logger: false });
      configureApp(a);
      await a.listen(port);
      return a;
    });
  }

  async function login(email: string, password = PASSWORD, extra: Record<string, string> = {}, url = base) {
    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, ...extra }),
    });
    return { res, body: (await res.json()) as LoginResult };
  }

  /** Signs in like a browser: tokens from the body, refresh token only from the httpOnly cookie. */
  async function loginOk(email: string): Promise<{ accessToken: string; sessionId: string; sessionSecret: string; refreshCookie: string }> {
    const { res, body } = await login(email);
    assert.equal(res.status, 200, `login ${email}: ${body.message}`);
    assert.ok(body.accessToken && body.sessionId && body.sessionSecret);
    return { accessToken: body.accessToken, sessionId: body.sessionId, sessionSecret: body.sessionSecret, refreshCookie: refreshCookie(res) };
  }

  function connect(token: string | undefined, opts: { port?: number; origin?: string } = {}): Promise<Socket> {
    const socket = io(`http://localhost:${opts.port ?? mainPort}`, {
      transports: ['websocket'],
      reconnection: false,
      auth: token ? { token } : {},
      extraHeaders: opts.origin ? { Origin: opts.origin } : undefined,
    });
    sockets.push(socket);
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', (err) => reject(err));
    });
  }

  /** Resolves with the auth:* event seen (if any) once the socket is disconnected by the server. */
  function serverDisconnect(socket: Socket, timeoutMs = 4000): Promise<{ reason: string; authEvent?: string; authReason?: string }> {
    return new Promise((resolve, reject) => {
      let authEvent: string | undefined;
      let authReason: string | undefined;
      socket.on('auth:revoked', (p: { reason: string }) => { authEvent = 'auth:revoked'; authReason = p.reason; });
      socket.on('auth:expired', (p: { reason: string }) => { authEvent = 'auth:expired'; authReason = p.reason; });
      const timer = setTimeout(() => reject(new Error('socket was not disconnected in time')), timeoutMs);
      socket.once('disconnect', (reason) => {
        clearTimeout(timer);
        resolve({ reason, authEvent, authReason });
      });
    });
  }

  async function auditActions(userId: string): Promise<string[]> {
    const res = await adminPool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE org_id = $1 AND actor_id = $2 ORDER BY id`,
      [ORG, userId],
    );
    return res.rows.map((r) => r.action);
  }

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.CORS_ORIGINS = ALLOWED_ORIGIN;
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || 'postgresql://hrvo_app:hrvo_app_pass@localhost:5433/hrvo_dev?schema=public';

    adminPool = new pg.Pool({
      host: process.env.PGHOST || 'localhost',
      port: Number(process.env.PGPORT || 5433),
      database: process.env.PGDATABASE || 'hrvo_dev',
      user: process.env.PGADMIN_USER || 'postgres',
      password: process.env.PGADMIN_PASSWORD || 'postgres',
    });
    await adminPool.query(`DELETE FROM organizations WHERE id = $1 OR slug = $2`, [ORG, SLUG]);
    await adminPool.query(
      `INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Hardening Ltd', $2, 'Asia/Colombo')`,
      [ORG, SLUG],
    );
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(U)) {
      await adminPool.query(
        `INSERT INTO users (id, org_id, email, display_name, role, password_hash, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')`,
        [u.id, ORG, u.email, u.email.split('@')[0], u.role, hash],
      );
    }

    mainPort = 3041;
    limitedPort = 3042;
    app = await startApp(mainPort, {
      RATE_LIMIT_LOGIN: '1000',
      RATE_LIMIT_REFRESH: '1000',
      RATE_LIMIT_PASSWORD_RESET: '1000',
      RATE_LIMIT_HEARTBEAT: '1000',
    });
    limitedApp = await startApp(limitedPort, {
      RATE_LIMIT_LOGIN: '3',
      RATE_LIMIT_REFRESH: '2',
      RATE_LIMIT_PASSWORD_RESET: '2',
      RATE_LIMIT_HEARTBEAT: '2',
    });
    base = `http://localhost:${mainPort}`;
    limitedBase = `http://localhost:${limitedPort}`;
    outbox = app.get<InMemoryMailTransport>(MAIL_TRANSPORT, { strict: false });
    assert.ok(outbox instanceof InMemoryMailTransport);
  });

  after(async () => {
    for (const s of sockets) s.disconnect();
    await app?.close();
    await limitedApp?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.end();
  });

  // ---------------------------------------------------------------------------
  describe('Mandatory 2FA enrollment for ADMIN/HR (FR-AUTH-004)', { concurrency: false }, () => {
    let enrollmentToken: string;

    it('HR login without TOTP enrolled returns only an enrollment token (no access/refresh token, no cookie)', async () => {
      const { res, body } = await login(U.hr.email);
      assert.equal(res.status, 200);
      assert.equal(body.requires2faSetup, true);
      assert.equal(body.accessToken, undefined);
      assert.deepEqual(refreshTokenFields(body), []);
      assert.deepEqual(res.headers.getSetCookie(), []);
      assert.ok(body.enrollmentToken);
      enrollmentToken = body.enrollmentToken;
      assert.equal(decodeJwt(enrollmentToken).sid, undefined);
    });

    it('enrollment token is rejected by every non-enrollment route and by the socket gateway', async () => {
      for (const [method, path] of [['GET', '/users/me'], ['GET', '/audit-logs'], ['GET', '/attendance/live'], ['POST', '/auth/logout']]) {
        const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${enrollmentToken}` } });
        assert.equal(res.status, 401, `${method} ${path}`);
      }
      await assert.rejects(connect(enrollmentToken), /Unauthorized/);
    });

    it('wrong verification code is rejected and audited; correct code enables 2FA and issues the full session', async () => {
      const setup = await fetch(`${base}/auth/2fa/setup`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${enrollmentToken}` },
      });
      assert.equal(setup.status, 200);
      const { secret } = (await setup.json()) as { secret: string };

      const wrongCode = generateSync({ secret }) === '000000' ? '111111' : '000000';
      const bad = await fetch(`${base}/auth/2fa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${enrollmentToken}` },
        body: JSON.stringify({ code: wrongCode }),
      });
      assert.equal(bad.status, 400);

      const good = await fetch(`${base}/auth/2fa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${enrollmentToken}` },
        body: JSON.stringify({ code: await freshCode(secret) }),
      });
      assert.equal(good.status, 200);
      const enrolled = (await good.json()) as LoginResult & { recoveryCodes: string[] };
      assert.equal(enrolled.recoveryCodes.length, 10);
      assert.ok(enrolled.accessToken);
      assert.deepEqual(refreshTokenFields(enrolled), []);
      refreshCookie(good);
      assert.ok(decodeJwt(enrolled.accessToken).sid);

      const me = await fetch(`${base}/users/me`, { headers: { Authorization: `Bearer ${enrolled.accessToken}` } });
      assert.equal(me.status, 200);
      assert.equal(((await me.json()) as { mfa_enabled: boolean }).mfa_enabled, true);

      // Re-running setup cannot replace an enabled authenticator
      const resetup = await fetch(`${base}/auth/2fa/setup`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${enrolled.accessToken}` },
      });
      assert.equal(resetup.status, 400);

      // Subsequent logins require TOTP
      const { body } = await login(U.hr.email);
      assert.equal(body.requires2fa, true);
      assert.equal(body.accessToken, undefined);
    });

    it('an enrolled ADMIN with a wrong TOTP code is refused, audited and counted toward lockout', async () => {
      const secret = generateSecret();
      await adminPool.query(`UPDATE users SET mfa_enabled = true, mfa_secret = $1 WHERE id = $2`, [secret, U.admin.id]);
      const wrong = generateSync({ secret }) === '123456' ? '654321' : '123456';
      const { res } = await login(U.admin.email, PASSWORD, { totpCode: wrong });
      assert.equal(res.status, 401);
      const row = await adminPool.query(`SELECT failed_login_attempts FROM users WHERE id = $1`, [U.admin.id]);
      assert.equal(row.rows[0].failed_login_attempts, 1);
      const ok = await login(U.admin.email, PASSWORD, { totpCode: await freshCode(secret) });
      assert.equal(ok.res.status, 200);
      assert.ok(ok.body.accessToken);
    });

    it('FR-AUTH-011: every 2FA step is in the audit log', async () => {
      const hr = await auditActions(U.hr.id);
      for (const a of ['2FA_ENROLLMENT_REQUIRED', '2FA_SETUP_STARTED', '2FA_VERIFY_FAILED', '2FA_ENABLED', 'LOGIN_SUCCESS_AFTER_2FA_ENROLLMENT', '2FA_CHALLENGE_ISSUED']) {
        assert.ok(hr.includes(a), `missing ${a}`);
      }
      const admin = await auditActions(U.admin.id);
      assert.ok(admin.includes('2FA_FAILED'));
      assert.ok(admin.includes('LOGIN_SUCCESS'));
    });
  });

  // ---------------------------------------------------------------------------
  describe('Password reset (FR-AUTH-008)', { concurrency: false }, () => {
    let resetToken: string;
    let oldSession: Awaited<ReturnType<typeof loginOk>>;

    it('unknown email gets the same 202 response and no mail', async () => {
      const before = outbox.outbox.length;
      const res = await fetch(`${base}/auth/password/forgot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@hardening.test' }),
      });
      assert.equal(res.status, 202);
      assert.match(((await res.json()) as { message: string }).message, /If the account exists/);
      assert.equal(outbox.outbox.length, before);
    });

    it('known email receives a single-use link; only the token hash is stored; expiry is 30 minutes', async () => {
      oldSession = await loginOk(U.reset.email);
      const res = await fetch(`${base}/auth/password/forgot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: U.reset.email.toUpperCase() }),
      });
      assert.equal(res.status, 202);
      const mail = outbox.outbox.at(-1);
      assert.ok(mail);
      assert.equal(mail.to, U.reset.email);
      const m = mail.text.match(/#token=([0-9a-f]{64})/);
      assert.ok(m, 'reset link with token in URL fragment');
      resetToken = m[1];

      const rows = await adminPool.query<{ token_hash: string; expires_at: Date; created_at: Date }>(
        `SELECT token_hash, expires_at, created_at FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()`,
        [U.reset.id],
      );
      assert.equal(rows.rows.length, 1);
      assert.equal(rows.rows[0].token_hash, sha256(resetToken));
      const ttlMin = (rows.rows[0].expires_at.getTime() - rows.rows[0].created_at.getTime()) / 60000;
      assert.ok(ttlMin > 29.9 && ttlMin <= 30.1, `ttl ${ttlMin} min`);
    });

    it('a breached or short new password is rejected without burning the link', async () => {
      for (const newPassword of ['password123456', 'short']) {
        const res = await fetch(`${base}/auth/password/reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: resetToken, newPassword }),
        });
        assert.equal(res.status, 400);
      }
      const row = await adminPool.query(`SELECT used_at FROM password_reset_tokens WHERE token_hash = $1`, [sha256(resetToken)]);
      assert.equal(row.rows[0].used_at, null);
    });

    it('reset sets the password, revokes all sessions and disconnects the user\'s sockets', async () => {
      const second = await loginOk(U.reset.email);
      const socket = await connect(second.accessToken);
      const gone = serverDisconnect(socket);

      const res = await fetch(`${base}/auth/password/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, newPassword: 'BrandNewPassphrase!42' }),
      });
      assert.equal(res.status, 200);
      const ev = await gone;
      assert.equal(ev.authReason, 'PASSWORD_RESET');

      for (const cookie of [oldSession.refreshCookie, second.refreshCookie]) {
        assert.equal((await refreshWithCookie(base, cookie)).status, 401);
      }
      const live = await adminPool.query(
        `SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1 AND NOT is_revoked`,
        [U.reset.id],
      );
      assert.equal(live.rows[0].n, 0);

      assert.equal((await login(U.reset.email)).res.status, 401);
      assert.equal((await login(U.reset.email, 'BrandNewPassphrase!42')).res.status, 200);
    });

    it('the link is single-use', async () => {
      const res = await fetch(`${base}/auth/password/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, newPassword: 'AnotherPassphrase!43' }),
      });
      assert.equal(res.status, 400);
    });

    it('an expired link is rejected and only the newest link is valid', async () => {
      const request = async () => {
        await fetch(`${base}/auth/password/forgot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: U.reset.email }),
        });
        return (outbox.outbox.at(-1)?.text.match(/#token=([0-9a-f]{64})/) ?? [])[1] as string;
      };
      const reset = (token: string) =>
        fetch(`${base}/auth/password/reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, newPassword: 'ExpiryCheckPassphrase!44' }),
        });

      const expired = await request();
      await adminPool.query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [sha256(expired)]);
      assert.equal((await reset(expired)).status, 400);

      const older = await request();
      const newer = await request();
      assert.equal((await reset(older)).status, 400);
      assert.equal((await reset(newer)).status, 200);
    });

    it('FR-AUTH-011: reset request and completion are audited with the revoked session count', async () => {
      const res = await adminPool.query<{ action: string; after: { sessionsRevoked?: number } | null }>(
        `SELECT action, after FROM audit_logs WHERE org_id = $1 AND actor_id = $2 AND action LIKE 'PASSWORD_RESET_%' ORDER BY id`,
        [ORG, U.reset.id],
      );
      const actions = res.rows.map((r) => r.action);
      assert.ok(actions.includes('PASSWORD_RESET_REQUESTED'));
      const completed = res.rows.find((r) => r.action === 'PASSWORD_RESET_COMPLETED');
      assert.ok(completed);
      assert.ok((completed.after?.sessionsRevoked ?? 0) >= 2);
    });
  });

  // ---------------------------------------------------------------------------
  describe('Socket lifecycle (FR-AUTH-003)', { concurrency: false }, () => {
    it('disconnects when the access token expires without refresh', async () => {
      const s = await loginOk(U.life.email);
      const shortLived = shortLivedCopy(s.accessToken, 2);
      const socket = await connect(shortLived);
      const ev = await serverDisconnect(socket, 5000);
      assert.equal(ev.authEvent, 'auth:expired');
      assert.equal(ev.reason, 'io server disconnect');
    });

    it('stays connected past expiry when the client sends auth:refresh with a newer token', async () => {
      const s = await loginOk(U.life.email);
      const shortLived = shortLivedCopy(s.accessToken, 2);
      const socket = await connect(shortLived);
      const ack = (await socket.emitWithAck('auth:refresh', { token: s.accessToken })) as { success: boolean };
      assert.equal(ack.success, true);
      await sleep(3000);
      assert.ok(socket.connected);

      // A token of a different user is refused
      const other = await loginOk(U.sweep.email);
      const refused = (await socket.emitWithAck('auth:refresh', { token: other.accessToken })) as { success: boolean };
      assert.equal(refused.success, false);
      socket.disconnect();
    });

    it('disconnects on logout, and the still-unexpired token can no longer open a socket', async () => {
      const s = await loginOk(U.life.email);
      const socket = await connect(s.accessToken);
      const gone = serverDisconnect(socket);
      const res = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${s.accessToken}` } });
      assert.equal(res.status, 200);
      assert.equal((await gone).authReason, 'LOGOUT');
      await assert.rejects(connect(s.accessToken), /Unauthorized/);
    });

    it('disconnects every socket of the family when refresh-token reuse revokes it', async () => {
      const s = await loginOk(U.life.email);
      const r1 = await refreshWithCookie(base, s.refreshCookie);
      assert.equal(r1.status, 200);
      const rotated = (await r1.json()) as LoginResult;

      // Old (rotated, unexpired) and new access tokens can both hold sockets
      const oldSocket = await connect(s.accessToken);
      const newSocket = await connect(rotated.accessToken);
      const goneOld = serverDisconnect(oldSocket);
      const goneNew = serverDisconnect(newSocket);

      const replay = await refreshWithCookie(base, s.refreshCookie);
      assert.equal(replay.status, 401);
      assert.equal((await goneOld).authReason, 'FAMILY_REUSE');
      assert.equal((await goneNew).authReason, 'FAMILY_REUSE');
    });

    for (const [key, status] of [['suspend', 'SUSPENDED'], ['offboard', 'OFFBOARDED']] as const) {
      it(`disconnects immediately when the user is ${status}, and blocks login and refresh`, async () => {
        const user = U[key];
        const s = await loginOk(user.email);
        const socket = await connect(s.accessToken);
        const gone = serverDisconnect(socket);
        await adminPool.query(`UPDATE users SET status = $1 WHERE id = $2`, [status, user.id]);
        assert.equal((await gone).authReason, `USER_${status}`);

        const again = await login(user.email);
        assert.equal(again.res.status, 401);
        assert.match(again.body.message ?? '', /not active/);
        const refresh = await refreshWithCookie(base, s.refreshCookie);
        assert.equal(refresh.status, 401);
        await assert.rejects(connect(s.accessToken), /Unauthorized/);

        const actions = await auditActions(user.id);
        assert.ok(actions.includes('LOGIN_REJECTED_INACTIVE'));
        assert.ok(actions.includes('REFRESH_REJECTED_INACTIVE'));
      });
    }

    it('periodic re-validation disconnects sockets even if a notification was missed', async () => {
      const s = await loginOk(U.sweep.email);
      const socket = await connect(s.accessToken);
      const gone = serverDisconnect(socket);
      // Change status with triggers suppressed for this transaction only (no NOTIFY sent).
      const c = await adminPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL session_replication_role = replica`);
        await c.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [U.sweep.id]);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      await sleep(300);
      assert.ok(socket.connected, 'no notification was sent');
      await app.get(AttendanceGateway).revalidateAll();
      assert.equal((await gone).authReason, 'SESSION_INVALID');
    });
  });

  // ---------------------------------------------------------------------------
  describe('Security baseline: headers, CORS, CSRF, cookies', { concurrency: false }, () => {
    it('sets helmet security headers with a locked-down CSP', async () => {
      const res = await fetch(`${base}/users/me`);
      assert.equal(res.status, 401);
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-powered-by'), null);
    });

    it('CORS answers only allow-listed origins', async () => {
      const preflight = (origin: string) =>
        fetch(`${base}/auth/refresh`, {
          method: 'OPTIONS',
          headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type,x-hrvo-csrf',
          },
        });
      const ok = await preflight(ALLOWED_ORIGIN);
      assert.equal(ok.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
      assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
      assert.match(ok.headers.get('access-control-allow-headers') ?? '', /x-hrvo-csrf/i);
      // Every verb the web app uses must pass the preflight (PUT is used by the weekly planner).
      assert.match(ok.headers.get('access-control-allow-methods') ?? '', /PUT/);
      const evil = await preflight(EVIL_ORIGIN);
      assert.equal(evil.headers.get('access-control-allow-origin'), null);
    });

    it('WebSocket handshakes from a non-allow-listed Origin are refused', async () => {
      const s = await loginOk(U.csrf.email);
      await assert.rejects(connect(s.accessToken, { origin: EVIL_ORIGIN }));
      const okSocket = await connect(s.accessToken, { origin: ALLOWED_ORIGIN });
      assert.ok(okSocket.connected);
      okSocket.disconnect();
    });

    it('refresh cookie is HttpOnly, SameSite=Strict, scoped to /auth/refresh; Secure in production and over HTTPS', async () => {
      const { res } = await login(U.csrf.email);
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith('refreshToken='));
      assert.ok(cookie);
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Strict/);
      assert.match(cookie, /Path=\/auth\/refresh/);
      assert.doesNotMatch(cookie, /Secure/);
      await withEnv({ NODE_ENV: 'production' }, () => {
        assert.equal(refreshCookieOptions().secure, true);
      });
      // Served over HTTPS (LAN proxy, docs/runbooks/lan-https.md): Secure outside production too.
      await withEnv({ APP_WEB_URL: 'https://192.168.52.124:3443' }, () => {
        assert.equal(refreshCookieOptions().secure, true);
      });
      await withEnv({ APP_WEB_URL: 'http://localhost:3000' }, () => {
        assert.equal(refreshCookieOptions().secure, false);
      });
      // ADR 040: web app and API on two sites (quick tunnels): SameSite=None, Secure and Partitioned; HTTPS only.
      await withEnv({ APP_WEB_URL: 'https://app.example.test', REFRESH_COOKIE_SAMESITE: 'none' }, () => {
        assert.deepEqual(refreshCookieOptions(), { httpOnly: true, secure: true, sameSite: 'none', path: '/auth/refresh', partitioned: true });
      });
      await withEnv({ APP_WEB_URL: 'http://localhost:3000', REFRESH_COOKIE_SAMESITE: 'none' }, () => {
        assert.throws(() => refreshCookieOptions(), /HTTPS/);
      });
      await withEnv({ REFRESH_COOKIE_SAMESITE: 'lax' }, () => {
        assert.throws(() => refreshCookieOptions(), /"strict" \(default\) or "none"/);
      });
    });

    it('cookie-based /auth/refresh requires the CSRF header and an allowed Origin', async () => {
      const { res } = await login(U.csrf.email);
      const cookie = (res.headers.getSetCookie().find((c) => c.startsWith('refreshToken=')) ?? '').split(';')[0];
      const call = (headers: Record<string, string>) =>
        fetch(`${base}/auth/refresh`, { method: 'POST', headers: { Cookie: cookie, ...headers } });

      assert.equal((await call({})).status, 403);
      assert.equal((await call({ 'X-HRVO-CSRF': '1', Origin: EVIL_ORIGIN })).status, 403);
      const ok = await call({ 'X-HRVO-CSRF': '1', Origin: ALLOWED_ORIGIN });
      assert.equal(ok.status, 200);
      assert.ok(ok.headers.getSetCookie().some((c) => c.startsWith('refreshToken=')));
    });
  });

  // ---------------------------------------------------------------------------
  describe('Rate limiting (login, refresh, password reset, heartbeat)', { concurrency: false }, () => {
    it('login: 4th attempt in the window gets 429', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await login('nobody@hardening.test', 'WrongPassword123', {}, limitedBase)).res.status);
      }
      assert.deepEqual(statuses, [401, 401, 401, 429]);
    });

    it('password reset: 3rd request in the window gets 429', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await fetch(`${limitedBase}/auth/password/forgot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'nobody@hardening.test' }),
        });
        statuses.push(r.status);
      }
      assert.deepEqual(statuses, [202, 202, 429]);
    });

    it('refresh: 3rd request in the window gets 429', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        statuses.push((await refreshWithCookie(limitedBase, `refreshToken=${'f'.repeat(64)}`)).status);
      }
      assert.deepEqual(statuses, [401, 401, 429]);
    });

    it('heartbeat: 3rd heartbeat in the window is refused with a rate-limit ack', async () => {
      const s = await loginOk(U.limits.email);
      const socket = await connect(s.accessToken, { port: limitedPort });
      const acks: Array<{ success: boolean; error?: string }> = [];
      for (let i = 1; i <= 3; i++) {
        acks.push((await socket.emitWithAck('presence:heartbeat', { sequenceNumber: i })) as { success: boolean; error?: string });
      }
      assert.notEqual(acks[0].error, 'Rate limit exceeded');
      assert.notEqual(acks[1].error, 'Rate limit exceeded');
      assert.deepEqual(acks[2], { success: false, error: 'Rate limit exceeded' });
      socket.disconnect();
    });
  });

  // ---------------------------------------------------------------------------
  describe('Refresh token is cookie-only (FR-AUTH-003)', { concurrency: false }, () => {
    /** Asserts a JSON body has no refresh-token field and does not contain the cookie's value anywhere. */
    async function assertNoRefreshTokenInBody(res: Response, expectCookie: boolean): Promise<Record<string, unknown>> {
      const text = await res.text();
      const body = JSON.parse(text) as Record<string, unknown>;
      assert.deepEqual(refreshTokenFields(body), [], `${res.url} body has no refresh token field`);
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith('refreshToken='));
      if (expectCookie) {
        assert.ok(cookie, `${res.url} sets the refresh cookie`);
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /SameSite=Strict/);
        assert.ok(!text.includes(cookieValue(cookie.split(';')[0]!)), `${res.url} body does not echo the cookie value`);
      }
      return body;
    }

    it('login, 2FA-enrollment verify, refresh and invitation accept never return a refresh token in the body', async () => {
      // Login (full session)
      const loginRes = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: U.csrf.email, password: PASSWORD }),
      });
      assert.equal(loginRes.status, 200);
      await assertNoRefreshTokenInBody(loginRes.clone(), true);

      // Refresh (rotation)
      const refreshed = await refreshWithCookie(base, refreshCookie(loginRes));
      assert.equal(refreshed.status, 200);
      await assertNoRefreshTokenInBody(refreshed, true);

      // 2FA enrollment verify, which completes a login for a mandatory-2FA role
      const first = await login(U.nobody.email);
      assert.ok(first.body.enrollmentToken);
      const setup = await fetch(`${base}/auth/2fa/setup`, { method: 'POST', headers: { Authorization: `Bearer ${first.body.enrollmentToken}` } });
      const { secret } = (await setup.json()) as { secret: string };
      const verify = await fetch(`${base}/auth/2fa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${first.body.enrollmentToken}` },
        body: JSON.stringify({ code: await freshCode(secret) }),
      });
      assert.equal(verify.status, 200);
      await assertNoRefreshTokenInBody(verify, true);

      // Invitation accept
      const inviteToken = randomBytes(32).toString('hex');
      await adminPool.query(
        `INSERT INTO invitations (org_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, 'invitee@hardening.test', 'EMPLOYEE', $2, $3, now() + interval '1 day')`,
        [ORG, sha256(inviteToken), U.hr.id],
      );
      const accept = await fetch(`${base}/auth/invitations/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteToken, password: 'InviteePassphrase!45', displayName: 'Invitee' }),
      });
      assert.equal(accept.status, 201);
      await assertNoRefreshTokenInBody(accept, false);
    });

    it('a refresh token sent in the JSON body is ignored (cookie only)', async () => {
      const s = await loginOk(U.csrf.email);
      const res = await fetch(`${base}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HRVO-CSRF': '1' },
        body: JSON.stringify({ refreshToken: cookieValue(s.refreshCookie) }),
      });
      assert.equal(res.status, 401);
    });
  });

  // ---------------------------------------------------------------------------
  describe('Breached-password check (FR-AUTH-002)', () => {
    const password = 'correct horse battery staple';
    const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();

    it('HIBP checker sends only the 5-char SHA-1 prefix with padding and matches the suffix', async () => {
      const calls: Array<{ url: string; headers: Record<string, string> }> = [];
      const fakeFetch = async (url: string, init: { headers: Record<string, string> }) => {
        calls.push({ url, headers: init.headers });
        return { ok: true, status: 200, text: async () => `0000000000000000000000000000000000A:0\r\n${sha1.slice(5)}:42\r\n` };
      };
      const checker = new HibpRangeChecker(fakeFetch, 'https://hibp.example');
      assert.equal(await checker.isBreached(password), true);
      assert.equal(calls[0].url, `https://hibp.example/range/${sha1.slice(0, 5)}`);
      assert.equal(calls[0].headers['Add-Padding'], 'true');
      assert.ok(!calls[0].url.includes(sha1.slice(5)));
    });

    it('padding entries (count 0) and non-matching suffixes are not breaches', async () => {
      const checker = new HibpRangeChecker(async () => ({ ok: true, status: 200, text: async () => `${sha1.slice(5)}:0\nABCDEF:3\n` }));
      assert.equal(await checker.isBreached(password), false);
    });

    it('network errors and HTTP errors surface as BreachCheckUnavailableError (fail closed upstream)', async () => {
      const down = new HibpRangeChecker(async () => { throw new TypeError('fetch failed'); });
      await assert.rejects(down.isBreached(password), BreachCheckUnavailableError);
      const http500 = new HibpRangeChecker(async () => ({ ok: false, status: 503, text: async () => '' }));
      await assert.rejects(http500.isBreached(password), BreachCheckUnavailableError);
    });

    it('defaults to HIBP; the local stub is refused in production', async () => {
      await withEnv({ BREACHED_PASSWORD_CHECK: undefined }, () => {
        assert.ok(createBreachedPasswordChecker() instanceof HibpRangeChecker);
      });
      // Empty (exported as "" by `set -a; . ./.env.demo-internet`) is the default too, not an unknown mode.
      await withEnv({ BREACHED_PASSWORD_CHECK: '' }, () => {
        assert.ok(createBreachedPasswordChecker() instanceof HibpRangeChecker);
      });
      await withEnv({ BREACHED_PASSWORD_CHECK: 'nope' }, () => {
        assert.throws(() => createBreachedPasswordChecker(), /Unknown BREACHED_PASSWORD_CHECK mode/);
      });
      await withEnv({ BREACHED_PASSWORD_CHECK: 'local', NODE_ENV: 'production' }, () => {
        assert.throws(() => createBreachedPasswordChecker(), /not allowed in production/);
      });
    });
  });

  describe('Production configuration guards', () => {
    it('refuses default/missing JWT secret, missing or wildcard CORS origins, and the dev SMTP transport', async () => {
      await withEnv({ NODE_ENV: 'production', JWT_SECRET: undefined }, () => {
        assert.throws(() => getJwtSecret(), /JWT_SECRET/);
      });
      await withEnv({ NODE_ENV: 'production', JWT_SECRET: 'super-secret-jwt-access-key-change-in-production-min-32-chars' }, () => {
        assert.throws(() => getJwtSecret(), /JWT_SECRET/);
      });
      await withEnv({ NODE_ENV: 'production', CORS_ORIGINS: undefined }, () => {
        assert.throws(() => getCorsOrigins(), /CORS_ORIGINS/);
      });
      await withEnv({ CORS_ORIGINS: '*' }, () => {
        assert.throws(() => getCorsOrigins(), /not allowed/);
      });
      await withEnv({ NODE_ENV: 'production', MAIL_TRANSPORT: 'smtp' }, () => {
        assert.throws(() => createMailTransport(), /production/);
      });
    });
  });
});
