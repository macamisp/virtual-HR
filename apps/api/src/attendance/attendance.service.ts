/**
 * HRVO Attendance Engine Service
 * Implements FR-ATT-001 through FR-ATT-005 & Section 6 Architecture
 */

import { AttendanceStateMachine } from './attendance-state-machine.ts';
import { HeartbeatValidator } from './heartbeat-validator.ts';
import {
  AttendanceState,
  SessionStatus,
  DEFAULT_ATTENDANCE_CONFIG,
} from '../../../../packages/shared/src/attendance/types.ts';
import type {
  AttendanceConfig,
  AttendanceSession,
  HeartbeatPayload,
  StateMachineTransitionResult,
} from '../../../../packages/shared/src/attendance/types.ts';

export class AttendanceService {
  private stateMachine: AttendanceStateMachine;
  private validator: HeartbeatValidator;
  private config: AttendanceConfig;

  // Session storage map: userId -> current session
  private sessions = new Map<string, AttendanceSession>();
  // Closed sessions history: sessionId -> AttendanceSession
  private closedSessions = new Map<string, AttendanceSession>();
  // User secret store (session secret used for HMAC verification): userId -> secret
  private userSecrets = new Map<string, string>();

  constructor(config: Partial<AttendanceConfig> = {}) {
    this.config = { ...DEFAULT_ATTENDANCE_CONFIG, ...config };
    this.stateMachine = new AttendanceStateMachine(this.config);
    this.validator = new HeartbeatValidator();
  }

  public registerUserSecret(userId: string, secret: string): void {
    this.userSecrets.set(userId, secret);
  }

  public getUserSecret(userId: string): string | undefined {
    return this.userSecrets.get(userId);
  }

  public getValidator(): HeartbeatValidator {
    return this.validator;
  }

  public getStateMachine(): AttendanceStateMachine {
    return this.stateMachine;
  }

  public getSession(userId: string): AttendanceSession | null {
    return this.sessions.get(userId) ?? null;
  }

  public getAllOpenSessions(): AttendanceSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.status === SessionStatus.OPEN,
    );
  }

  public getClosedSession(sessionId: string): AttendanceSession | null {
    return this.closedSessions.get(sessionId) ?? null;
  }

  /**
   * FR-ATT-001 & FR-ATT-004: Ingest client heartbeat
   */
  public ingestHeartbeat(
    payload: HeartbeatPayload,
    serverTime: Date = new Date(),
    ip: string = '127.0.0.1',
  ): StateMachineTransitionResult {
    const secret = this.userSecrets.get(payload.userId);
    if (!secret) {
      throw new Error(`Unauthorized: No active session secret registered for user ${payload.userId}`);
    }

    // Cryptographic signature and anti-replay verification
    const validation = this.validator.validate(payload, secret, serverTime);
    if (!validation.valid) {
      throw new Error(`Heartbeat rejected: ${validation.reason}`);
    }

    // Ingest into state machine
    const existingSession = this.sessions.get(payload.userId) ?? null;
    const result = this.stateMachine.handleHeartbeat(
      existingSession,
      payload,
      serverTime,
      ip,
    );

    this.sessions.set(payload.userId, result.session);
    return result;
  }

  /**
   * Socket disconnect event (Gateway signal) -> Grace timer started
   */
  public onSocketDisconnect(
    userId: string,
    serverTime: Date = new Date(),
  ): StateMachineTransitionResult | null {
    const session = this.sessions.get(userId);
    if (!session || session.status !== SessionStatus.OPEN) return null;

    const result = this.stateMachine.handleSocketDisconnect(session, serverTime);
    this.sessions.set(userId, result.session);
    return result;
  }

  /**
   * Socket reconnect event (within grace period) -> Restore state
   */
  public onSocketReconnect(
    userId: string,
    serverTime: Date = new Date(),
  ): StateMachineTransitionResult | null {
    const session = this.sessions.get(userId);
    if (!session || session.status !== SessionStatus.OPEN) return null;

    const result = this.stateMachine.handleSocketReconnect(session, serverTime);
    this.sessions.set(userId, result.session);
    return result;
  }

  /**
   * Explicit user logout -> Immediate clock-out
   */
  public onExplicitLogout(
    userId: string,
    serverTime: Date = new Date(),
  ): StateMachineTransitionResult | null {
    const session = this.sessions.get(userId);
    if (!session || session.status !== SessionStatus.OPEN) return null;

    const result = this.stateMachine.handleExplicitLogout(session, serverTime);
    this.sessions.delete(userId);
    this.closedSessions.set(result.session.id, result.session);
    return result;
  }

  /**
   * User starts break
   */
  public startBreak(
    userId: string,
    serverTime: Date = new Date(),
  ): StateMachineTransitionResult | null {
    const session = this.sessions.get(userId);
    if (!session || session.status !== SessionStatus.OPEN) return null;

    const result = this.stateMachine.handleUserStartsBreak(session, serverTime);
    this.sessions.set(userId, result.session);
    return result;
  }

  /**
   * User ends break
   */
  public endBreak(
    userId: string,
    serverTime: Date = new Date(),
  ): StateMachineTransitionResult | null {
    const session = this.sessions.get(userId);
    if (!session || session.status !== SessionStatus.OPEN) return null;

    const result = this.stateMachine.handleUserEndsBreak(session, serverTime);
    this.sessions.set(userId, result.session);
    return result;
  }

  /**
   * User joins call or meeting
   */
  public joinMeeting(
    userId: string,
    meetingId: string,
    serverTime: Date = new Date(),
  ): StateMachineTransitionResult | null {
    const session = this.sessions.get(userId);
    if (!session || session.status !== SessionStatus.OPEN) return null;

    const result = this.stateMachine.handleJoinMeeting(session, meetingId, serverTime);
    this.sessions.set(userId, result.session);
    return result;
  }

  /**
   * User leaves call or meeting
   */
  public leaveMeeting(
    userId: string,
    serverTime: Date = new Date(),
  ): StateMachineTransitionResult | null {
    const session = this.sessions.get(userId);
    if (!session || session.status !== SessionStatus.OPEN) return null;

    const result = this.stateMachine.handleLeaveMeeting(session, serverTime);
    this.sessions.set(userId, result.session);
    return result;
  }

  /**
   * Periodic reconciliation worker (runs every 60 seconds)
   * Section 6.3:
   * 1. Closes expired disconnected grace sessions
   * 2. Closes missing heartbeat sessions (> 90s)
   * 3. Splits midnight sessions
   * 4. Enforces max session length (14h)
   */
  public runReconciliation(serverTime: Date = new Date()): {
    closedCount: number;
    splitCount: number;
  } {
    let closedCount = 0;
    let splitCount = 0;

    for (const [userId, session] of Array.from(this.sessions.entries())) {
      if (session.status !== SessionStatus.OPEN) continue;

      // 1. Midnight boundary split (must precede timeout so cross-midnight sessions split cleanly)
      const midRes = this.stateMachine.handleMidnightCheck(session, serverTime);
      let currentSession = session;
      if (midRes.splitSession) {
        this.closedSessions.set(midRes.session.id, midRes.session);
        this.sessions.set(userId, midRes.splitSession);
        splitCount++;
        currentSession = midRes.splitSession;
      }

      // 2. Max session length (>14 hours)
      const maxRes = this.stateMachine.handleMaxLengthCheck(currentSession, serverTime);
      if (maxRes.session.status === SessionStatus.CLOSED) {
        this.sessions.delete(userId);
        this.closedSessions.set(maxRes.session.id, maxRes.session);
        closedCount++;
        continue;
      }

      // 3. Grace expiration check
      if (
        currentSession.currentState === AttendanceState.DISCONNECTED &&
        currentSession.graceTimerExpiresAt &&
        serverTime.getTime() >= currentSession.graceTimerExpiresAt.getTime()
      ) {
        const res = this.stateMachine.handleGraceExpiration(currentSession, serverTime);
        this.sessions.delete(userId);
        this.closedSessions.set(res.session.id, res.session);
        closedCount++;
        continue;
      }

      // 4. Missing heartbeat timeout (>90s)
      const silenceSeconds =
        (serverTime.getTime() - currentSession.lastHeartbeatAt.getTime()) / 1000;
      if (
        currentSession.currentState !== AttendanceState.DISCONNECTED &&
        silenceSeconds > this.config.missedHeartbeatTimeoutSeconds
      ) {
        const res = this.stateMachine.handleMissingHeartbeatTimeout(currentSession, serverTime);
        this.sessions.delete(userId);
        this.closedSessions.set(res.session.id, res.session);
        closedCount++;
        continue;
      }
    }

    return { closedCount, splitCount };
  }
}
