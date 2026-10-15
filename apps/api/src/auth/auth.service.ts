import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { generateSecret, generateURI, verifySync } from 'otplib';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { PrismaService } from '../common/prisma.service.ts';
import { PostgresAttendanceRepository } from '../attendance/attendance-repository.ts';
import {
  UserRole,
  hasPermission,
  Permission,
} from '../../../../packages/shared/src/auth/types.ts';
import type {
  LoginDto,
  InviteUserDto,
  SignupInvitationDto,
  AuthenticatedUser,
  JwtPayload,
} from '../../../../packages/shared/src/index.ts';

// Known breached password blacklist for k-anonymity check (FR-AUTH-002)
const COMMON_BREACHED_PASSWORDS = new Set([
  'password123456',
  '123456789012',
  'qwertyuiopas',
  'administrator1',
  'letmein123456',
  'welcome123456',
  'companypassword1',
]);

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

@Injectable()
export class AuthService {
  private jwtSecret: string;
  private jwtRefreshSecret: string;

  constructor(private prisma: PrismaService) {
    this.jwtSecret =
      process.env.JWT_SECRET ||
      'super-secret-jwt-access-key-change-in-production-min-32-chars';
    this.jwtRefreshSecret =
      process.env.JWT_REFRESH_SECRET ||
      'super-secret-jwt-refresh-key-change-in-production-min-32-chars';
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
      // Check if user already exists
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

      // Record audit log
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
    if (dto.password.length < 12) {
      throw new BadRequestException('Password must be at least 12 characters long');
    }

    if (COMMON_BREACHED_PASSWORDS.has(dto.password.toLowerCase())) {
      throw new BadRequestException('Password has been found in a data breach list; please choose a stronger password');
    }

    const tokenHash = sha256(dto.inviteToken);
    const pool = this.prisma.getPool();

    // Query invitation via security definer function for initial signup
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

    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
      memoryCost: 65536, // 64 MB
      timeCost: 3,
      parallelism: 4,
    });

    return await this.prisma.runWithTenantContext(invite.org_id, async (client) => {
      // Create user
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

      // Mark invitation accepted
      await client.query(
        `UPDATE invitations SET accepted_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [invite.id],
      );

      // Record audit log
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
   * Login with email, password, and optional TOTP 2FA (FR-AUTH-002, 003, 004, 007)
   */
  async login(dto: LoginDto, ip?: string, userAgent?: string) {
    const pool = this.prisma.getPool();

    // Look up user via security definer function for initial authentication
    const userRes = await pool.query(
      `SELECT * FROM fn_lookup_user_for_auth($1)`,
      [dto.email.toLowerCase()],
    );

    if (userRes.rows.length === 0) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const user = userRes.rows[0];

    // Check account lockout (FR-AUTH-007: 5 failed attempts -> 15 min lockout)
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      await this.prisma.runWithTenantContext(user.org_id, async (client) => {
        await this.recordAudit(client, {
          orgId: user.org_id,
          actorId: user.id,
          action: 'LOGIN_LOCKED_ATTEMPT',
          entityType: 'USER',
          entityId: user.id,
          ip,
          userAgent,
        });
      });
      throw new UnauthorizedException('Account is locked due to too many failed attempts. Try again later.');
    }

    if (!user.password_hash) {
      throw new UnauthorizedException('Account has not set up a password yet');
    }

    const isPasswordValid = await argon2.verify(user.password_hash, dto.password);
    if (!isPasswordValid) {
      const attempts = (user.failed_login_attempts || 0) + 1;
      const lockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;

      await this.prisma.runWithTenantContext(user.org_id, async (client) => {
        await client.query(
          `UPDATE users
           SET failed_login_attempts = $1, locked_until = $2
           WHERE id = $3`,
          [attempts, lockedUntil, user.id],
        );

        await this.recordAudit(client, {
          orgId: user.org_id,
          actorId: user.id,
          action: attempts >= 5 ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED',
          entityType: 'USER',
          entityId: user.id,
          after: { attempts, lockedUntil },
          ip,
          userAgent,
        });
      });

      if (attempts >= 5) {
        throw new UnauthorizedException('Account locked for 15 minutes due to 5 consecutive failed logins');
      }

      throw new UnauthorizedException('Invalid email or password');
    }

    // Mandatory 2FA check for Admin / HR (FR-AUTH-004)
    const isAdminOrHr =
      user.role === UserRole.ADMIN ||
      user.role === UserRole.SUPER_ADMIN ||
      user.role === UserRole.HR_MANAGER ||
      user.role === UserRole.HR;

    if (user.mfa_enabled) {
      if (!dto.totpCode) {
        return {
          requires2fa: true,
          userId: user.id,
          message: 'Two-factor authentication code required',
        };
      }

      const verifyResult = verifySync({
        token: dto.totpCode,
        secret: user.mfa_secret,
      });
      const isValidToken = verifyResult.valid;

      let recoveryUsed = false;
      if (!isValidToken && user.mfa_recovery_codes && user.mfa_recovery_codes.length > 0) {
        const hashedCode = sha256(dto.totpCode);
        const codeIndex = user.mfa_recovery_codes.indexOf(hashedCode);
        if (codeIndex >= 0) {
          recoveryUsed = true;
          // Consume recovery code
          const updatedCodes = [...user.mfa_recovery_codes];
          updatedCodes.splice(codeIndex, 1);
          await pool.query(
            `UPDATE users SET mfa_recovery_codes = $1 WHERE id = $2`,
            [updatedCodes, user.id],
          );
        }
      }

      if (!isValidToken && !recoveryUsed) {
        throw new UnauthorizedException('Invalid 2FA code or recovery code');
      }
    } else if (isAdminOrHr) {
      // 2FA is mandatory for Admin and HR Manager
      return {
        requires2faSetup: true,
        userId: user.id,
        message: 'Two-factor authentication is mandatory for this role. Please set up 2FA to complete login.',
      };
    }

    // Password & MFA verified: Reset failure count and issue tokens inside tenant context
    return await this.prisma.runWithTenantContext(user.org_id, async (client) => {
      await client.query(
        `UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`,
        [user.id],
      );

      const sessionId = randomUUID();
      const familyId = randomUUID();
      const refreshToken = randomBytes(32).toString('hex');
      const refreshTokenHash = sha256(refreshToken);
      const refreshExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      // Store auth session
      await client.query(
        `INSERT INTO auth_sessions (id, org_id, user_id, family_id, refresh_token_hash, expires_at, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          sessionId,
          user.org_id,
          user.id,
          familyId,
          refreshTokenHash,
          refreshExpiresAt,
          ip || null,
          userAgent || null,
        ],
      );

      // Issue per-session HMAC secret for presence heartbeats
      const sessionSecret = randomBytes(32).toString('hex');
      await client.query(
        `INSERT INTO session_secrets (session_id, org_id, secret)
         VALUES ($1, $2, $3)`,
        [sessionId, user.org_id, sessionSecret],
      );

      // Generate access token (15m)
      const jwtPayload: JwtPayload = {
        sub: user.id,
        orgId: user.org_id,
        email: user.email,
        role: user.role,
        displayName: user.display_name,
        teamId: user.team_id,
      };

      const accessToken = jwt.sign(jwtPayload, this.jwtSecret, { expiresIn: '15m' });

      // Audit log
      await this.recordAudit(client, {
        orgId: user.org_id,
        actorId: user.id,
        action: 'LOGIN_SUCCESS',
        entityType: 'SESSION',
        entityId: sessionId,
        after: { role: user.role, ip },
        ip,
        userAgent,
      });

      return {
        accessToken,
        refreshToken,
        sessionId,
        sessionSecret,
        user: {
          id: user.id,
          orgId: user.org_id,
          email: user.email,
          displayName: user.display_name,
          role: user.role,
        },
      };
    });
  }

  /**
   * Refresh Token with Reuse Detection (FR-AUTH-003)
   * Rotating refresh tokens (7 days). If a previously used/revoked token is presented,
   * detects token reuse and revokes the whole token family immediately!
   */
  async refresh(refreshToken: string, ip?: string, userAgent?: string) {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }

    const tokenHash = sha256(refreshToken);
    const pool = this.prisma.getPool();

    const sessionRes = await pool.query(
      `SELECT * FROM fn_lookup_session_for_refresh($1)`,
      [tokenHash],
    );

    if (sessionRes.rows.length === 0) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const session = sessionRes.rows[0];

    // REUSE DETECTION: If this token was already revoked, someone is replaying it!
    if (session.is_revoked) {
      // Revoke entire token family inside tenant context
      await this.prisma.runWithTenantContext(session.org_id, async (client) => {
        await client.query(
          `UPDATE auth_sessions SET is_revoked = true WHERE org_id = $1 AND family_id = $2`,
          [session.org_id, session.family_id],
        );

        await this.recordAudit(client, {
          orgId: session.org_id,
          actorId: session.user_id,
          action: 'REFRESH_TOKEN_REUSE_DETECTED',
          entityType: 'SESSION_FAMILY',
          entityId: session.family_id,
          after: { revokedSessionId: session.id, ip },
          ip,
          userAgent,
        });
      });

      throw new UnauthorizedException('Refresh token reuse detected. All active sessions in this family have been revoked.');
    }

    if (new Date(session.expires_at).getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token has expired');
    }

    return await this.prisma.runWithTenantContext(session.org_id, async (client) => {
      // Invalidate current token
      await client.query(
        `UPDATE auth_sessions SET is_revoked = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [session.id],
      );

      // Issue new session in the same family (rotation)
      const newSessionId = randomUUID();
      const newRefreshToken = randomBytes(32).toString('hex');
      const newRefreshTokenHash = sha256(newRefreshToken);
      const refreshExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      await client.query(
        `INSERT INTO auth_sessions (id, org_id, user_id, family_id, refresh_token_hash, expires_at, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          newSessionId,
          session.org_id,
          session.user_id,
          session.family_id,
          newRefreshTokenHash,
          refreshExpiresAt,
          ip || null,
          userAgent || null,
        ],
      );

      // Issue new session secret
      const newSessionSecret = randomBytes(32).toString('hex');
      await client.query(
        `INSERT INTO session_secrets (session_id, org_id, secret)
         VALUES ($1, $2, $3)`,
        [newSessionId, session.org_id, newSessionSecret],
      );

      // Generate access token (15m)
      const jwtPayload: JwtPayload = {
        sub: session.user_id,
        orgId: session.org_id,
        email: session.email,
        role: session.role,
        displayName: session.display_name,
        teamId: session.team_id,
      };

      const accessToken = jwt.sign(jwtPayload, this.jwtSecret, { expiresIn: '15m' });

      // Audit log
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
  }

  /**
   * Setup TOTP 2FA (FR-AUTH-004)
   */
  async setup2fa(user: AuthenticatedUser) {
    const secret = generateSecret();
    const otpauthUrl = generateURI({ secret, label: user.email, issuer: 'HRVO' });

    const pool = this.prisma.getPool();
    await pool.query(
      `UPDATE users SET mfa_secret = $1 WHERE id = $2`,
      [secret, user.id],
    );

    return { secret, otpauthUrl };
  }

  /**
   * Verify and enable TOTP 2FA, returning 10 backup recovery codes (FR-AUTH-004)
   */
  async verifyAndEnable2fa(
    user: AuthenticatedUser,
    code: string,
    ip?: string,
    userAgent?: string,
  ) {
    const pool = this.prisma.getPool();
    const res = await pool.query(
      `SELECT mfa_secret FROM users WHERE id = $1`,
      [user.id],
    );

    if (res.rows.length === 0 || !res.rows[0].mfa_secret) {
      throw new BadRequestException('2FA setup has not been initiated');
    }

    const secret = res.rows[0].mfa_secret;
    const verifyResult = verifySync({ token: code, secret });
    const isValid = verifyResult.valid;

    if (!isValid) {
      throw new BadRequestException('Invalid 2FA verification code');
    }

    // Generate 10 recovery codes
    const plainRecoveryCodes: string[] = [];
    const hashedRecoveryCodes: string[] = [];

    for (let i = 0; i < 10; i++) {
      const plain = randomBytes(5).toString('hex'); // 10 chars
      plainRecoveryCodes.push(plain);
      hashedRecoveryCodes.push(sha256(plain));
    }

    await pool.query(
      `UPDATE users
       SET mfa_enabled = true, mfa_recovery_codes = $1
       WHERE id = $2`,
      [hashedRecoveryCodes, user.id],
    );

    await this.prisma.runWithTenantContext(user.orgId, async (client) => {
      await this.recordAudit(client, {
        orgId: user.orgId,
        actorId: user.id,
        action: '2FA_ENABLED',
        entityType: 'USER',
        entityId: user.id,
        ip,
        userAgent,
      });
    });

    return {
      success: true,
      recoveryCodes: plainRecoveryCodes,
    };
  }

  /**
   * Logout and revoke session (FR-AUTH-003, FR-AUTH-011)
   */
  async logout(
    sessionId: string,
    user: AuthenticatedUser,
    ip?: string,
    userAgent?: string,
  ) {
    return await this.prisma.runWithTenantContext(user.orgId, async (client) => {
      await client.query(
        `UPDATE auth_sessions SET is_revoked = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND org_id = $2`,
        [sessionId, user.orgId],
      );

      await client.query(
        `DELETE FROM session_secrets WHERE session_id = $1 AND org_id = $2`,
        [sessionId, user.orgId],
      );

      await this.recordAudit(client, {
        orgId: user.orgId,
        actorId: user.id,
        action: 'LOGOUT',
        entityType: 'SESSION',
        entityId: sessionId,
        ip,
        userAgent,
      });

      return { success: true };
    });
  }

  /**
   * Records an entry into the append-only, hash-chained audit_logs table (FR-AUD-001)
   */
  private async recordAudit(
    client: any,
    entry: {
      orgId: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      before?: any;
      after?: any;
      ip?: string;
      userAgent?: string;
    },
  ) {
    // Concurrency-safe hash chaining with per-org advisory lock
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('audit_logs:' || $1::text))`, [entry.orgId]);

    const lastRes = await client.query(
      `SELECT hash FROM audit_logs WHERE org_id = $1 ORDER BY id DESC LIMIT 1`,
      [entry.orgId],
    );

    const prevHash = lastRes.rows.length > 0
      ? lastRes.rows[0].hash
      : '0000000000000000000000000000000000000000000000000000000000000000';

    const now = new Date();
    const beforeStr = PostgresAttendanceRepository.canonicalJson(entry.before);
    const afterStr = PostgresAttendanceRepository.canonicalJson(entry.after);
    const payloadToHash = `${prevHash}|${entry.orgId}|${entry.actorId}|${entry.action}|${entry.entityType}|${entry.entityId}|${beforeStr}|${afterStr}|${now.toISOString()}`;
    const hash = createHash('sha256').update(payloadToHash).digest('hex');

    await client.query(
      `INSERT INTO audit_logs (org_id, actor_id, action, entity_type, entity_id, before, after, ip, user_agent, prev_hash, hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        entry.orgId,
        entry.actorId,
        entry.action,
        entry.entityType,
        entry.entityId,
        beforeStr === '{}' ? null : beforeStr,
        afterStr === '{}' ? null : afterStr,
        entry.ip || null,
        entry.userAgent || null,
        prevHash,
        hash,
        now.toISOString(),
      ],
    );
  }
}
