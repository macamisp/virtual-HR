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

  // In-memory fallback stores (used when repository is not provided)
  private sessions = new Map<string, AttendanceSession>();
  private closedSessions = new Map<string, AttendanceSession>();
  private sessionSecrets = new Map<string, string>();

  constructor(
    config: Partial<AttendanceConfig> = {},
    clock: Clock = new SystemClock(),
    repository?: IAttendanceRepository,
  ) {
    this.config = { ...DEFAULT_ATTENDANCE_CONFIG, ...config };
    this.clock = clock;
    this.repository = repository;
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
  public async registerSessionSecret(sessionId: string, secret: string): Promise<void> {
    this.sessionSecrets.set(sessionId, secret);
    if (this.repository) {
      await this.repository.saveSessionSecret(sessionId, secret);
    }
  }

  /**
   * Revoke HMAC secret when a session terminates
   */
  public async revokeSessionSecret(sessionId: string): Promise<void> {
    this.sessionSecrets.delete(sessionId);
    if (this.repository) {
      await this.repository.revokeSessionSecret(sessionId);
    }
  }

  public async getSessionSecret(sessionId: string): Promise<string | undefined> {
    const mem = this.sessionSecrets.get(sessionId);
    if (mem) return mem;
    if (this.repository) {
      const dbSecret = await this.repository.findSessionSecret(sessionId);
      if (dbSecret) {
        this.sessionSecrets.set(sessionId, dbSecret);
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
    if (this.repository && orgId) {
      return await this.repository.findOpenSessionByUserId(orgId, userId);
    }
    return this.sessions.get(userId) ?? null;
  }

  public async getAllOpenSessions(orgId?: string): Promise<AttendanceSession[]> {
    if (this.repository) {
      return await this.repository.findAllOpenSessions(orgId);
    }
    return Array.from(this.sessions.values()).filter(
      (s) => s.status === SessionStatus.OPEN,
    );
  }

  public async getClosedSession(sessionId: string, orgId?: string): Promise<AttendanceSession | null> {
    if (this.repository && orgId) {
      return await this.repository.findSessionById(orgId, sessionId);
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
    // Secret must be strictly bound to payload.sessionId (per-session secret)
    const secret = await this.getSessionSecret(payload.sessionId);
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
      existingSession = await this.repository.findOpenSessionByUserId(payload.orgId, payload.userId);
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
    let session = await this.getSession(userId, orgId);
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
    let session = await this.getSession(userId, orgId);
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
    let session = await this.getSession(userId, orgId);
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
    let session = await this.getSession(userId, orgId);
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
    let session = await this.getSession(userId, orgId);
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
    let session = await this.getSession(userId, orgId);
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
    let session = await this.getSession(userId, orgId);
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
   * 1. Midnight boundary split (FR-ATT-008, Row 15)
   * 2. Max session length capping (FR-ATT-009, Row 16)
   * 3. Grace expiration check (Row 12)
   * 4. Missing heartbeat timeout (Row 13)
   *
   * Idempotency guarantee: Running twice produces 0 additional changes
   */
  public async runReconciliation(
    serverTime: Date = this.clock.now(),
    orgId?: string,
  ): Promise<{ closedCount: number; splitCount: number }> {
    let closedCount = 0;
    let splitCount = 0;

    const openSessions = await this.getAllOpenSessions(orgId);

    for (const session of openSessions) {
      if (session.status !== SessionStatus.OPEN) continue;

      // 1. Midnight boundary split (must precede timeout so cross-midnight sessions split cleanly)
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

      // 2. Max session length (>14 hours)
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

      // 3. Grace expiration check (Row 12: disconnect grace expired)
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

      // 4. Missing heartbeat timeout (Row 13: >90s silence)
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

    return { closedCount, splitCount };
  }
}
