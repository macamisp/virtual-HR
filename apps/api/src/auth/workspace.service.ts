/**
 * Self-service workspaces (ADR 037; FR-AUTH-001 extended): anyone may create a workspace and
 * becomes its owner. The workspace cannot be signed into until the address is verified by the
 * e-mailed link. Rate limited (bucket `signup`), CAPTCHA-ready (CAPTCHA_PROVIDER) and, by default,
 * closed to disposable e-mail domains. Framework-free rules live in slugs/e-mail helpers below.
 */
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { MAIL_TRANSPORT } from '../common/mailer.ts';
import type { MailTransport } from '../common/mailer.ts';
import { ARGON2_OPTIONS, AuthService } from './auth.service.ts';
import type { ResendVerificationDto, SignupResponse, WorkspaceSignupDto } from '../../../../packages/shared/src/auth/workspace.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- CAPTCHA hook

export const CAPTCHA_VERIFIER = Symbol('CAPTCHA_VERIFIER');
export interface CaptchaVerifier {
  /** True when a provider is configured: signup then needs a valid captchaToken. */
  readonly required: boolean;
  verify(token: string | undefined, ip?: string): Promise<boolean>;
}

const CAPTCHA_VERIFY_URLS: Record<string, string> = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  hcaptcha: 'https://api.hcaptcha.com/siteverify',
  recaptcha: 'https://www.google.com/recaptcha/api/siteverify',
};

/** CAPTCHA_PROVIDER=turnstile|hcaptcha|recaptcha with CAPTCHA_SECRET; unset = no CAPTCHA (local demos). */
export function createCaptchaVerifier(env: Record<string, string | undefined> = process.env): CaptchaVerifier {
  const provider = (env.CAPTCHA_PROVIDER ?? '').trim().toLowerCase();
  if (!provider) return { required: false, verify: async () => true };
  const url = env.CAPTCHA_VERIFY_URL || CAPTCHA_VERIFY_URLS[provider];
  const secret = env.CAPTCHA_SECRET;
  if (!url) throw new Error(`CAPTCHA_PROVIDER must be one of ${Object.keys(CAPTCHA_VERIFY_URLS).join(', ')}`);
  if (!secret) throw new Error('CAPTCHA_SECRET must be set when CAPTCHA_PROVIDER is');
  return {
    required: true,
    async verify(token, ip) {
      if (!token) return false;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return false;
        const body = (await res.json()) as { success?: unknown };
        return body.success === true;
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------- e-mail and slug rules

/** Well-known throwaway mail providers; SIGNUP_BLOCKED_EMAIL_DOMAINS adds more. */
export const DISPOSABLE_EMAIL_DOMAINS: readonly string[] = [
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', '10minutemail.com', '10minutemail.net',
  'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'yopmail.com', 'yopmail.fr', 'trashmail.com', 'trashmail.me', 'getnada.com',
  'dispostable.com', 'maildrop.cc', 'mailnesia.com', 'throwawaymail.com', 'fakeinbox.com', 'mintemail.com', 'mohmal.com',
  'tempr.email', 'discard.email', 'spamgourmet.com', 'mailcatch.com', 'emailondeck.com', 'burnermail.io', 'inboxkitten.com',
  'tempail.com', 'mytemp.email', 'moakt.com', 'tmpmail.org', 'tmpmail.net', 'tempmailo.com', 'luxusmail.org', 'mail-temp.com',
];

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/** Null when allowed, otherwise the reason. */
export function disposableEmailProblem(email: string, env: Record<string, string | undefined> = process.env): string | null {
  if (env.SIGNUP_BLOCK_DISPOSABLE_EMAILS === 'false') return null;
  const extra = (env.SIGNUP_BLOCKED_EMAIL_DOMAINS ?? '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  const domain = emailDomain(email);
  const blocked = [...DISPOSABLE_EMAIL_DOMAINS, ...extra];
  if (blocked.some((d) => domain === d || domain.endsWith(`.${d}`))) return 'Disposable e-mail addresses cannot create a workspace. Use your work or personal address.';
  return null;
}

const RESERVED_SLUGS = new Set(['admin', 'api', 'www', 'app', 'login', 'signup', 'hrvo', 'help', 'support', 'status', 'mail']);

/** A URL-safe workspace address from its name: letters, digits and dashes, 2..60 characters. */
export function slugify(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  const slug = base.length >= 2 ? base : `workspace${base ? `-${base}` : ''}`;
  return RESERVED_SLUGS.has(slug) ? `${slug}-1` : slug;
}

interface Meta { ip?: string; userAgent?: string }

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    @Inject(MAIL_TRANSPORT) private readonly mailer: MailTransport,
    @Inject(CAPTCHA_VERIFIER) private readonly captcha: CaptchaVerifier,
  ) {}

  async signup(dto: WorkspaceSignupDto, meta: Meta): Promise<SignupResponse> {
    if (this.captcha.required && !(await this.captcha.verify(dto.captchaToken, meta.ip))) {
      throw new BadRequestException('The CAPTCHA could not be verified. Please try again.');
    }
    const disposable = disposableEmailProblem(dto.email);
    if (disposable) throw new BadRequestException(disposable);
    await this.auth.assertPasswordAcceptable(dto.password);
    const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);
    const base = slugify(dto.workspaceName);
    const orgId = randomUUID();

    let created: { slug: string; token: string } | null = null;
    for (let n = 1; n <= 30 && !created; n++) {
      const slug = n === 1 ? base : `${base}-${n}`;
      try {
        created = await this.prisma.runWithTenantContext(orgId, async (db) => {
          await db.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`, [orgId, dto.workspaceName, slug]);
          const user = (await db.query<{ id: string }>(
            `INSERT INTO users (org_id, email, display_name, role, is_owner, password_hash, status, email_verified_at)
             VALUES ($1, $2, $3, 'SUPER_ADMIN', true, $4, 'ACTIVE', NULL) RETURNING id`,
            [orgId, dto.email, dto.displayName, passwordHash],
          )).rows[0]!;
          const token = await this.issueVerification(db, orgId, user.id);
          await appendAuditEntry(db, {
            orgId, actorId: user.id, action: 'WORKSPACE_CREATED', entityType: 'ORGANIZATION', entityId: orgId,
            after: { name: dto.workspaceName, slug, ownerEmail: dto.email }, ip: meta.ip, userAgent: meta.userAgent,
          });
          return { slug, token };
        });
      } catch (err) {
        const e = err as { code?: string; constraint?: string };
        if (e.code === '23505' && (e.constraint ?? '').includes('slug')) continue;
        throw err;
      }
    }
    if (!created) throw new ConflictException('That workspace name is taken in too many variants; please choose another');
    await this.sendVerification(dto.email, dto.workspaceName, created.token);
    return {
      success: true,
      workspace: { name: dto.workspaceName, slug: created.slug },
      message: 'Check your e-mail for the verification link. The workspace opens once the address is verified.',
    };
  }

  /** The e-mailed link: single use, 24 hours, the newest one only. Returns {success}. */
  async verifyEmail(token: string, meta: Meta): Promise<{ success: true }> {
    const invalid = () => new BadRequestException('This verification link is invalid or has expired. Request a new one from the sign-in page.');
    const row = (await this.prisma.getPool().query<{ id: string; org_id: string; user_id: string; expires_at: Date; used_at: Date | null }>(
      `SELECT * FROM fn_lookup_email_verification($1)`, [sha256(token)])).rows[0];
    if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) throw invalid();
    const ok = await this.prisma.runWithTenantContext(row.org_id, async (db) => {
      const claim = await db.query(`UPDATE email_verification_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now() RETURNING id`, [row.id]);
      if (claim.rowCount === 0) return false;
      await db.query(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`, [row.user_id]);
      await appendAuditEntry(db, { orgId: row.org_id, actorId: row.user_id, action: 'EMAIL_VERIFIED', entityType: 'USER', entityId: row.user_id, ip: meta.ip, userAgent: meta.userAgent });
      return true;
    });
    if (!ok) throw invalid();
    return { success: true };
  }

  /** Always answers the same way, so it does not reveal whether an address or workspace exists. */
  async resendVerification(dto: ResendVerificationDto): Promise<{ success: true; message: string }> {
    const rows = (await this.prisma.getPool().query<{ org_id: string; name: string; slug: string; user_id: string; status: string }>(
      `SELECT * FROM fn_lookup_workspaces_for_email($1)`, [dto.email])).rows;
    for (const w of rows) {
      if (w.status !== 'ACTIVE' || (dto.workspace && w.slug !== dto.workspace)) continue;
      const token = await this.prisma.runWithTenantContext(w.org_id, async (db) => {
        const u = (await db.query<{ email_verified_at: Date | null }>(`SELECT email_verified_at FROM users WHERE id = $1`, [w.user_id])).rows[0];
        if (!u || u.email_verified_at) return null;
        return this.issueVerification(db, w.org_id, w.user_id);
      });
      if (token) await this.sendVerification(dto.email, w.name, token);
    }
    return { success: true, message: 'If the address needs verification, a new link has been sent.' };
  }

  private async issueVerification(db: pg.PoolClient, orgId: string, userId: string): Promise<string> {
    await db.query(`UPDATE email_verification_tokens SET expires_at = now() WHERE org_id = $1 AND user_id = $2 AND used_at IS NULL AND expires_at > now()`, [orgId, userId]);
    const token = randomBytes(32).toString('hex');
    await db.query(`INSERT INTO email_verification_tokens (org_id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
      [orgId, userId, sha256(token), new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS)]);
    return token;
  }

  private async sendVerification(to: string, workspaceName: string, token: string): Promise<void> {
    // The token travels in the URL fragment so it is not sent to servers or in Referer headers.
    const base = process.env.APP_WEB_URL || 'http://localhost:3000';
    await this.mailer.send({
      to,
      subject: `Verify your e-mail for ${workspaceName} on HRVO`,
      text: [
        `Welcome to HRVO. Confirm this address to open the workspace "${workspaceName}":`,
        '',
        `${base}/verify-email#token=${token}`,
        '',
        'The link works once and expires in 24 hours. If you did not create this workspace, ignore this e-mail.',
      ].join('\n'),
    });
  }
}
