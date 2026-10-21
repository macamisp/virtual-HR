import {
  Injectable,
  Inject,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
  NotFoundException,
} from '@nestjs/common';
import { AttendanceGateway } from '../attendance/attendance.gateway.ts';
import argon2 from 'argon2';
import { mfaEnforced } from '../common/config.ts';
import { generateSecret, generateURI } from 'otplib';
import { consumeTotpStep, totpStep } from './totp.ts';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import type { AuditEntry } from '../common/audit-chain.ts';
import { MAIL_TRANSPORT } from '../common/mailer.ts';
import type { MailTransport } from '../common/mailer.ts';
import {
  BREACHED_PASSWORD_CHECKER,
  BreachCheckUnavailableError,
} from './breached-password.ts';
import type { BreachedPasswordChecker } from './breached-password.ts';
import { signAccessToken, signMfaEnrollmentToken } from './tokens.ts';
import {
  hasPermission,
  userCan,
  isMfaRequiredRole,
  Permission,
} from '../../../../packages/shared/src/auth/types.ts';
import type {
  LoginDto,
  InviteUserDto,
  SignupInvitationDto,
  AuthenticatedUser,
} from '../../../../packages/shared/src/index.ts';

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 4,
} as const;

const MAX_FAILED_LOGINS = 5; // FR-AUTH-007
const LOCKOUT_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // FR-AUTH-003
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000; // FR-AUTH-008

/** Why an auth_sessions row was revoked. ROTATED is a normal refresh and does not end the login. */
export type RevokeReason = 'ROTATED' | 'LOGOUT' | 'FAMILY_REUSE' | 'PASSWORD_RESET' | 'USER_DEACTIVATED' | 'DEVICE_REVOKED' | 'ADMIN_REVOKED';

interface AuthUserRow {
  id: string;
  org_id: string;
  email: string;
  display_name: string | null;
  role: string;
  team_id: string | null;
  status: string;
  password_hash: string | null;
  mfa_enabled: boolean;
  mfa_secret: string | null;
  failed_login_attempts: number;
  locked_until: Date | null;
}

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  // Verified against when the email is unknown, so response time does not reveal account existence.
  private dummyHashPromise: Promise<string> | null = null;

  constructor(
    private prisma: PrismaService,
    @Inject(BREACHED_PASSWORD_CHECKER) private breachChecker: BreachedPasswordChecker,
    @Inject(MAIL_TRANSPORT) private mailer: MailTransport,
    private readonly attendance: AttendanceGateway,
  ) {}

  /**
   * FR-AUTH-002: minimum 12 characters and not present in a breach corpus (k-anonymity).
   * Fails closed: if the breach service cannot be reached the password is not accepted.
   */
  private async assertPasswordAcceptable(password: string): Promise<void> {
    if (password.length < 12) {
      throw new BadRequestException('Password must be at least 12 characters long');
    }
    let breached: boolean;
    try {
      breached = await this.breachChecker.isBreached(password);
    } catch (err) {
      if (err instanceof BreachCheckUnavailableError) {
        throw new ServiceUnavailableException('Password safety check is temporarily unavailable; please try again');
      }
      throw err;
    }
    if (breached) {
      throw new BadRequestException('Password has been found in a data breach list; please choose a stronger password');
    }
  }

  /**
   * FR-AUTH-001: Invitation-only signup
   * An Admin or HR Manager creates an invitation expiring in 7 days.
   */
  async createInvitation(
    inviter: AuthenticatedUser,
    dto: InviteUserDto,
    ip?: string,
    userAgent?: string,
  ) {
    if (!hasPermission(inviter.role, Permission.USERS_INVITE)) {
      throw new ForbiddenException('Permission denied: cannot invite users');
    }

    const inviteToken = randomBytes(32).toString('hex');
    const tokenHash = sha256(inviteToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    return await this.prisma.runWithTenantContext(inviter.orgId, async (client) => {
      const existing = await client.query(
        'SELECT id FROM users WHERE org_id = $1 AND email = $2',
        [inviter.orgId, dto.email.toLowerCase()],
      );
      if (existing.rows.length > 0) {
        throw new BadRequestException('A user with this email already exists in the organization');
      }

      const res = await client.query(
        `INSERT INTO invitations (org_id, email, role, team_id, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, org_id, email, role, expires_at, created_at`,
        [
          inviter.orgId,
          dto.email.toLowerCase(),
          dto.role,
          dto.teamId || null,
          tokenHash,
          inviter.id,
          expiresAt,
        ],
      );

      await this.recordAudit(client, {
        orgId: inviter.orgId,
        actorId: inviter.id,
        action: 'INVITATION_CREATED',
        entityType: 'INVITATION',
        entityId: res.rows[0].id,
        after: { email: dto.email, role: dto.role, expiresAt },
        ip,
        userAgent,
      });

      return {
        id: res.rows[0].id,
        inviteToken, // Return the raw token so it can be emailed / copied
        email: res.rows[0].email,
        role: res.rows[0].role,
        expiresAt: res.rows[0].expires_at,
      };
    });
  }

  /**
   * Accept an invitation and register an account with Argon2id password (FR-AUTH-001, FR-AUTH-002)
   */
  async acceptInvitation(
    dto: SignupInvitationDto,
    ip?: string,
    userAgent?: string,
  ) {
    await this.assertPasswordAcceptable(dto.password);

    const tokenHash = sha256(dto.inviteToken);
    const pool = this.prisma.getPool();

    const inviteRes = await pool.query(
      `SELECT * FROM fn_lookup_invitation_for_signup($1)`,
      [tokenHash],
    );

    if (inviteRes.rows.length === 0) {
      throw new BadRequestException('Invalid invitation token');
    }

    const invite = inviteRes.rows[0];
    if (invite.accepted_at) {
      throw new BadRequestException('Invitation has already been accepted');
    }

    if (new Date(invite.expires_at).getTime() < Date.now()) {
      throw new BadRequestException('Invitation token has expired');
    }

    const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);

    return await this.prisma.runWithTenantContext(invite.org_id, async (client) => {
      // Single-use: claim the invitation atomically before creating the user.
      const claimed = await client.query(
        `UPDATE invitations SET accepted_at = CURRENT_TIMESTAMP WHERE id = $1 AND accepted_at IS NULL RETURNING id`,
        [invite.id],
      );
      if (claimed.rowCount === 0) {
        throw new BadRequestException('Invitation has already been accepted');
      }

      const userRes = await client.query(
        `INSERT INTO users (org_id, email, display_name, role, team_id, password_hash, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')
         RETURNING id, org_id, email, display_name, role, created_at`,
        [
          invite.org_id,
          invite.email,
          dto.displayName,
          invite.role,
          invite.team_id,
          passwordHash,
        ],
      );
      const newUser = userRes.rows[0];

      await this.recordAudit(client, {
        orgId: invite.org_id,
        actorId: newUser.id,
        action: 'USER_REGISTERED_VIA_INVITE',
        entityType: 'USER',
        entityId: newUser.id,
        after: { email: newUser.email, role: newUser.role },
        ip,
        userAgent,
      });

      return {
        success: true,
        user: {
          id: newUser.id,
          orgId: newUser.org_id,
          email: newUser.email,
          displayName: newUser.display_name,
          role: newUser.role,
        },
      };
    });
  }

  /**
   * Login with email, password, and TOTP 2FA (FR-AUTH-002, 003, 004, 007, 011)
   */
  async login(dto: LoginDto, ip?: string, userAgent?: string) {
    const meta: RequestMeta = { ip, userAgent };
    const pool = this.prisma.getPool();

    const userRes = await pool.query<AuthUserRow>(
      `SELECT * FROM fn_lookup_user_for_auth($1)`,
      [dto.email.toLowerCase()],
    );

    if (userRes.rows.length === 0) {
      // No tenant to attribute an audit entry to; equalise timing instead.
      await argon2.verify(await this.getDummyHash(), dto.password).catch(() => false);
      throw new UnauthorizedException('Invalid email or password');
    }

    const user = userRes.rows[0];

    // FR-AUTH-007: 5 failed attempts -> 15 min lockout
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      await this.auditUser(user, 'LOGIN_LOCKED_ATTEMPT', meta);
      throw new UnauthorizedException('Account is locked due to too many failed attempts. Try again later.');
    }

    if (!user.password_hash) {
      await this.auditUser(user, 'LOGIN_FAILED', meta, { reason: 'NO_PASSWORD_SET' });
      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = await argon2.verify(user.password_hash, dto.password);
    if (!isPasswordValid) {
      await this.registerFailedAttempt(user, 'LOGIN_FAILED', meta);
    }

    if (user.status !== 'ACTIVE') {
      await this.auditUser(user, 'LOGIN_REJECTED_INACTIVE', meta, { status: user.status });
      throw new UnauthorizedException('Account is not active');
    }

    if (user.mfa_enabled) {
      if (!dto.totpCode) {
        await this.auditUser(user, '2FA_CHALLENGE_ISSUED', meta);
        return {
          requires2fa: true,
          userId: user.id,
          message: 'Two-factor authentication code required',
        };
      }

      // FR-AUTH-004: a code works once (a later step than the last one used).
      const step = user.mfa_secret ? totpStep(user.mfa_secret, dto.totpCode) : null;
      const isValidToken = step !== null && await this.prisma.runWithTenantContext(user.org_id, (client) => consumeTotpStep(client, user.id, step));
      let recoveryUsed = false;
      if (!isValidToken) {
        recoveryUsed = await this.consumeRecoveryCode(user, dto.totpCode, meta);
      }
      if (!isValidToken && !recoveryUsed) {
        await this.registerFailedAttempt(user, '2FA_FAILED', meta, 'Invalid 2FA code or recovery code');
      }
    } else if (isMfaRequiredRole(user.role) && mfaEnforced()) {
      // FR-AUTH-004: no full access token until TOTP is enrolled and verified.
      await this.auditUser(user, '2FA_ENROLLMENT_REQUIRED', meta);
      return {
        requires2faSetup: true,
        userId: user.id,
        enrollmentToken: signMfaEnrollmentToken({
          sub: user.id,
          orgId: user.org_id,
          email: user.email,
          role: user.role as AuthenticatedUser['role'],
          displayName: user.display_name ?? undefined,
          teamId: user.team_id,
        }),
        message: 'Two-factor authentication is mandatory for this role. Please set up 2FA to complete login.',
      };
    }

    return await this.prisma.runWithTenantContext(user.org_id, async (client) => {
      await client.query(
        `UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`,
        [user.id],
      );
      return await this.issueSession(client, user, meta, 'LOGIN_SUCCESS');
    });
  }

  private async getDummyHash(): Promise<string> {
    if (!this.dummyHashPromise) {
      this.dummyHashPromise = argon2.hash(randomBytes(16).toString('hex'), ARGON2_OPTIONS);
    }
    return this.dummyHashPromise;
  }

  /** Counts a failed password or 2FA attempt toward lockout, audits it, and throws 401. */
  private async registerFailedAttempt(
    user: AuthUserRow,
    action: 'LOGIN_FAILED' | '2FA_FAILED',
    meta: RequestMeta,
    message = 'Invalid email or password',
  ): Promise<never> {
    const attempts = await this.prisma.runWithTenantContext(user.org_id, async (client) => {
      const res = await client.query<{ failed_login_attempts: number }>(
        `UPDATE users
         SET failed_login_attempts = failed_login_attempts + 1,
             locked_until = CASE WHEN failed_login_attempts + 1 >= $2 THEN $3::timestamptz ELSE locked_until END
         WHERE id = $1
         RETURNING failed_login_attempts`,
        [user.id, MAX_FAILED_LOGINS, new Date(Date.now() + LOCKOUT_MS)],
      );
      const count = res.rows[0]?.failed_login_attempts ?? MAX_FAILED_LOGINS;
      await this.recordAudit(client, {
        orgId: user.org_id,
        actorId: user.id,
        action: count >= MAX_FAILED_LOGINS ? 'ACCOUNT_LOCKED' : action,
        entityType: 'USER',
        entityId: user.id,
        after: { attempts: count, trigger: action },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return count;
    });

    if (attempts >= MAX_FAILED_LOGINS) {
      throw new UnauthorizedException('Account locked for 15 minutes due to 5 consecutive failed logins');
    }
    throw new UnauthorizedException(message);
  }

  /** Atomically consumes a hashed recovery code (single use). */
  private async consumeRecoveryCode(user: AuthUserRow, code: string, meta: RequestMeta): Promise<boolean> {
    const hashedCode = sha256(code);
    return await this.prisma.runWithTenantContext(user.org_id, async (client) => {
      const res = await client.query(
        `UPDATE users SET mfa_recovery_codes = array_remove(mfa_recovery_codes, $1)
         WHERE id = $2 AND $1 = ANY(mfa_recovery_codes)
         RETURNING cardinality(mfa_recovery_codes) AS remaining`,
        [hashedCode, user.id],
      );
      if (res.rowCount === 0) return false;
      await this.recordAudit(client, {
        orgId: user.org_id,
        actorId: user.id,
        action: '2FA_RECOVERY_CODE_USED',
        entityType: 'USER',
        entityId: user.id,
        after: { remaining: res.rows[0].remaining },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return true;
    });
  }

  /** Creates a new login (session family), its heartbeat HMAC secret and an access token. */
  private async issueSession(
    client: pg.PoolClient,
    user: Pick<AuthUserRow, 'id' | 'org_id' | 'email' | 'display_name' | 'role' | 'team_id'>,
    meta: RequestMeta,
    auditAction: string,
  ) {
    const sessionId = randomUUID();
    const familyId = randomUUID();
    const refreshToken = randomBytes(32).toString('hex');

    await client.query(
      `INSERT INTO auth_sessions (id, org_id, user_id, family_id, refresh_token_hash, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        sessionId,
        user.org_id,
        user.id,
        familyId,
        sha256(refreshToken),
        new Date(Date.now() + REFRESH_TTL_MS),
        meta.ip || null,
        meta.userAgent || null,
      ],
    );

    const sessionSecret = randomBytes(32).toString('hex');
    await client.query(
      `INSERT INTO session_secrets (session_id, org_id, secret) VALUES ($1, $2, $3)`,
      [sessionId, user.org_id, sessionSecret],
    );

    const accessToken = signAccessToken({
      sub: user.id,
      orgId: user.org_id,
      email: user.email,
      role: user.role as AuthenticatedUser['role'],
      displayName: user.display_name ?? undefined,
      teamId: user.team_id,
      sid: sessionId,
    });

    await this.recordAudit(client, {
      orgId: user.org_id,
      actorId: user.id,
      action: auditAction,
      entityType: 'SESSION',
      entityId: sessionId,
      after: { role: user.role, ip: meta.ip },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      accessToken,
      refreshToken,
      sessionId,
      familyId,
      sessionSecret,
      user: {
        id: user.id,
        orgId: user.org_id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
      },
    };
  }

  /** ADR 018: a desktop agent's own login, created when a pairing code is redeemed (same audit as a login). */
  async issueAgentSession(
    client: pg.PoolClient,
    user: Pick<AuthUserRow, 'id' | 'org_id' | 'email' | 'display_name' | 'role' | 'team_id'>,
    meta: RequestMeta,
  ) {
    return await this.issueSession(client, user, meta, 'AGENT_PAIRED_LOGIN');
  }

  /** ADR 018: revoking a desktop agent revokes its session family (sockets are dropped via hrvo_auth_events). */
  async revokeFamily(client: pg.PoolClient, orgId: string, familyId: string): Promise<number> {
    return await this.revokeSessions(client, orgId, { familyId }, 'DEVICE_REVOKED');
  }

  /**
   * Revokes every still-valid session in a family (or of a user). Rows already revoked for a
   * non-rotation reason keep their original reason. Fires the hrvo_auth_events trigger.
   */
  private async revokeSessions(
    client: pg.PoolClient,
    orgId: string,
    scope: { familyId: string } | { userId: string },
    reason: Exclude<RevokeReason, 'ROTATED'>,
  ): Promise<number> {
    const [column, value] = 'familyId' in scope ? ['family_id', scope.familyId] : ['user_id', scope.userId];
    const res = await client.query(
      `UPDATE auth_sessions
       SET is_revoked = true, revoked_reason = $3, updated_at = CURRENT_TIMESTAMP
       WHERE org_id = $1 AND ${column} = $2
         AND (NOT is_revoked OR revoked_reason IS NULL OR revoked_reason = 'ROTATED')
       RETURNING id`,
      [orgId, value, reason],
    );
    await client.query(
      `DELETE FROM session_secrets
       WHERE org_id = $1 AND session_id IN (SELECT id::text FROM auth_sessions WHERE org_id = $1 AND ${column} = $2)`,
      [orgId, value],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Refresh Token with Reuse Detection (FR-AUTH-003)
   * Rotating refresh tokens (7 days). Presenting an already-rotated token revokes the whole family.
   */
  async refresh(refreshToken: string, ip?: string, userAgent?: string) {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }
    const meta: RequestMeta = { ip, userAgent };

    const sessionRes = await this.prisma.getPool().query(
      `SELECT * FROM fn_lookup_session_for_refresh($1)`,
      [sha256(refreshToken)],
    );

    if (sessionRes.rows.length === 0) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const session = sessionRes.rows[0];

    if (session.is_revoked) {
      if (session.revoked_reason === 'ROTATED' || session.revoked_reason === null) {
        await this.handleRefreshReuse(session, meta);
      }
      throw new UnauthorizedException('Session has been revoked');
    }

    if (new Date(session.expires_at).getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token has expired');
    }

    if (session.user_status !== 'ACTIVE') {
      await this.prisma.runWithTenantContext(session.org_id, async (client) => {
        await this.revokeSessions(client, session.org_id, { familyId: session.family_id }, 'USER_DEACTIVATED');
        await this.recordAudit(client, {
          orgId: session.org_id,
          actorId: session.user_id,
          action: 'REFRESH_REJECTED_INACTIVE',
          entityType: 'SESSION_FAMILY',
          entityId: session.family_id,
          after: { status: session.user_status },
          ip,
          userAgent,
        });
      });
      throw new UnauthorizedException('Account is not active');
    }

    const rotated = await this.prisma.runWithTenantContext(session.org_id, async (client) => {
      // Atomic claim: a concurrent refresh with the same token loses and is treated as reuse.
      const claim = await client.query(
        `UPDATE auth_sessions SET is_revoked = true, revoked_reason = 'ROTATED', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND NOT is_revoked RETURNING id`,
        [session.id],
      );
      if (claim.rowCount === 0) return null;

      const newSessionId = randomUUID();
      const newRefreshToken = randomBytes(32).toString('hex');

      await client.query(
        `INSERT INTO auth_sessions (id, org_id, user_id, family_id, refresh_token_hash, expires_at, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          newSessionId,
          session.org_id,
          session.user_id,
          session.family_id,
          sha256(newRefreshToken),
          new Date(Date.now() + REFRESH_TTL_MS),
          ip || null,
          userAgent || null,
        ],
      );

      const newSessionSecret = randomBytes(32).toString('hex');
      await client.query(
        `INSERT INTO session_secrets (session_id, org_id, secret) VALUES ($1, $2, $3)`,
        [newSessionId, session.org_id, newSessionSecret],
      );

      const accessToken = signAccessToken({
        sub: session.user_id,
        orgId: session.org_id,
        email: session.email,
        role: session.role,
        displayName: session.display_name ?? undefined,
        teamId: session.team_id,
        sid: newSessionId,
      });

      await this.recordAudit(client, {
        orgId: session.org_id,
        actorId: session.user_id,
        action: 'TOKEN_ROTATED',
        entityType: 'SESSION',
        entityId: newSessionId,
        ip,
        userAgent,
      });

      return {
        accessToken,
        refreshToken: newRefreshToken,
        sessionId: newSessionId,
        familyId: session.family_id as string,
        sessionSecret: newSessionSecret,
        user: {
          id: session.user_id,
          orgId: session.org_id,
          email: session.email,
          displayName: session.display_name,
          role: session.role,
        },
      };
    });

    if (!rotated) {
      await this.handleRefreshReuse(session, meta);
      throw new UnauthorizedException('Session has been revoked');
    }
    return rotated;
  }

  private async handleRefreshReuse(
    session: { org_id: string; user_id: string; family_id: string; id: string },
    meta: RequestMeta,
  ): Promise<never> {
    await this.prisma.runWithTenantContext(session.org_id, async (client) => {
      await this.revokeSessions(client, session.org_id, { familyId: session.family_id }, 'FAMILY_REUSE');
      await this.recordAudit(client, {
        orgId: session.org_id,
        actorId: session.user_id,
        action: 'REFRESH_TOKEN_REUSE_DETECTED',
        entityType: 'SESSION_FAMILY',
        entityId: session.family_id,
        after: { revokedSessionId: session.id, ip: meta.ip },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    });
    throw new UnauthorizedException('Refresh token reuse detected. All active sessions in this family have been revoked.');
  }

  /**
   * Start TOTP enrollment (FR-AUTH-004). Refused once 2FA is enabled, so a stolen access
   * token cannot silently replace the user's authenticator.
   */
  async setup2fa(user: AuthenticatedUser, ip?: string, userAgent?: string) {
    const secret = generateSecret();
    const otpauthUrl = generateURI({ secret, label: user.email, issuer: 'HRVO' });

    await this.prisma.runWithTenantContext(user.orgId, async (client) => {
      const res = await client.query(
        `UPDATE users SET mfa_secret = $1 WHERE id = $2 AND org_id = $3 AND NOT mfa_enabled RETURNING id`,
        [secret, user.id, user.orgId],
      );
      if (res.rowCount === 0) {
        throw new BadRequestException('Two-factor authentication is already enabled');
      }
      await this.recordAudit(client, {
        orgId: user.orgId,
        actorId: user.id,
        action: '2FA_SETUP_STARTED',
        entityType: 'USER',
        entityId: user.id,
        ip,
        userAgent,
      });
    });

    return { secret, otpauthUrl };
  }

  /**
   * Verify and enable TOTP 2FA, returning 10 recovery codes (FR-AUTH-004).
   * When called with an MFA-enrollment token, also completes the login by issuing a full session.
   */
  async verifyAndEnable2fa(
    user: AuthenticatedUser,
    code: string,
    ip?: string,
    userAgent?: string,
  ) {
    const meta: RequestMeta = { ip, userAgent };
    return await this.prisma.runWithTenantContext(user.orgId, async (client) => {
      const res = await client.query<AuthUserRow>(
        `SELECT * FROM users WHERE id = $1 AND org_id = $2`,
        [user.id, user.orgId],
      );
      const row = res.rows[0];
      if (!row || !row.mfa_secret) {
        throw new BadRequestException('2FA setup has not been initiated');
      }
      if (row.mfa_enabled) {
        throw new BadRequestException('Two-factor authentication is already enabled');
      }
      if (row.status !== 'ACTIVE') {
        throw new UnauthorizedException('Account is not active');
      }

      const step = totpStep(row.mfa_secret, code);
      if (step === null || !(await consumeTotpStep(client, user.id, step))) {
        await this.recordAudit(client, {
          orgId: user.orgId,
          actorId: user.id,
          action: '2FA_VERIFY_FAILED',
          entityType: 'USER',
          entityId: user.id,
          ip,
          userAgent,
        });
        // Commit the audit entry, then reject.
        return { failed: true as const };
      }

      const plainRecoveryCodes: string[] = [];
      const hashedRecoveryCodes: string[] = [];
      for (let i = 0; i < 10; i++) {
        const plain = randomBytes(5).toString('hex'); // 10 chars
        plainRecoveryCodes.push(plain);
        hashedRecoveryCodes.push(sha256(plain));
      }

      await client.query(
        `UPDATE users SET mfa_enabled = true, mfa_recovery_codes = $1 WHERE id = $2`,
        [hashedRecoveryCodes, user.id],
      );

      await this.recordAudit(client, {
        orgId: user.orgId,
        actorId: user.id,
        action: '2FA_ENABLED',
        entityType: 'USER',
        entityId: user.id,
        ip,
        userAgent,
      });

      const session = user.tokenType === 'mfa_enroll'
        ? await this.issueSession(client, row, meta, 'LOGIN_SUCCESS_AFTER_2FA_ENROLLMENT')
        : null;

      return { success: true, recoveryCodes: plainRecoveryCodes, ...(session ?? {}) };
    }).then((result) => {
      if ('failed' in result) {
        throw new BadRequestException('Invalid 2FA verification code');
      }
      return result;
    });
  }

  /** FR-ATT-002: administrative session revocation has the same attendance guarantee as logout. */
  async revokeSession(user: AuthenticatedUser, sessionId: string, ip?: string, userAgent?: string) {
    if (!userCan(user, Permission.USERS_MANAGE)) throw new ForbiddenException('Cannot revoke sessions');
    const target = await this.prisma.runWithTenantContext(user.orgId, async (client) => {
      const row = (await client.query<{ user_id: string; family_id: string }>(
        `SELECT user_id, family_id FROM auth_sessions WHERE org_id = $1 AND id = $2`, [user.orgId, sessionId])).rows[0];
      if (!row) throw new NotFoundException('Session not found');
      await this.revokeSessions(client, user.orgId, { familyId: row.family_id }, 'ADMIN_REVOKED');
      await this.recordAudit(client, { orgId: user.orgId, actorId: user.id, action: 'SESSION_REVOKED', entityType: 'SESSION', entityId: sessionId,
        after: { userId: row.user_id }, ip, userAgent });
      return row;
    });
    await this.attendance.closeAttendanceOnRevocation(user.orgId, target.user_id, target.family_id);
    return { success: true };
  }

  /**
   * Logout (FR-AUTH-003, FR-AUTH-011): ends the caller's own login, i.e. the whole session
   * family of the access token's session id. The session id is taken from the verified
   * token, never from the request body.
   */
  async logout(
    user: AuthenticatedUser,
    ip?: string,
    userAgent?: string,
  ) {
    if (!user.sessionId) {
      throw new UnauthorizedException('Access token has no session');
    }
    const familyId = await this.prisma.runWithTenantContext(user.orgId, async (client) => {
      const fam = await client.query<{ family_id: string }>(
        `SELECT family_id FROM auth_sessions WHERE id = $1 AND org_id = $2 AND user_id = $3`,
        [user.sessionId, user.orgId, user.id],
      );
      if (fam.rows.length === 0) {
        throw new UnauthorizedException('Session not found');
      }
      await this.revokeSessions(client, user.orgId, { familyId: fam.rows[0].family_id }, 'LOGOUT');

      await this.recordAudit(client, {
        orgId: user.orgId,
        actorId: user.id,
        action: 'LOGOUT',
        entityType: 'SESSION',
        entityId: user.sessionId as string,
        ip,
        userAgent,
      });

      return fam.rows[0].family_id;
    });
    await this.attendance.closeAttendanceOnRevocation(user.orgId, user.id, familyId);
    return { success: true };
  }

  /**
   * FR-AUTH-008: email a single-use reset link valid for 30 minutes. Always returns the same
   * response so the endpoint does not reveal whether an account exists.
   */
  async requestPasswordReset(email: string, ip?: string, userAgent?: string) {
    const users = await this.prisma.getPool().query<AuthUserRow>(
      `SELECT * FROM fn_lookup_user_for_auth($1)`,
      [email.toLowerCase()],
    );

    for (const user of users.rows) {
      if (user.status !== 'ACTIVE') continue;

      const token = randomBytes(32).toString('hex');
      await this.prisma.runWithTenantContext(user.org_id, async (client) => {
        // Only the newest link is valid.
        await client.query(
          `UPDATE password_reset_tokens SET expires_at = CURRENT_TIMESTAMP
           WHERE org_id = $1 AND user_id = $2 AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
          [user.org_id, user.id],
        );
        const res = await client.query<{ id: string }>(
          `INSERT INTO password_reset_tokens (org_id, user_id, token_hash, expires_at, requested_ip)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [user.org_id, user.id, sha256(token), new Date(Date.now() + PASSWORD_RESET_TTL_MS), ip || null],
        );
        await this.recordAudit(client, {
          orgId: user.org_id,
          actorId: user.id,
          action: 'PASSWORD_RESET_REQUESTED',
          entityType: 'PASSWORD_RESET',
          entityId: res.rows[0].id,
          ip,
          userAgent,
        });
      });

      // The token travels in the URL fragment so it is not sent to servers or in Referer headers.
      const base = process.env.APP_WEB_URL || 'http://localhost:3000';
      await this.mailer.send({
        to: user.email,
        subject: 'Reset your HRVO password',
        text: [
          'A password reset was requested for your HRVO account.',
          '',
          `Reset link (valid for 30 minutes, single use): ${base}/reset-password#token=${token}`,
          '',
          'If you did not request this, you can ignore this email. Resetting signs you out everywhere.',
        ].join('\n'),
      });
    }

    return { success: true, message: 'If the account exists, a reset link has been sent.' };
  }

  /**
   * FR-AUTH-008: consume a reset token (single use, 30 min), set the new password and
   * revoke all of the user's sessions (which also disconnects their sockets).
   */
  async resetPassword(token: string, newPassword: string, ip?: string, userAgent?: string) {
    // Validate the new password first so a rejected password does not burn the link.
    await this.assertPasswordAcceptable(newPassword);

    const tokenHash = sha256(token);
    const lookup = await this.prisma.getPool().query(
      `SELECT * FROM fn_lookup_password_reset($1)`,
      [tokenHash],
    );
    const row = lookup.rows[0];
    const invalid = () => new BadRequestException('Reset link is invalid or has expired');
    if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now() || row.user_status !== 'ACTIVE') {
      throw invalid();
    }

    const passwordHash = await argon2.hash(newPassword, ARGON2_OPTIONS);

    const ok = await this.prisma.runWithTenantContext(row.org_id, async (client) => {
      const claim = await client.query(
        `UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND used_at IS NULL AND expires_at > $2 RETURNING id`,
        [row.id, new Date()],
      );
      if (claim.rowCount === 0) return false;

      await client.query(
        `UPDATE users SET password_hash = $1, failed_login_attempts = 0, locked_until = NULL WHERE id = $2`,
        [passwordHash, row.user_id],
      );
      await client.query(
        `UPDATE password_reset_tokens SET expires_at = CURRENT_TIMESTAMP
         WHERE org_id = $1 AND user_id = $2 AND used_at IS NULL`,
        [row.org_id, row.user_id],
      );
      const revoked = await this.revokeSessions(client, row.org_id, { userId: row.user_id }, 'PASSWORD_RESET');

      await this.recordAudit(client, {
        orgId: row.org_id,
        actorId: row.user_id,
        action: 'PASSWORD_RESET_COMPLETED',
        entityType: 'PASSWORD_RESET',
        entityId: row.id,
        after: { sessionsRevoked: revoked },
        ip,
        userAgent,
      });
      return true;
    });

    if (!ok) throw invalid();
    await this.attendance.closeAttendanceOnRevocation(row.org_id, row.user_id, null);
    return { success: true };
  }

  private async auditUser(user: AuthUserRow, action: string, meta: RequestMeta, after?: Record<string, unknown>) {
    await this.prisma.runWithTenantContext(user.org_id, async (client) => {
      await this.recordAudit(client, {
        orgId: user.org_id,
        actorId: user.id,
        action,
        entityType: 'USER',
        entityId: user.id,
        after,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    });
  }

  /** Records an entry into the append-only, hash-chained audit_logs table (FR-AUD-001). */
  private async recordAudit(client: pg.PoolClient, entry: AuditEntry) {
    await appendAuditEntry(client, entry);
  }
}
