/**
 * HRVO Attendance Engine Service
 * Implements FR-ATT-001 through FR-ATT-010, Section 6.2, 6.3, and 6.6
 */

import { randomBytes } from 'node:crypto';
import { AttendanceStateMachine } from './attendance-state-machine.ts';
import { HeartbeatValidator } from './heartbeat-validator.ts';
import {
  AttendanceState,
  SessionStatus,
  DEFAULT_ATTENDANCE_CONFIG,
  SystemClock,
} from '../../../../packages/shared/src/attendance/types.ts';
import type {
  AttendanceConfig,
  AttendanceSession,
  Clock,
  HeartbeatPayload,
  StateMachineTransitionResult,
} from '../../../../packages/shared/src/attendance/types.ts';
import type { IAttendanceRepository } from './attendance-repository.ts';

export class AttendanceService {
  private stateMachine: AttendanceStateMachine;
  private validator: HeartbeatValidator;
  private config: AttendanceConfig;
  private clock: Clock;
  private repository?: IAttendanceRepository;
  private defaultOrgId?: string;

  // In-memory fallback stores (used when repository is not provided)
  private sessions = new Map<string, AttendanceSession>();
  private closedSessions = new Map<string, AttendanceSession>();
  private sessionSecrets = new Map<string, string>();
  private sessionSecretOrgs = new Map<string, string>();

  constructor(
    config: Partial<AttendanceConfig> = {},
    clock: Clock = new SystemClock(),
    repository?: IAttendanceRepository,
    defaultOrgId?: string,
  ) {
    this.config = { ...DEFAULT_ATTENDANCE_CONFIG, ...config };
    this.clock = clock;
    this.repository = repository;
    this.defaultOrgId = defaultOrgId;
    this.stateMachine = new AttendanceStateMachine(this.config);
    this.validator = new HeartbeatValidator(300_000, this.clock);
  }

  /**
   * Cryptographically generate a random per-session HMAC secret
   */
  public generateSessionSecret(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Register HMAC secret for a specific login/attendance session
   */
  public async registerSessionSecret(
    sessionId: string,
    secret: string,
    orgId?: string,
  ): Promise<void> {
    const targetOrgId = orgId || this.defaultOrgId;
    this.sessionSecrets.set(sessionId, secret);
    if (targetOrgId) {
      this.sessionSecretOrgs.set(sessionId, targetOrgId);
    }
    if (this.repository && targetOrgId) {
      await this.repository.saveSessionSecret(targetOrgId, sessionId, secret);
    }
  }

  /**
   * Revoke HMAC secret when a session terminates
   */
  public async revokeSessionSecret(sessionId: string, orgId?: string): Promise<void> {
    const targetOrgId = orgId || this.sessionSecretOrgs.get(sessionId) || this.defaultOrgId;
    this.sessionSecrets.delete(sessionId);
    this.sessionSecretOrgs.delete(sessionId);
    if (this.repository && targetOrgId) {
      await this.repository.revokeSessionSecret(targetOrgId, sessionId);
    }
  }

  public async getSessionSecret(sessionId: string, orgId?: string): Promise<string | undefined> {
    const mem = this.sessionSecrets.get(sessionId);
    if (mem) return mem;
    const targetOrgId = orgId || this.sessionSecretOrgs.get(sessionId) || this.defaultOrgId;
    if (this.repository && targetOrgId) {
      const dbSecret = await this.repository.findSessionSecret(targetOrgId, sessionId);
      if (dbSecret) {
        this.sessionSecrets.set(sessionId, dbSecret);
        this.sessionSecretOrgs.set(sessionId, targetOrgId);
        return dbSecret;
      }
    }
    return undefined;
  }

  public getValidator(): HeartbeatValidator {
    return this.validator;
  }

  public getStateMachine(): AttendanceStateMachine {
    return this.stateMachine;
  }

  public getClock(): Clock {
    return this.clock;
  }

  public async getSession(userId: string, orgId?: string): Promise<AttendanceSession | null> {
    const targetOrgId = orgId || this.defaultOrgId;
    if (this.repository && targetOrgId) {
      return await this.repository.findOpenSessionByUserId(targetOrgId, userId);
    }
    return this.sessions.get(userId) ?? null;
  }

  public async getAllOpenSessions(orgId?: string): Promise<AttendanceSession[]> {
    const targetOrgId = orgId || this.defaultOrgId;
    if (this.repository) {
      if (!targetOrgId) {
        throw new Error('Tenant context missing: orgId must be provided to query open sessions');
      }
      return await this.repository.findAllOpenSessions(targetOrgId);
    }
    return Array.from(this.sessions.values()).filter(
      (s) => s.status === SessionStatus.OPEN && (!targetOrgId || s.orgId === targetOrgId),
    );
  }

  public async getClosedSession(
    sessionId: string,
    orgId?: string,
  ): Promise<AttendanceSession | null> {
    const targetOrgId = orgId || this.defaultOrgId;
    if (this.repository && targetOrgId) {
      return await this.repository.findSessionById(targetOrgId, sessionId);
    }
    return this.closedSessions.get(sessionId) ?? null;
  }

  /**
   * FR-ATT-001 & FR-ATT-004: Ingest client heartbeat
   */
  public async ingestHeartbeat(
    payload: HeartbeatPayload,
    serverTime: Date = this.clock.now(),
    ip: string = '127.0.0.1',
  ): Promise<StateMachineTransitionResult> {
    // Secret must be strictly bound to payload.sessionId & payload.orgId (per-session secret)
    const secret = await this.getSessionSecret(payload.sessionId, payload.orgId);
    if (!secret) {
      throw new Error(
        `Unauthorized: No active session secret registered for session ${payload.sessionId}`,
      );
    }

    // Cryptographic signature and anti-replay verification
    const validation = await this.validator.validateAsync(
      payload,
      secret,
      serverTime,
      this.repository,
    );
    if (!validation.valid) {
      throw new Error(`Heartbeat rejected: ${validation.reason}`);
    }

    // Ingest into state machine
    let existingSession: AttendanceSession | null = null;
    if (this.repository) {
      existingSession = await this.repository.findOpenSessionByUserId(
        payload.orgId,
        payload.userId,
      );
    } else {
      existingSession = this.sessions.get(payload.userId) ?? null;
    }

    const result = this.stateMachine.handleHeartbeat(
      existingSession,
      payload,
      serverTime,
      ip,
    );

    if (this.repository) {
      await this.repository.saveSession(result.session);
    }
    this.sessions.set(payload.userId, result.session);

    return result;
  }

  /**
   * Socket disconnect event (Gateway signal) -> Grace timer started
   */
  public async onSocketDisconnect(
    userId: string,
    serverTime: Date = this.clock.now(),
    orgId?: string,
  ): Promise<StateMachineTransitionResult | null> {
    const targetOrgId = orgId || this.defaultOrgId;
    let session = await this.getSession(userId, targetOrgId);
    if (!session || session.status !== SessionStatus.OPEN) return null;

    const result = this.stateMachine.handleSocketDisconnect(session, serverTime);
    if (this.repository) {
      await this.repository.saveSession(result.session);
    }
    this.sessions.set(userId, result.session);
    return result;
  }

  /**
   * Socket reconnect event (within grace period) -> Restore state
   */
  public async onSocketReconnect(
    userId: string,
    serverTime: Date = this.clock.now(),
    orgId?: string,
  ): Promise<StateMachineTransitionResult | null> {
    const targetOrgId = orgId || this.defaultOrgId;
    let session = await this.getSession(userId, targetOrgId);
    if (!session || session.status !== SessionStatus.OPEN) return null;

    const result = this.stateMachine.handleSocketReconnect(session, serverTime);
    if (this.repository) {
      await this.repository.saveSession(result.session);
    }
    this.sessions.set(userId, result.session);
    return result;
  }

  /**
   * Explicit user logout -> Immediate clock-out
   */
  public async onExplicitLogout(
    userId: string,
    serverTime: Date = this.clock.now(),
    orgId?: string,
  ): Promise<StateMachineTransitionResult | null> {
    const targetOrgId = orgId || this.defaultOrgId;
    let session = await this.getSession(userId, targetOrgId);
    if (!session || session.status !== SessionStatus.OPEN) return null;

    const result = this.stateMachine.handleExplicitLogout(session, serverTime);
    if (this.repository) {
      await this.repository.saveSession(result.session);
    }
    this.sessions.delete(userId);
    this.closedSessions.set(result.session.id, result.session);
    return result;
  }

  /**
   * User starts break
   */
  public async startBreak(
    userId: string,
    serverTime: Date = this.clock.now(),
    orgId?: string,
  ): Promise<StateMachineTransitionResult | null> {
    const targetOrgId = orgId || this.defaultOrgId;
    let session = await this.getSession(userId, targetOrgId);
    if (!session || session.status !== SessionStatus.OPEN) return null;

    const result = this.stateMachine.handleUserStartsBreak(session, serverTime);
    if (this.repository) {
      await this.repository.saveSession(result.session);
    }
    this.sessions.set(userId, result.session);
    return result;
  }

  /**
   * User ends break
   */
  public async endBreak(
    userId: string,
    serverTime: Date = this.clock.now(),
    orgId?: string,
  ): Promise<StateMachineTransitionResult | null> {
    const targetOrgId = orgId || this.defaultOrgId;
    let session = await this.getSession(userId, targetOrgId);
    if (!session || session.status !== SessionStatus.OPEN) return null;

    const result = this.stateMachine.handleUserEndsBreak(session, serverTime);
    if (this.repository) {
      await this.repository.saveSession(result.session);
    }
    this.sessions.set(userId, result.session);
    return result;
  }

  /**
   * User joins call or meeting
   */
  public async joinMeeting(
    userId: string,
    meetingId: string,
    serverTime: Date = this.clock.now(),
    orgId?: string,
  ): Promise<StateMachineTransitionResult | null> {
    const targetOrgId = orgId || this.defaultOrgId;
    let session = await this.getSession(userId, targetOrgId);
    if (!session || session.status !== SessionStatus.OPEN) return null;

    const result = this.stateMachine.handleJoinMeeting(session, meetingId, serverTime);
    if (this.repository) {
      await this.repository.saveSession(result.session);
    }
    this.sessions.set(userId, result.session);
    return result;
  }

  /**
   * User leaves call or meeting
   */
  public async leaveMeeting(
    userId: string,
    serverTime: Date = this.clock.now(),
    orgId?: string,
  ): Promise<StateMachineTransitionResult | null> {
    const targetOrgId = orgId || this.defaultOrgId;
    let session = await this.getSession(userId, targetOrgId);
    if (!session || session.status !== SessionStatus.OPEN) return null;

    const result = this.stateMachine.handleLeaveMeeting(session, serverTime);
    if (this.repository) {
      await this.repository.saveSession(result.session);
    }
    this.sessions.set(userId, result.session);
    return result;
  }

  /**
   * Periodic reconciliation worker (runs every 60 seconds)
   * Section 6.3:
   * 1. Heartbeat nonce cleanup (> 5 minutes old)
   * 2. Midnight boundary split (FR-ATT-008, Row 15)
   * 3. Max session length capping (FR-ATT-009, Row 16)
   * 4. Grace expiration check (Row 12)
   * 5. Missing heartbeat timeout (Row 13)
   *
   * Idempotency guarantee: Running twice produces 0 additional changes
   */
  public async runReconciliation(
    serverTime: Date = this.clock.now(),
    orgId?: string,
  ): Promise<{ closedCount: number; splitCount: number; cleanedNoncesCount: number }> {
    const targetOrgId = orgId || this.defaultOrgId;
    let closedCount = 0;
    let splitCount = 0;
    let cleanedNoncesCount = 0;

    // 1. Cleanup expired nonces (> 5 minutes = 300s)
    if (this.repository && targetOrgId) {
      const fiveMinutesAgo = new Date(serverTime.getTime() - 300_000);
      cleanedNoncesCount = await this.repository.cleanupExpiredNonces(
        targetOrgId,
        fiveMinutesAgo,
      );
    }

    const openSessions = await this.getAllOpenSessions(targetOrgId);

    for (const session of openSessions) {
      if (session.status !== SessionStatus.OPEN) continue;

      // 2. Midnight boundary split (must precede timeout so cross-midnight sessions split cleanly)
      const midRes = this.stateMachine.handleMidnightCheck(session, serverTime);
      let currentSession = session;
      if (midRes.splitSession) {
        if (this.repository) {
          await this.repository.saveSession(midRes.session);
          await this.repository.saveSession(midRes.splitSession);
        }
        this.closedSessions.set(midRes.session.id, midRes.session);
        this.sessions.set(session.userId, midRes.splitSession);
        splitCount++;
        currentSession = midRes.splitSession;
      }

      // 3. Max session length (>14 hours)
      const maxRes = this.stateMachine.handleMaxLengthCheck(currentSession, serverTime);
      if (maxRes.session.status === SessionStatus.CLOSED) {
        if (this.repository) {
          await this.repository.saveSession(maxRes.session);
        }
        this.sessions.delete(session.userId);
        this.closedSessions.set(maxRes.session.id, maxRes.session);
        closedCount++;
        continue;
      }

      // 4. Grace expiration check (Row 12: disconnect grace expired)
      if (
        currentSession.currentState === AttendanceState.DISCONNECTED &&
        currentSession.graceTimerExpiresAt &&
        serverTime.getTime() >= currentSession.graceTimerExpiresAt.getTime()
      ) {
        const res = this.stateMachine.handleGraceExpiration(currentSession, serverTime);
        if (this.repository) {
          await this.repository.saveSession(res.session);
        }
        this.sessions.delete(session.userId);
        this.closedSessions.set(res.session.id, res.session);
        closedCount++;
        continue;
      }

      // 5. Missing heartbeat timeout (Row 13: >90s silence)
      const silenceSeconds =
        (serverTime.getTime() - currentSession.lastHeartbeatAt.getTime()) / 1000;
      if (
        currentSession.currentState !== AttendanceState.DISCONNECTED &&
        silenceSeconds > this.config.missedHeartbeatTimeoutSeconds
      ) {
        const res = this.stateMachine.handleMissingHeartbeatTimeout(currentSession, serverTime);
        if (this.repository) {
          await this.repository.saveSession(res.session);
        }
        this.sessions.delete(session.userId);
        this.closedSessions.set(res.session.id, res.session);
        closedCount++;
        continue;
      }
    }

    return { closedCount, splitCount, cleanedNoncesCount };
  }

  /**
   * Cleanup job for heartbeat nonces older than maxAgeSeconds (default 300s = 5m)
   */
  public async cleanupExpiredNonces(
    serverTime: Date = this.clock.now(),
    maxAgeSeconds: number = 300,
    orgId?: string,
  ): Promise<number> {
    const targetOrgId = orgId || this.defaultOrgId;
    if (this.repository && targetOrgId) {
      const threshold = new Date(serverTime.getTime() - maxAgeSeconds * 1000);
      return await this.repository.cleanupExpiredNonces(targetOrgId, threshold);
    }
    return 0;
  }

  /**
   * Cleanup job for device sequences inactive older than staleDays (default 30 days)
   */
  public async cleanupStaleDeviceSequences(
    serverTime: Date = this.clock.now(),
    staleDays: number = 30,
    orgId?: string,
  ): Promise<number> {
    const targetOrgId = orgId || this.defaultOrgId;
    if (this.repository && targetOrgId) {
      const threshold = new Date(serverTime.getTime() - staleDays * 86400 * 1000);
      return await this.repository.cleanupStaleDeviceSequences(targetOrgId, threshold);
    }
    return 0;
  }
}
