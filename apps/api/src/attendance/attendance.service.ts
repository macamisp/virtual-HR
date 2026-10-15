/**
 * HRVO Attendance Engine Service
 * Implements FR-ATT-001 through FR-ATT-010, Section 6.2, 6.3, and 6.6
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { AttendanceStateMachine } from './attendance-state-machine.ts';
import { HeartbeatValidator } from './heartbeat-validator.ts';
import type { IAttendanceRepository } from './attendance-repository.ts';
import {
  AttendanceState,
  SessionStatus,
  DEFAULT_ATTENDANCE_CONFIG,
  SystemClock,
  UserRole,
  CorrectionStatus,
  DayStatus,
  LivePresenceStatus,
} from '../../../../packages/shared/src/attendance/types.ts';
import type {
  AttendanceConfig,
  AttendanceSession,
  Clock,
  HeartbeatPayload,
  StateMachineTransitionResult,
  AttendanceCorrection,
  ScheduleComplianceResult,
  AttendanceDaily,
  DraftTimesheet,
  LiveBoardUser,
  LiveBoardFilter,
  AttendanceExportFilter,
  TransparencyInfo,
  MonitoringConsent,
  IHolidayProvider,
  ILeaveProvider,
} from '../../../../packages/shared/src/attendance/types.ts';
export function sanitizeExportCell(val: any): any {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (/^[=+\-@\t\r]/.test(str)) {
    return `'${str}`;
  }
  return val;
}

export class AttendanceService {
  private stateMachine: AttendanceStateMachine;
  private validator: HeartbeatValidator;
  private config: AttendanceConfig;
  private clock: Clock;
  private repository?: IAttendanceRepository;
  private defaultOrgId?: string;
  private holidayProvider?: IHolidayProvider;
  private leaveProvider?: ILeaveProvider;

  // In-memory fallback stores (used when repository is not provided)
  private sessions = new Map<string, AttendanceSession>();
  private closedSessions = new Map<string, AttendanceSession>();
  private sessionSecrets = new Map<string, string>();
  private sessionSecretOrgs = new Map<string, string>();
  private inMemoryConsents = new Map<string, Set<string>>();

  constructor(
    configOrRepo?: any,
    clockOrUndefined?: any,
    repoOrClock?: any,
    defaultOrgIdOrHoliday?: any,
    holidayOrLeave?: any,
    leaveProvider?: any,
  ) {
    if (configOrRepo && typeof configOrRepo.findOpenSessionByUserId === 'function') {
      this.repository = configOrRepo;
      this.config = { ...DEFAULT_ATTENDANCE_CONFIG };
      this.clock = repoOrClock || clockOrUndefined || new SystemClock();
      this.holidayProvider = defaultOrgIdOrHoliday;
      this.leaveProvider = holidayOrLeave;
    } else {
      this.config = { ...DEFAULT_ATTENDANCE_CONFIG, ...(configOrRepo as Partial<AttendanceConfig>) };
      this.clock = clockOrUndefined || new SystemClock();
      this.repository = repoOrClock;
      this.defaultOrgId = defaultOrgIdOrHoliday;
      this.holidayProvider = holidayOrLeave;
      this.leaveProvider = leaveProvider;
    }
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

    // FR-AUD-004 / FR-ATT-020 Consent Gate:
    // A user who has not accepted the current monitoring-notice version must not get a session created by heartbeats.
    if (!existingSession) {
      const currentVersion = this.config.currentNoticeVersion ?? 'v1.0.0';
      const hasConsent = await this.hasUserAcceptedNotice(payload.orgId, payload.userId, currentVersion);
      if (!hasConsent) {
        throw new Error(`CONSENT_REQUIRED: User has not accepted current monitoring notice (${currentVersion})`);
      }
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

  // -------------------------------------------------------------
  // FR-ATT-013: Corrections Workflow
  // -------------------------------------------------------------

  public async requestCorrection(params: {
    orgId: string;
    userId: string;
    sessionId?: string | null;
    requestedIn: Date;
    requestedOut: Date;
    reason: string;
    evidenceDocumentId?: string;
  }): Promise<AttendanceCorrection> {
    if (!this.repository) {
      throw new Error('Repository is required for corrections');
    }

    const now = this.clock.now();

    // 1. Reject future times
    if (params.requestedIn.getTime() > now.getTime() || params.requestedOut.getTime() > now.getTime()) {
      throw new Error('Invalid correction request: correction times cannot be in the future');
    }

    // 2. Reject in >= out
    if (params.requestedIn.getTime() >= params.requestedOut.getTime()) {
      throw new Error('Invalid correction request: requestedIn must precede requestedOut');
    }

    // 3. Reject requests older than maxCorrectionAgeDays (default 7 days)
    const maxAgeDays = this.config.maxCorrectionAgeDays ?? 7;
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    if (now.getTime() - params.requestedIn.getTime() > maxAgeMs) {
      throw new Error(`Correction request exceeds maximum allowed age of ${maxAgeDays} days`);
    }

    // 4. Reject duplicate pending request for the same session or interval
    const pending = await this.repository.findPendingCorrections(params.orgId);
    const duplicate = pending.find(
      (c: AttendanceCorrection) =>
        c.userId === params.userId &&
        c.status === CorrectionStatus.PENDING &&
        ((params.sessionId && c.sessionId === params.sessionId) ||
          (!params.sessionId &&
            c.requestedIn.getTime() === params.requestedIn.getTime() &&
            c.requestedOut.getTime() === params.requestedOut.getTime())),
    );
    if (duplicate) {
      throw new Error('A pending correction request already exists for this session');
    }

    // 5. Reject overlap with another active/closed session of the user
    const workDate = formatInTimeZone(params.requestedIn, this.config.orgTimezone, 'yyyy-MM-dd');
    const existingSessions = await this.repository.findSessionsByDate(params.orgId, workDate);
    const userSessions = existingSessions.filter((s: AttendanceSession) => s.userId === params.userId);

    for (const sess of userSessions) {
      if (params.sessionId && sess.id === params.sessionId) continue;
      if (sess.status === SessionStatus.CANCELLED || sess.status === SessionStatus.ADJUSTED) continue;

      const sessStart = sess.clockInAt.getTime();
      const sessEnd = (sess.clockOutAt || sess.lastHeartbeatAt).getTime();
      const reqStart = params.requestedIn.getTime();
      const reqEnd = params.requestedOut.getTime();

      if (Math.max(reqStart, sessStart) < Math.min(reqEnd, sessEnd)) {
        throw new Error(`Correction interval overlaps with existing session ${sess.id}`);
      }
    }

    const correction: AttendanceCorrection = {
      id: randomUUID(),
      orgId: params.orgId,
      userId: params.userId,
      sessionId: params.sessionId || null,
      requestedIn: params.requestedIn,
      requestedOut: params.requestedOut,
      reason: params.reason,
      evidenceDocumentId: params.evidenceDocumentId || null,
      status: CorrectionStatus.PENDING,
      createdAt: now,
    };
    await this.repository.createCorrection(correction);

    await this.repository.recordAuditLog({
      orgId: params.orgId,
      actorId: params.userId,
      action: 'ATTENDANCE_CORRECTION_REQUESTED',
      entityType: 'ATTENDANCE_CORRECTION',
      entityId: correction.id,
      after: {
        requestedIn: params.requestedIn.toISOString(),
        requestedOut: params.requestedOut.toISOString(),
        reason: params.reason,
        sessionId: params.sessionId || null,
      },
      createdAt: now,
    });

    return correction;
  }

  public async getPendingCorrections(orgId: string): Promise<AttendanceCorrection[]> {
    if (!this.repository) return [];
    return await this.repository.findPendingCorrections(orgId);
  }

  public async reviewCorrection(params: {
    orgId: string;
    reviewerId: string;
    reviewerRole: string;
    correctionId: string;
    approved: boolean;
    reviewNote?: string;
  }): Promise<{ correction: AttendanceCorrection; adjustedSession?: AttendanceSession }> {
    if (!this.repository) {
      throw new Error('Repository is required for reviewCorrection');
    }
    const correction = await this.repository.findCorrectionById(params.orgId, params.correctionId);
    if (!correction) {
      throw new Error(`Correction not found: ${params.correctionId}`);
    }

    // FR-ATT-013: A user cannot approve their own correction
    if (correction.userId === params.reviewerId) {
      throw new Error('User cannot approve their own correction');
    }

    // Role check: Only user's manager or HR/Admin may review
    const requester = await this.repository.findUserById(params.orgId, correction.userId);
    const isManager = requester?.managerId === params.reviewerId || params.reviewerRole === UserRole.MANAGER;
    const isHrOrAdmin = params.reviewerRole === UserRole.HR || params.reviewerRole === UserRole.ADMIN;
    if (!isManager && !isHrOrAdmin) {
      throw new Error('Unauthorized to review correction: Only manager or HR/Admin may review');
    }

    const reviewedAt = this.clock.now();
    let adjustedSession: AttendanceSession | undefined;

    if (params.approved) {
      correction.status = CorrectionStatus.APPROVED;
      correction.reviewerId = params.reviewerId;
      correction.reviewedAt = reviewedAt;
      correction.reviewNote = params.reviewNote || null;
      await this.repository.updateCorrection(correction);

      let origSession: AttendanceSession | null = null;
      if (correction.sessionId) {
        origSession = await this.repository.findSessionById(params.orgId, correction.sessionId);
        if (origSession) {
          origSession.status = SessionStatus.ADJUSTED;
          await this.repository.saveSession(origSession);
        }
      }

      const durationSec = Math.floor((correction.requestedOut.getTime() - correction.requestedIn.getTime()) / 1000);
      const workDate = formatInTimeZone(correction.requestedIn, this.config.orgTimezone, 'yyyy-MM-dd');

      adjustedSession = {
        id: randomUUID(),
        orgId: params.orgId,
        userId: correction.userId,
        deviceId: origSession?.deviceId || 'adjusted-device',
        workDate,
        clockInAt: correction.requestedIn,
        clockOutAt: correction.requestedOut,
        clockInSource: 'CORRECTION',
        clockOutSource: 'CORRECTION',
        activeSeconds: durationSec,
        idleSeconds: 0,
        breakSeconds: 0,
        meetingSeconds: 0,
        netSeconds: durationSec,
        lastHeartbeatAt: correction.requestedOut,
        ipIn: origSession?.ipIn || '127.0.0.1',
        ipOut: origSession?.ipOut || '127.0.0.1',
        flags: ['CORRECTED'],
        status: SessionStatus.CLOSED,
        currentState: AttendanceState.OFFLINE,
        segments: [],
        consecutiveIdleSeconds: 0,
      };

      await this.repository.saveSession(adjustedSession);

      await this.repository.recordAuditLog({
        orgId: params.orgId,
        actorId: params.reviewerId,
        action: 'ATTENDANCE_CORRECTION_APPROVED',
        entityType: 'ATTENDANCE_CORRECTION',
        entityId: correction.id,
        before: { status: CorrectionStatus.PENDING },
        after: {
          status: CorrectionStatus.APPROVED,
          reviewerId: params.reviewerId,
          reviewNote: params.reviewNote || null,
          adjustedSessionId: adjustedSession.id,
        },
        createdAt: reviewedAt,
      });

      // Recompute attendance_daily for the affected date(s)
      const workDateIn = formatInTimeZone(correction.requestedIn, this.config.orgTimezone, 'yyyy-MM-dd');
      const workDateOut = formatInTimeZone(correction.requestedOut, this.config.orgTimezone, 'yyyy-MM-dd');
      const affectedDates = new Set([workDateIn, workDateOut]);
      for (const d of affectedDates) {
        await this.recomputeDailySummaryForUser(params.orgId, correction.userId, d);
      }

      return { correction, adjustedSession };
    } else {
      correction.status = CorrectionStatus.REJECTED;
      correction.reviewerId = params.reviewerId;
      correction.reviewedAt = reviewedAt;
      correction.reviewNote = params.reviewNote || null;
      await this.repository.updateCorrection(correction);

      await this.repository.recordAuditLog({
        orgId: params.orgId,
        actorId: params.reviewerId,
        action: 'ATTENDANCE_CORRECTION_REJECTED',
        entityType: 'ATTENDANCE_CORRECTION',
        entityId: correction.id,
        before: { status: CorrectionStatus.PENDING },
        after: {
          status: CorrectionStatus.REJECTED,
          reviewerId: params.reviewerId,
          reviewNote: params.reviewNote || null,
        },
        createdAt: reviewedAt,
      });

      return { correction };
    }
  }

  // -------------------------------------------------------------
  // FR-ATT-014: Schedule Compliance Engine
  // -------------------------------------------------------------

  public async computeScheduleCompliance(params: {
    orgId: string;
    userId: string;
    workDate: string;
    sessions: AttendanceSession[];
  }): Promise<ScheduleComplianceResult> {
    const isHoliday = this.holidayProvider
      ? await this.holidayProvider.isHoliday(params.orgId, params.workDate)
      : false;
    const isOnLeave = this.leaveProvider
      ? await this.leaveProvider.isUserOnApprovedLeave(params.orgId, params.userId, params.workDate)
      : false;

    const actualSeconds = params.sessions.reduce((sum, s) => sum + s.netSeconds, 0);

    // If holiday or approved leave: expected hours = 0, no absence or late flags
    if (isHoliday || isOnLeave) {
      return {
        workDate: params.workDate,
        userId: params.userId,
        isWorkingDay: false,
        isHoliday,
        isOnLeave,
        expectedSeconds: 0,
        actualSeconds,
        lateArrivalMinutes: 0,
        earlyLeaveMinutes: 0,
        overtimeMinutes: 0,
        isAbsent: false,
        flags: isHoliday ? ['HOLIDAY'] : ['ON_LEAVE'],
      };
    }

    const schedule = this.repository
      ? await this.repository.findWorkScheduleForUser(params.orgId, params.userId)
      : null;

    // Determine day of week in org timezone: 1 = Monday ... 7 = Sunday
    const middayUtc = fromZonedTime(`${params.workDate} 12:00:00`, this.config.orgTimezone);
    const dayOfWeek = formatInTimeZone(middayUtc, this.config.orgTimezone, 'i');

    const dayConfig = schedule?.days ? schedule.days[dayOfWeek] : null;
    const isWorkingDay = dayConfig != null;
    const expectedSeconds = isWorkingDay ? dayConfig.expectedHours * 3600 : 0;
    const graceMinutes = schedule?.graceMinutes ?? 10;

    const flags: string[] = [];
    let lateArrivalMinutes = 0;
    let earlyLeaveMinutes = 0;
    let overtimeMinutes = 0;
    let isAbsent = false;

    if (isWorkingDay && params.sessions.length === 0) {
      isAbsent = true;
      flags.push('ABSENT');
    } else if (isWorkingDay && params.sessions.length > 0 && dayConfig) {
      const sorted = [...params.sessions].sort(
        (a, b) => a.clockInAt.getTime() - b.clockInAt.getTime(),
      );
      const firstIn = sorted[0].clockInAt;
      const lastOut = sorted[sorted.length - 1].clockOutAt;

      const scheduledStartUtc = fromZonedTime(
        `${params.workDate} ${dayConfig.start}:00`,
        this.config.orgTimezone,
      );
      const scheduledEndUtc = fromZonedTime(
        `${params.workDate} ${dayConfig.end}:00`,
        this.config.orgTimezone,
      );

      // Late arrival: clockIn > scheduledStart + graceMinutes
      const lateThreshold = scheduledStartUtc.getTime() + graceMinutes * 60 * 1000;
      if (firstIn.getTime() > lateThreshold) {
        lateArrivalMinutes = Math.floor(
          (firstIn.getTime() - scheduledStartUtc.getTime()) / 60000,
        );
        flags.push('LATE_ARRIVAL');
      }

      // Early leave: lastOut < scheduledEnd - graceMinutes
      if (lastOut) {
        const earlyThreshold = scheduledEndUtc.getTime() - graceMinutes * 60 * 1000;
        if (lastOut.getTime() < earlyThreshold) {
          earlyLeaveMinutes = Math.floor(
            (scheduledEndUtc.getTime() - lastOut.getTime()) / 60000,
          );
          flags.push('EARLY_LEAVE');
        }
      }

      // Overtime: actualSeconds > expectedSeconds
      if (actualSeconds > expectedSeconds) {
        overtimeMinutes = Math.floor((actualSeconds - expectedSeconds) / 60);
        flags.push('OVERTIME');
      }
    }

    return {
      workDate: params.workDate,
      userId: params.userId,
      isWorkingDay,
      isHoliday: false,
      isOnLeave: false,
      expectedSeconds,
      actualSeconds,
      lateArrivalMinutes,
      earlyLeaveMinutes,
      overtimeMinutes,
      isAbsent,
      flags,
    };
  }

  // -------------------------------------------------------------
  // FR-ATT-015 & Section 6.3: Daily Close Job & Draft Timesheets
  // -------------------------------------------------------------

  public async recomputeDailySummaryForUser(
    orgId: string,
    userId: string,
    workDate: string,
  ): Promise<AttendanceDaily | null> {
    if (!this.repository) {
      throw new Error('Repository is required for recomputeDailySummaryForUser');
    }

    const allSessions = await this.repository.findSessionsByDate(orgId, workDate);
    const userSessions = allSessions.filter(
      (s: AttendanceSession) => s.userId === userId && s.status !== SessionStatus.CANCELLED && s.status !== SessionStatus.ADJUSTED,
    );

    const compliance = await this.computeScheduleCompliance({
      orgId,
      userId,
      workDate,
      sessions: userSessions,
    });

    const firstIn = userSessions.length > 0 ? userSessions[0].clockInAt : null;
    const lastOut = userSessions.length > 0 ? userSessions[userSessions.length - 1].clockOutAt : null;
    const activeSeconds = userSessions.reduce((sum: number, s: AttendanceSession) => sum + s.activeSeconds, 0);
    const idleSeconds = userSessions.reduce((sum: number, s: AttendanceSession) => sum + s.idleSeconds, 0);
    const breakSeconds = userSessions.reduce((sum: number, s: AttendanceSession) => sum + s.breakSeconds, 0);
    const meetingSeconds = userSessions.reduce((sum: number, s: AttendanceSession) => sum + s.meetingSeconds, 0);
    const netSeconds = userSessions.reduce((sum: number, s: AttendanceSession) => sum + s.netSeconds, 0);

    let dayStatus: DayStatus = DayStatus.PRESENT;
    if (compliance.isHoliday) {
      dayStatus = DayStatus.HOLIDAY;
    } else if (compliance.isOnLeave) {
      dayStatus = DayStatus.LEAVE;
    } else if (compliance.isAbsent) {
      dayStatus = DayStatus.ABSENT;
    } else if (compliance.expectedSeconds > 0 && netSeconds < compliance.expectedSeconds / 2) {
      dayStatus = DayStatus.HALF_DAY;
    } else if (compliance.lateArrivalMinutes > 0) {
      dayStatus = DayStatus.LATE;
    } else if (compliance.earlyLeaveMinutes > 0) {
      dayStatus = DayStatus.EARLY_LEAVE;
    }

    const daily: AttendanceDaily = {
      orgId,
      userId,
      workDate,
      firstIn,
      lastOut,
      activeSeconds,
      idleSeconds,
      breakSeconds,
      meetingSeconds,
      netSeconds,
      expectedSeconds: compliance.expectedSeconds,
      lateMinutes: compliance.lateArrivalMinutes,
      earlyLeaveMinutes: compliance.earlyLeaveMinutes,
      overtimeMinutes: compliance.overtimeMinutes,
      dayStatus,
    };

    await this.repository.saveDailyAttendance(daily);

    // FR-TS-001: Auto-generate draft timesheet entry
    const existingTimesheet = await this.repository.findDraftTimesheet(orgId, userId, workDate);
    await this.repository.saveDraftTimesheet({
      id: existingTimesheet?.id || randomUUID(),
      orgId,
      userId,
      workDate,
      periodStart: workDate,
      periodEnd: workDate,
      status: 'DRAFT',
      attendanceMinutes: Math.floor(netSeconds / 60),
      loggedMinutes: existingTimesheet?.loggedMinutes || 0,
      billableMinutes: Math.floor(netSeconds / 60),
      varianceMinutes: existingTimesheet ? (existingTimesheet.loggedMinutes - Math.floor(netSeconds / 60)) : 0,
    });

    return daily;
  }

  public async runDailyCloseJob(orgId: string, workDate: string): Promise<AttendanceDaily[]> {
    if (!this.repository) {
      throw new Error('Repository is required for runDailyCloseJob');
    }

    const users = await this.repository.findAllUsers(orgId);
    const summaries: AttendanceDaily[] = [];

    for (const user of users) {
      const daily = await this.recomputeDailySummaryForUser(orgId, user.id, workDate);
      if (daily) {
        summaries.push(daily);
      }
    }

    return summaries;
  }

  // -------------------------------------------------------------
  // FR-ATT-016: Live Board with Role Scoping
  // -------------------------------------------------------------

  public async getLiveBoard(params: {
    orgId: string;
    callerUserId: string;
    callerRole: string;
    callerTeamId?: string | null;
    filterTeamId?: string;
  }): Promise<LiveBoardUser[]> {
    if (!this.repository) {
      throw new Error('Repository is required for getLiveBoard');
    }

    let targetTeamId: string | undefined = undefined;

    // RBAC Scoping
    if (params.callerRole === UserRole.TEAM_LEAD) {
      if (!params.callerTeamId) {
        throw new Error('Team lead has no assigned team');
      }
      targetTeamId = params.callerTeamId;
    } else if (
      params.callerRole === UserRole.HR ||
      params.callerRole === UserRole.ADMIN ||
      params.callerRole === UserRole.MANAGER
    ) {
      targetTeamId = params.filterTeamId;
    } else {
      throw new Error('Insufficient permissions to view live board');
    }

    const users = await this.repository.findAllUsers(params.orgId, targetTeamId);
    const openSessions = await this.repository.findAllOpenSessions(params.orgId);
    const todayStr = formatInTimeZone(this.clock.now(), this.config.orgTimezone, 'yyyy-MM-dd');

    const board: LiveBoardUser[] = [];

    for (const u of users) {
      const openSession = openSessions.find((s: AttendanceSession) => s.userId === u.id);
      let status: LivePresenceStatus = LivePresenceStatus.OFFLINE;
      let clockInAt: Date | null = null;
      let lastHeartbeatAt: Date | null = null;
      let todayNetSeconds = 0;
      let currentSessionId: string | null = null;

      if (openSession) {
        currentSessionId = openSession.id;
        clockInAt = openSession.clockInAt;
        lastHeartbeatAt = openSession.lastHeartbeatAt;
        todayNetSeconds = openSession.netSeconds;

        switch (openSession.currentState) {
          case AttendanceState.ACTIVE:
            status = LivePresenceStatus.ACTIVE;
            break;
          case AttendanceState.IDLE:
            status = LivePresenceStatus.IDLE;
            break;
          case AttendanceState.ON_BREAK:
            status = LivePresenceStatus.ON_BREAK;
            break;
          case AttendanceState.IN_MEETING:
            status = LivePresenceStatus.IN_MEETING;
            break;
          default:
            status = LivePresenceStatus.IDLE;
            break;
        }
      } else {
        const isOnLeave = this.leaveProvider
          ? await this.leaveProvider.isUserOnApprovedLeave(params.orgId, u.id, todayStr)
          : false;
        if (isOnLeave) {
          status = LivePresenceStatus.ON_LEAVE;
        } else {
          status = LivePresenceStatus.OFFLINE;
        }
      }

      board.push({
        userId: u.id,
        displayName: u.displayName,
        email: u.email,
        teamId: u.teamId,
        role: u.role,
        status,
        currentSessionId,
        clockInAt,
        lastHeartbeatAt,
        todayNetSeconds,
      });
    }

    return board;
  }

  // -------------------------------------------------------------
  // FR-ATT-019: Attendance Data Export (CSV & XLSX)
  // -------------------------------------------------------------

  public async exportAttendanceCsv(params: {
    orgId: string;
    callerUserId: string;
    callerRole: string;
    filter: AttendanceExportFilter;
  }): Promise<string> {
    if (!this.repository) {
      throw new Error('Repository is required for export');
    }
    const allowed = [UserRole.HR, UserRole.ADMIN, UserRole.MANAGER, UserRole.TEAM_LEAD];
    if (!allowed.includes(params.callerRole as any)) {
      throw new Error('Export permission denied: caller lacks export permission');
    }

    const records = await this.repository.findDailyAttendanceInRange(params.orgId, params.filter);

    let csv = 'work_date,user_id,display_name,email,first_in,last_out,net_hours,status\n';
    for (const r of records as any[]) {
      const netHours = (r.netSeconds / 3600).toFixed(2);
      const firstIn = r.firstIn ? r.firstIn.toISOString() : '';
      const lastOut = r.lastOut ? r.lastOut.toISOString() : '';
      const safeWorkDate = sanitizeExportCell(r.workDate);
      const safeUserId = sanitizeExportCell(r.userId);
      const safeDisplayName = sanitizeExportCell(r.displayName || '');
      const safeEmail = sanitizeExportCell(r.email || '');
      const safeStatus = sanitizeExportCell(r.dayStatus);
      csv += `${safeWorkDate},${safeUserId},"${String(safeDisplayName).replace(/"/g, '""')}","${String(safeEmail).replace(/"/g, '""')}",${firstIn},${lastOut},${netHours},${safeStatus}\n`;
    }

    const exportId = randomUUID();
    await this.repository.recordAuditLog({
      orgId: params.orgId,
      actorId: params.callerUserId,
      action: 'ATTENDANCE_EXPORTED',
      entityType: 'EXPORT',
      entityId: exportId,
      after: { format: 'CSV', filter: params.filter, rowCount: records.length },
      createdAt: this.clock.now(),
    });

    return csv;
  }

  public async exportAttendanceXlsx(params: {
    orgId: string;
    callerUserId: string;
    callerRole: string;
    filter: AttendanceExportFilter;
  }): Promise<Buffer> {
    if (!this.repository) {
      throw new Error('Repository is required for export');
    }
    const allowed = [UserRole.HR, UserRole.ADMIN, UserRole.MANAGER, UserRole.TEAM_LEAD];
    if (!allowed.includes(params.callerRole as any)) {
      throw new Error('Export permission denied: caller lacks export permission');
    }

    const records = await this.repository.findDailyAttendanceInRange(params.orgId, params.filter);

    const ExcelJS = await import('exceljs');
    const WorkbookClass = (ExcelJS as any).default?.Workbook || (ExcelJS as any).Workbook;
    const workbook = new WorkbookClass();
    const sheet = workbook.addWorksheet('Attendance');

    sheet.columns = [
      { header: 'work_date', key: 'work_date', width: 15 },
      { header: 'user_id', key: 'user_id', width: 36 },
      { header: 'display_name', key: 'display_name', width: 25 },
      { header: 'email', key: 'email', width: 30 },
      { header: 'first_in', key: 'first_in', width: 25 },
      { header: 'last_out', key: 'last_out', width: 25 },
      { header: 'net_hours', key: 'net_hours', width: 12 },
      { header: 'status', key: 'status', width: 15 },
    ];

    for (const r of records as any[]) {
      sheet.addRow({
        work_date: sanitizeExportCell(r.workDate),
        user_id: sanitizeExportCell(r.userId),
        display_name: sanitizeExportCell(r.displayName || ''),
        email: sanitizeExportCell(r.email || ''),
        first_in: r.firstIn ? r.firstIn.toISOString() : '',
        last_out: r.lastOut ? r.lastOut.toISOString() : '',
        net_hours: Number((r.netSeconds / 3600).toFixed(2)),
        status: sanitizeExportCell(r.dayStatus),
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();

    const exportId = randomUUID();
    await this.repository.recordAuditLog({
      orgId: params.orgId,
      actorId: params.callerUserId,
      action: 'ATTENDANCE_EXPORTED',
      entityType: 'EXPORT',
      entityId: exportId,
      after: { format: 'XLSX', filter: params.filter, rowCount: records.length },
      createdAt: this.clock.now(),
    });

    return Buffer.from(buffer);
  }

  // -------------------------------------------------------------
  // FR-ATT-020 & FR-AUD-004: Transparency & Monitoring Consent
  // -------------------------------------------------------------

  public async getTransparencyEvents(params: {
    orgId: string;
    userId: string;
  }): Promise<TransparencyInfo> {
    if (!this.repository) {
      throw new Error('Repository is required for transparency');
    }

    const events = await this.repository.findPresenceEventsByUser(params.orgId, params.userId, 100);

    return {
      plainLanguageNotice:
        'HR Virtual Office Attendance Telemetry Notice: We collect minimal presence and attendance signals: ' +
        'server timestamps of clock in/out, interval counters of active vs idle seconds, in-call/meeting status, ' +
        'IP address, and client device identifier. ' +
        'No screenshots. No keystroke content, no browser history, no URLs, and no webcam feeds are captured or stored. ' +
        'All presence events are retained for 90 days in accordance with company privacy policy.',
      noticeVersion: 'v1.0.0',
      collectedFields: ['server_ts', 'event_type', 'state', 'seq', 'ip', 'active_seconds', 'idle_seconds', 'in_call'],
      retentionDays: 90,
      events,
    };
  }

  public async hasUserAcceptedNotice(orgId: string, userId: string, version: string): Promise<boolean> {
    if (this.repository) {
      const consents = await this.repository.findMonitoringConsentsByUser(orgId, userId);
      return consents.some((c: MonitoringConsent) => c.noticeVersion === version);
    }
    const userConsents = this.inMemoryConsents.get(userId);
    return userConsents ? userConsents.has(version) : false;
  }

  public async recordMonitoringConsent(params: {
    orgId: string;
    userId: string;
    noticeVersion: string;
    ip?: string;
    userAgent?: string;
  }): Promise<MonitoringConsent> {
    const consent: MonitoringConsent = {
      id: randomUUID(),
      orgId: params.orgId,
      userId: params.userId,
      noticeVersion: params.noticeVersion,
      acceptedAt: this.clock.now(),
      ip: params.ip || null,
      userAgent: params.userAgent || null,
    };

    if (this.repository) {
      await this.repository.saveMonitoringConsent(consent);

      await this.repository.recordAuditLog({
        orgId: params.orgId,
        actorId: params.userId,
        action: 'MONITORING_NOTICE_ACCEPTED',
        entityType: 'MONITORING_CONSENT',
        entityId: consent.id,
        after: {
          noticeVersion: params.noticeVersion,
          acceptedAt: consent.acceptedAt.toISOString(),
        },
        ip: params.ip || null,
        userAgent: params.userAgent || null,
        createdAt: this.clock.now(),
      });
    }

    let userConsents = this.inMemoryConsents.get(params.userId);
    if (!userConsents) {
      userConsents = new Set<string>();
      this.inMemoryConsents.set(params.userId, userConsents);
    }
    userConsents.add(params.noticeVersion);

    return consent;
  }
}

