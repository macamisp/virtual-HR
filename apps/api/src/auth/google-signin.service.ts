/**
 * Sign in with Google (FR-AUTH-005; ADR 037): OpenID Connect, authorization code with PKCE
 * (S256), random `state` and `nonce`. The state, nonce and verifier travel in a signed, httpOnly
 * cookie on the API origin, never in the database. The ID token is verified against Google's
 * published keys (JWKS): signature, issuer, audience (our client id), expiry and nonce, and the
 * address must be verified by Google.
 *
 * Linking rules: an existing account is linked only by its verified e-mail address; an invited
 * person's Google address must equal the invited one; nobody joins by domain unless the owner
 * enabled it (organizations.sso_auto_join_domain). Client id and secret come from the
 * environment only (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET, shared with calendar
 * sync; the sign-in redirect URI is GOOGLE_SIGNIN_REDIRECT_URL).
 */
import { BadRequestException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { CookieOptions } from 'express';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { PermissionResolver } from '../common/permission-resolver.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { getJwtSecret, mfaEnforced, servedOverHttps } from '../common/config.ts';
import { pkcePair } from '../calendar/providers.ts';
import { AuthService } from './auth.service.ts';
import type { AuthUserRow } from './auth.service.ts';
import { WorkspaceService, emailDomain } from './workspace.service.ts';
import { requiresMfa } from '../../../../packages/shared/src/auth/types.ts';
import type { GoogleResultCode, GoogleSigninMode, GoogleStartDto, GoogleTotpDto } from '../../../../packages/shared/src/auth/workspace.ts';

export const OAUTH_COOKIE = 'hrvo_oauth';
export const OAUTH_COOKIE_PATH = '/auth/google';
const STATE_TTL_SECONDS = 10 * 60;
const CHALLENGE_TTL_SECONDS = 5 * 60;
const ISSUER = 'hrvo-api';
const AUD_STATE = 'hrvo-google-state';
const AUD_CHALLENGE = 'hrvo-google-mfa';
const JWKS_TTL_MS = 60 * 60 * 1000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

interface StatePayload { state: string; nonce: string; verifier: string; mode: GoogleSigninMode; returnTo?: string; workspace?: string; workspaceName?: string; displayName?: string; inviteToken?: string }
interface IdClaims { sub: string; email: string; emailVerified: boolean; name: string | null }
interface Meta { ip?: string; userAgent?: string }
type Env = Record<string, string | undefined>;

/** Overrides of Google's URLs exist for tests only. */
function base(env: Env, name: string, fallback: string): string {
  const v = env[name];
  if (v && env.NODE_ENV === 'production') throw new Error(`${name} must not be overridden in production`);
  return (v || fallback).replace(/\/$/, '');
}

export function googleEnv(env: Env = process.env) {
  return {
    configured: !!(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET),
    clientId: env.GOOGLE_OAUTH_CLIENT_ID ?? '',
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
    authUrl: base(env, 'GOOGLE_OAUTH_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth'),
    tokenUrl: base(env, 'GOOGLE_OAUTH_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
    jwksUrl: base(env, 'GOOGLE_OIDC_JWKS_URL', 'https://www.googleapis.com/oauth2/v3/certs'),
    issuers: [...new Set([...(env.GOOGLE_OIDC_ISSUER ? [env.GOOGLE_OIDC_ISSUER] : ['https://accounts.google.com']), 'accounts.google.com'])],
    redirectUri: env.GOOGLE_SIGNIN_REDIRECT_URL || 'http://localhost:3001/auth/google/callback',
    webUrl: (env.APP_WEB_URL || 'http://localhost:3000').replace(/\/$/, ''),
  };
}

export function oauthCookieOptions(): CookieOptions {
  // Lax: the cookie must come back on Google's top-level redirect to the callback.
  return { httpOnly: true, secure: servedOverHttps(), sameSite: 'lax', path: OAUTH_COOKIE_PATH, maxAge: STATE_TTL_SECONDS * 1000 };
}

@Injectable()
export class GoogleSignInService {
  private jwks: { at: number; keys: Map<string, string> } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly workspaces: WorkspaceService,
    private readonly resolver: PermissionResolver,
  ) {}

  // ---------------------------------------------------------------- start

  start(dto: GoogleStartDto): { authorizeUrl: string; cookie: { name: string; value: string; options: CookieOptions } } {
    const env = googleEnv();
    if (!env.configured) throw new ServiceUnavailableException('Sign in with Google is not set up on this server');
    const { verifier, challenge } = pkcePair();
    const payload: StatePayload = {
      state: randomBytes(24).toString('base64url'), nonce: randomBytes(24).toString('base64url'), verifier, mode: dto.mode,
      returnTo: dto.returnTo, workspace: dto.workspace, workspaceName: dto.workspaceName, displayName: dto.displayName, inviteToken: dto.inviteToken,
    };
    const q = new URLSearchParams({
      client_id: env.clientId, redirect_uri: env.redirectUri, response_type: 'code', scope: 'openid email profile',
      state: payload.state, nonce: payload.nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
    });
    const value = jwt.sign(payload, getJwtSecret(), { expiresIn: STATE_TTL_SECONDS, issuer: ISSUER, audience: AUD_STATE, algorithm: 'HS256' });
    return { authorizeUrl: `${env.authUrl}?${q.toString()}`, cookie: { name: OAUTH_COOKIE, value, options: oauthCookieOptions() } };
  }

  // ---------------------------------------------------------------- callback

  /** Where to send the browser next, plus the refresh token when a login was completed. */
  async callback(q: { code?: string; state?: string; error?: string }, cookie: string | undefined, meta: Meta): Promise<{ redirect: string; refreshToken?: string }> {
    const env = googleEnv();
    let st: StatePayload | null = null;
    try {
      st = cookie ? (jwt.verify(cookie, getJwtSecret(), { issuer: ISSUER, audience: AUD_STATE, algorithms: ['HS256'] }) as StatePayload) : null;
    } catch { st = null; }
    const fail = (code: GoogleResultCode) => ({ redirect: this.resultUrl(env.webUrl, st?.mode ?? 'login', 'error', { code }) });
    if (!st) return fail('invalid_state');
    if (q.error) return fail(q.error === 'access_denied' ? 'denied' : 'failed');
    if (!q.code || !q.state || q.state !== st.state) return fail('invalid_state');
    if (!env.configured) return fail('not_configured');

    let claims: IdClaims | null;
    try {
      claims = await this.exchange(env, q.code, st);
    } catch {
      claims = null;
    }
    if (!claims) return fail('failed');
    if (!claims.emailVerified) return fail('unverified_email');

    let user: AuthUserRow | null;
    try {
      user = st.mode === 'invite' ? await this.acceptInvitation(st, claims, meta)
        : st.mode === 'signup' ? await this.signup(st, claims, meta)
        : await this.login(st, claims, meta);
    } catch (err) {
      if (err instanceof GoogleFlowError) return fail(err.code);
      throw err;
    }
    if (!user) return fail('failed');
    return await this.finish(env.webUrl, st, user, meta);
  }

  private resultUrl(web: string, mode: GoogleSigninMode, sso: string, params: Record<string, string | undefined>, fragment?: string): string {
    const path = mode === 'invite' ? '/accept-invitation' : mode === 'signup' ? '/signup' : '/login';
    const q = new URLSearchParams({ sso });
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    return `${web}${path}?${q.toString()}${fragment ? `#token=${fragment}` : ''}`;
  }

  private async exchange(env: ReturnType<typeof googleEnv>, code: string, st: StatePayload): Promise<IdClaims | null> {
    const res = await fetch(env.tokenUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: st.verifier, redirect_uri: env.redirectUri, client_id: env.clientId, client_secret: env.clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    // Only the status reaches logs; Google's bodies can echo tokens.
    if (!res.ok) return null;
    const body = (await res.json()) as { id_token?: unknown };
    if (typeof body.id_token !== 'string') return null;
    return await this.verifyIdToken(env, body.id_token, st.nonce);
  }

  private async verifyIdToken(env: ReturnType<typeof googleEnv>, idToken: string, nonce: string): Promise<IdClaims | null> {
    const header = jwt.decode(idToken, { complete: true })?.header as { kid?: string; alg?: string } | undefined;
    if (!header?.kid || header.alg !== 'RS256') return null;
    const key = (await this.signingKey(env, header.kid, false)) ?? (await this.signingKey(env, header.kid, true));
    if (!key) return null;
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(idToken, key, { algorithms: ['RS256'], audience: env.clientId, issuer: env.issuers as [string, ...string[]] }) as jwt.JwtPayload;
    } catch {
      return null;
    }
    if (payload.nonce !== nonce || typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null;
    return { sub: payload.sub, email: payload.email.trim().toLowerCase().slice(0, 320), emailVerified: payload.email_verified === true, name: typeof payload.name === 'string' ? payload.name.slice(0, 100) : null };
  }

  /** Google's current signing keys as PEM, cached for an hour; refetched once for an unknown kid. */
  private async signingKey(env: ReturnType<typeof googleEnv>, kid: string, refresh: boolean): Promise<string | null> {
    if (refresh || !this.jwks || Date.now() - this.jwks.at > JWKS_TTL_MS) {
      const res = await fetch(env.jwksUrl, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const body = (await res.json()) as { keys?: Array<{ kid?: string; kty?: string } & Record<string, unknown>> };
      const keys = new Map<string, string>();
      for (const k of body.keys ?? []) {
        if (k.kty !== 'RSA' || typeof k.kid !== 'string') continue;
        try { keys.set(k.kid, createPublicKey({ key: k, format: 'jwk' }).export({ type: 'spki', format: 'pem' }).toString()); } catch { /* skip malformed key */ }
      }
      this.jwks = { at: Date.now(), keys };
    }
    return this.jwks.keys.get(kid) ?? null;
  }

  // ---------------------------------------------------------------- the three modes

  private async login(st: StatePayload, claims: IdClaims, meta: Meta): Promise<AuthUserRow> {
    const pool = this.prisma.getPool();
    const known = (await pool.query<{ org_id: string; user_id: string }>(`SELECT * FROM fn_lookup_oauth_identity('GOOGLE', $1)`, [claims.sub])).rows[0];
    if (known) {
      const user = await this.auth.loadAuthUser(known.org_id, known.user_id);
      if (!user) throw new GoogleFlowError('no_account');
      return user;
    }
    // Not linked yet: by verified e-mail address only, in the chosen (or the only) workspace.
    const workspaces = (await pool.query<{ org_id: string; name: string; slug: string; user_id: string; status: string }>(`SELECT * FROM fn_lookup_workspaces_for_email($1)`, [claims.email])).rows
      .filter((w) => w.status !== 'OFFBOARDED');
    const matches = st.workspace ? workspaces.filter((w) => w.slug === st.workspace) : workspaces;
    if (matches.length > 1) throw new GoogleFlowError('choose_workspace');
    if (matches.length === 1) {
      const m = matches[0]!;
      await this.prisma.runWithTenantContext(m.org_id, async (db) => {
        await this.linkIdentity(db, m.org_id, m.user_id, claims, meta);
      });
      const user = await this.auth.loadAuthUser(m.org_id, m.user_id);
      if (!user) throw new GoogleFlowError('no_account');
      return user;
    }
    // Nobody has this address: join by domain only where the owner switched it on.
    const org = (await pool.query<{ id: string; name: string; slug: string }>(`SELECT * FROM fn_lookup_org_by_sso_domain($1)`, [emailDomain(claims.email)])).rows[0];
    if (!org) throw new GoogleFlowError('no_account');
    const userId = await this.prisma.runWithTenantContext(org.id, async (db) => {
      const id = (await db.query<{ id: string }>(
        `INSERT INTO users (org_id, email, display_name, role, password_hash, status, email_verified_at) VALUES ($1, $2, $3, 'EMPLOYEE', NULL, 'ACTIVE', now()) RETURNING id`,
        [org.id, claims.email, claims.name ?? claims.email])).rows[0]!.id;
      await this.linkIdentity(db, org.id, id, claims, meta);
      await appendAuditEntry(db, { orgId: org.id, actorId: id, action: 'USER_JOINED_VIA_SSO', entityType: 'USER', entityId: id, after: { email: claims.email, role: 'EMPLOYEE', domain: emailDomain(claims.email) }, ip: meta.ip, userAgent: meta.userAgent });
      return id;
    });
    return (await this.auth.loadAuthUser(org.id, userId))!;
  }

  private async acceptInvitation(st: StatePayload, claims: IdClaims, meta: Meta): Promise<AuthUserRow> {
    const invite = (await this.prisma.getPool().query(`SELECT * FROM fn_lookup_invitation_for_signup($1)`, [sha256(st.inviteToken ?? '')])).rows[0] as
      { id: string; org_id: string; email: string; role: string; team_id: string | null; accepted_at: Date | null; revoked_at: Date | null; expires_at: Date } | undefined;
    if (!invite || invite.accepted_at || invite.revoked_at || new Date(invite.expires_at).getTime() < Date.now()) throw new GoogleFlowError('invitation_invalid');
    if (invite.email.toLowerCase() !== claims.email) throw new GoogleFlowError('email_mismatch');
    const userId = await this.prisma.runWithTenantContext(invite.org_id, async (db) => {
      const claimed = await db.query(`UPDATE invitations SET accepted_at = CURRENT_TIMESTAMP WHERE id = $1 AND accepted_at IS NULL RETURNING id`, [invite.id]);
      if (claimed.rowCount === 0) throw new GoogleFlowError('invitation_invalid');
      const id = (await db.query<{ id: string }>(
        `INSERT INTO users (org_id, email, display_name, role, team_id, password_hash, status, email_verified_at)
         VALUES ($1, $2, $3, $4, $5, NULL, 'ACTIVE', CURRENT_TIMESTAMP) RETURNING id`,
        [invite.org_id, invite.email, st.displayName ?? claims.name ?? invite.email, invite.role, invite.team_id])).rows[0]!.id;
      await this.linkIdentity(db, invite.org_id, id, claims, meta);
      await appendAuditEntry(db, { orgId: invite.org_id, actorId: id, action: 'USER_REGISTERED_VIA_INVITE', entityType: 'USER', entityId: id, after: { email: invite.email, role: invite.role, method: 'google' }, ip: meta.ip, userAgent: meta.userAgent });
      return id;
    });
    return (await this.auth.loadAuthUser(invite.org_id, userId))!;
  }

  private async signup(st: StatePayload, claims: IdClaims, meta: Meta): Promise<AuthUserRow> {
    const created = await this.workspaces.createWorkspace({
      workspaceName: st.workspaceName ?? 'My workspace', email: claims.email, displayName: st.displayName ?? claims.name ?? claims.email,
      passwordHash: null, emailVerified: true, meta,
      link: (db, orgId, userId) => this.linkIdentity(db, orgId, userId, claims, meta),
    });
    return (await this.auth.loadAuthUser(created.orgId, created.userId))!;
  }

  private async linkIdentity(db: pg.PoolClient, orgId: string, userId: string, claims: IdClaims, meta: Meta): Promise<void> {
    const res = await db.query(
      `INSERT INTO oauth_identities (org_id, user_id, provider, subject, email) VALUES ($1, $2, 'GOOGLE', $3, $4)
       ON CONFLICT (org_id, user_id, provider) DO NOTHING RETURNING id`,
      [orgId, userId, claims.sub, claims.email]);
    if (res.rowCount === 0) return;
    // Google verified the address: a pending self-service verification is satisfied too.
    await db.query(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`, [userId]);
    await appendAuditEntry(db, { orgId, actorId: userId, action: 'GOOGLE_IDENTITY_LINKED', entityType: 'USER', entityId: userId, after: { email: claims.email }, ip: meta.ip, userAgent: meta.userAgent });
  }

  // ---------------------------------------------------------------- finishing a login

  private async finish(web: string, st: StatePayload, user: AuthUserRow, meta: Meta): Promise<{ redirect: string; refreshToken?: string }> {
    if (user.status !== 'ACTIVE') {
      await this.auth.auditUser(user, 'LOGIN_REJECTED_INACTIVE', meta, { status: user.status, method: 'google' });
      return { redirect: this.resultUrl(web, st.mode, 'error', { code: 'account_inactive' }) };
    }
    const org = (await this.prisma.runWithTenantContext(user.org_id, async (db) =>
      (await db.query<{ mfa_for_sso: boolean }>(`SELECT mfa_for_sso FROM organizations WHERE id = $1`, [user.org_id])).rows[0]))!;
    const access = await this.resolver.resolve({ id: user.id, orgId: user.org_id }).catch(() => null);
    const needsMfa = requiresMfa(user.role, access?.permissions ?? []);
    if (org.mfa_for_sso && needsMfa && !user.mfa_enabled && mfaEnforced()) {
      return { redirect: this.resultUrl(web, st.mode, 'enroll', { returnTo: st.returnTo }, await this.auth.mfaEnrollmentToken(user, meta)) };
    }
    if (org.mfa_for_sso && user.mfa_enabled) {
      await this.auth.auditUser(user, '2FA_CHALLENGE_ISSUED', meta, { method: 'google' });
      const challenge = jwt.sign({ sub: user.id, orgId: user.org_id, returnTo: st.returnTo }, getJwtSecret(), { expiresIn: CHALLENGE_TTL_SECONDS, issuer: ISSUER, audience: AUD_CHALLENGE, algorithm: 'HS256' });
      return { redirect: this.resultUrl(web, 'login', 'totp', { returnTo: st.returnTo }, challenge) };
    }
    const session = await this.auth.issueSessionFor(user, meta, 'LOGIN_SUCCESS_GOOGLE');
    return { redirect: this.resultUrl(web, 'login', 'ok', { returnTo: st.returnTo }), refreshToken: session.refreshToken };
  }

  /** Second step for roles that need 2FA: the challenge token from the redirect plus the code. */
  async completeTotp(dto: GoogleTotpDto, meta: Meta) {
    let payload: { sub: string; orgId: string };
    try {
      payload = jwt.verify(dto.challengeToken, getJwtSecret(), { issuer: ISSUER, audience: AUD_CHALLENGE, algorithms: ['HS256'] }) as { sub: string; orgId: string };
    } catch {
      throw new UnauthorizedException('The sign-in challenge has expired. Start again.');
    }
    const user = await this.auth.loadAuthUser(payload.orgId, payload.sub);
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('Account is not active');
    if (!user.mfa_enabled) throw new BadRequestException('Two-factor authentication is not enabled for this account');
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      await this.auth.auditUser(user, 'LOGIN_LOCKED_ATTEMPT', meta);
      throw new UnauthorizedException('Account is locked due to too many failed attempts. Try again later.');
    }
    if (!(await this.auth.verifySecondFactor(user, dto.code, meta))) {
      await this.auth.registerFailedAttempt(user, '2FA_FAILED', meta, 'Invalid 2FA code or recovery code');
    }
    return await this.auth.issueSessionFor(user, meta, 'LOGIN_SUCCESS_GOOGLE');
  }
}

class GoogleFlowError extends Error {
  constructor(readonly code: GoogleResultCode) { super(code); this.name = 'GoogleFlowError'; }
}
