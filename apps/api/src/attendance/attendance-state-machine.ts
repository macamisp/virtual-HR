/**
 * Attendance State Machine Implementation
 * Reference: docs/SRS.md Section 6.2 (State Machine Table), Section 5.5 (FR-ATT-001..010) & Section 6.6
 */

import { randomUUID } from 'node:crypto';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { computeIntervalUnionDurationSeconds } from './interval-merger.ts';
import {
  AttendanceState,
  ClockInSource,
  ClockOutSource,
  SessionStatus,
  DEFAULT_ATTENDANCE_CONFIG,
} from '../../../../packages/shared/src/attendance/types.ts';
import type {
  AttendanceConfig,
  AttendanceSession,
  AttendanceSegment,
  HeartbeatPayload,
  StateMachineTransitionResult,
} from '../../../../packages/shared/src/attendance/types.ts';

/** Thrown when a user action is not valid in the session's current state (e.g. ending a break that never started). */
export class InvalidTransitionError extends Error {
  readonly from: AttendanceState;
  readonly action: string;

  constructor(from: AttendanceState, action: string) {
    super(`Cannot ${action} while ${from}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.action = action;
  }
}

const BREAK_STARTABLE: readonly AttendanceState[] = [
  AttendanceState.ACTIVE,
  AttendanceState.IDLE,
  AttendanceState.PAUSED,
  AttendanceState.IN_MEETING,
];

export class AttendanceStateMachine {
  private config: AttendanceConfig;

  constructor(config: Partial<AttendanceConfig> = {}) {
    this.config = { ...DEFAULT_ATTENDANCE_CONFIG, ...config };
  }

  /**
   * Helper to format YYYY-MM-DD in the organisation's configured IANA timezone
   * Tested library: date-fns-tz
   */
  public getWorkDate(date: Date, timeZone: string = this.config.orgTimezone): string {
    return formatInTimeZone(date, timeZone, 'yyyy-MM-dd');
  }

  /**
   * Compute midnight boundaries in organisation's IANA timezone
   * Handles DST transitions (Spring forward, Fall back) and standard timezones accurately
   */
  public getMidnightBoundaries(date: Date, timeZone: string = this.config.orgTimezone): {
    endOfDay: Date;
    startOfNextDay: Date;
  } {
    const currentYmd = this.getWorkDate(date, timeZone);
    const [y, m, d] = currentYmd.split('-').map(Number);
    // Find next day in YYYY-MM-DD
    const nextDate = new Date(Date.UTC(y!, m! - 1, d! + 1));
    const nextYmd = formatInTimeZone(nextDate, 'UTC', 'yyyy-MM-dd');

    // In IANA timezone, 00:00:00 of next day converted to UTC
    const startOfNextDay = fromZonedTime(`${nextYmd} 00:00:00`, timeZone);
    const endOfDay = new Date(startOfNextDay.getTime() - 1);

    return { endOfDay, startOfNextDay };
  }

  /**
   * Row 1, 2, 3, 4, 5: Heartbeat ingestion and state transition
   */
  public handleHeartbeat(
    session: AttendanceSession | null,
    heartbeat: HeartbeatPayload,
    serverTime: Date,
    ip: string,
  ): StateMachineTransitionResult {
    const isActivity = heartbeat.inCall || heartbeat.activeSeconds > 0;

    // Row 1: OFFLINE -> First ACTIVE heartbeat (no open session) -> ACTIVE
    if (!session || session.status === SessionStatus.CLOSED) {
      const newSession: AttendanceSession = {
        id: randomUUID(),
        orgId: heartbeat.orgId,
        userId: heartbeat.userId,
        deviceId: heartbeat.deviceId,
        workDate: this.getWorkDate(serverTime),
        clockInAt: serverTime,
        clockOutAt: null,
        clockInSource: ClockInSource.AUTO_HEARTBEAT,
        clockOutSource: null,
        activeSeconds: heartbeat.activeSeconds,
        idleSeconds: heartbeat.idleSeconds,
        breakSeconds: 0,
        meetingSeconds: 0,
        netSeconds: heartbeat.activeSeconds,
        lastHeartbeatAt: serverTime,
        ipIn: ip,
        ipOut: null,
        flags: [],
        status: SessionStatus.OPEN,
        currentState: AttendanceState.ACTIVE,
        previousState: AttendanceState.OFFLINE,
        segments: [
          {
            id: randomUUID(),
            state: AttendanceState.ACTIVE,
            startedAt: serverTime,
            endedAt: null,
            durationSeconds: 0,
            flags: [],
          },
        ],
        graceTimerExpiresAt: null,
        consecutiveIdleSeconds: isActivity ? 0 : heartbeat.idleSeconds,
      };

      return {
        session: newSession,
        previousState: AttendanceState.OFFLINE,
        currentState: AttendanceState.ACTIVE,
        actionTaken: 'Create session; clock_in_at = server time; source AUTO_HEARTBEAT',
      };
    }

    // Active session exists: update heartbeat counters and server timestamp
    const updatedSession: AttendanceSession = { ...session };
    const prev = updatedSession.currentState;
    updatedSession.lastHeartbeatAt = serverTime;

    // Multi-device detection (FR-ATT-010)
    if (heartbeat.deviceId !== updatedSession.deviceId) {
      if (!updatedSession.flags.includes('MULTI_DEVICE')) {
        updatedSession.flags.push('MULTI_DEVICE');
      }
    }

    // Accumulate total counters
    updatedSession.activeSeconds += heartbeat.activeSeconds;
    updatedSession.idleSeconds += heartbeat.idleSeconds;

    if (isActivity) {
      // Activity detected
      updatedSession.consecutiveIdleSeconds = 0;

      if (prev === AttendanceState.IDLE) {
        // Row 3: IDLE -> Input resumes -> ACTIVE
        this.closeLastSegment(updatedSession, serverTime);
        this.openSegment(updatedSession, AttendanceState.ACTIVE, serverTime);
        updatedSession.currentState = AttendanceState.ACTIVE;
        updatedSession.previousState = AttendanceState.IDLE;
        this.recomputeNetSeconds(updatedSession, serverTime);

        return {
          session: updatedSession,
          previousState: AttendanceState.IDLE,
          currentState: AttendanceState.ACTIVE,
          actionTaken: 'Close idle segment; add to idle_seconds',
        };
      } else if (prev === AttendanceState.PAUSED) {
        // Row 5: PAUSED -> Input resumes -> ACTIVE
        this.closeLastSegment(updatedSession, serverTime, ['LONG_IDLE']);
        if (!updatedSession.flags.includes('LONG_IDLE')) {
          updatedSession.flags.push('LONG_IDLE');
        }
        this.openSegment(updatedSession, AttendanceState.ACTIVE, serverTime);
        updatedSession.currentState = AttendanceState.ACTIVE;
        updatedSession.previousState = AttendanceState.PAUSED;
        this.recomputeNetSeconds(updatedSession, serverTime);

        return {
          session: updatedSession,
          previousState: AttendanceState.PAUSED,
          currentState: AttendanceState.ACTIVE,
          actionTaken: "Resume accrual; flag segment as 'long idle'",
        };
      }
    } else {
      // Inactivity / idle interval
      updatedSession.consecutiveIdleSeconds += heartbeat.idleSeconds;

      if (
        prev === AttendanceState.ACTIVE &&
        updatedSession.consecutiveIdleSeconds >= this.config.idleThresholdSeconds
      ) {
        // Row 2: ACTIVE -> No input for 5 min (idle threshold) -> IDLE
        this.closeLastSegment(updatedSession, serverTime);
        this.openSegment(updatedSession, AttendanceState.IDLE, serverTime);
        updatedSession.currentState = AttendanceState.IDLE;
        updatedSession.previousState = AttendanceState.ACTIVE;

        return {
          session: updatedSession,
          previousState: AttendanceState.ACTIVE,
          currentState: AttendanceState.IDLE,
          actionTaken: 'Open idle segment; notify user subtly',
        };
      } else if (
        (prev === AttendanceState.IDLE || prev === AttendanceState.ACTIVE) &&
        updatedSession.consecutiveIdleSeconds >= this.config.pauseThresholdSeconds
      ) {
        // Row 4: IDLE -> Idle exceeds 15 min (pause threshold) -> PAUSED
        this.closeLastSegment(updatedSession, serverTime);
        this.openSegment(updatedSession, AttendanceState.PAUSED, serverTime);
        updatedSession.currentState = AttendanceState.PAUSED;
        updatedSession.previousState = prev;

        return {
          session: updatedSession,
          previousState: prev,
          currentState: AttendanceState.PAUSED,
          actionTaken: 'Pause active-time accrual; optional presence challenge',
        };
      }
    }

    this.recomputeNetSeconds(updatedSession, serverTime);

    return {
      session: updatedSession,
      previousState: prev,
      currentState: updatedSession.currentState,
      actionTaken: 'Update heartbeat telemetry and segment timers',
    };
  }

  /**
   * Row 6: ACTIVE / IDLE -> Join call or meeting -> IN_MEETING
   */
  public handleJoinMeeting(
    session: AttendanceSession,
    meetingId: string,
    serverTime: Date,
  ): StateMachineTransitionResult {
    const updated = { ...session };
    const prev = updated.currentState;
    this.closeLastSegment(updated, serverTime);
    this.openSegment(updated, AttendanceState.IN_MEETING, serverTime, meetingId);
    updated.previousState = prev;
    updated.currentState = AttendanceState.IN_MEETING;

    return {
      session: updated,
      previousState: prev,
      currentState: AttendanceState.IN_MEETING,
      actionTaken: 'Count as active; link meeting_id',
    };
  }

  /**
   * Row 7: IN_MEETING -> Leave call -> ACTIVE
   */
  public handleLeaveMeeting(
    session: AttendanceSession,
    serverTime: Date,
  ): StateMachineTransitionResult {
    const updated = { ...session };
    const lastSeg = this.closeLastSegment(updated, serverTime);
    if (lastSeg) {
      updated.meetingSeconds += lastSeg.durationSeconds;
    }
    this.openSegment(updated, AttendanceState.ACTIVE, serverTime);
    updated.previousState = AttendanceState.IN_MEETING;
    updated.currentState = AttendanceState.ACTIVE;
    this.recomputeNetSeconds(updated, serverTime);

    return {
      session: updated,
      previousState: AttendanceState.IN_MEETING,
      currentState: AttendanceState.ACTIVE,
      actionTaken: 'Credit meeting_seconds',
    };
  }

  /**
   * Row 8 & FR-ATT-007: User starts break -> ON_BREAK
   */
  public handleUserStartsBreak(
    session: AttendanceSession,
    serverTime: Date,
  ): StateMachineTransitionResult {
    if (!BREAK_STARTABLE.includes(session.currentState)) {
      throw new InvalidTransitionError(session.currentState, 'start a break');
    }
    const updated = { ...session };
    const prev = updated.currentState;
    this.closeLastSegment(updated, serverTime);
    this.openSegment(updated, AttendanceState.ON_BREAK, serverTime);
    updated.previousState = prev;
    updated.currentState = AttendanceState.ON_BREAK;

    return {
      session: updated,
      previousState: prev,
      currentState: AttendanceState.ON_BREAK,
      actionTaken: 'Open break segment',
    };
  }

  /**
   * Row 9 & FR-ATT-007: User ends break -> ACTIVE (apply paid/unpaid break policy)
   */
  public handleUserEndsBreak(
    session: AttendanceSession,
    serverTime: Date,
  ): StateMachineTransitionResult {
    if (session.currentState !== AttendanceState.ON_BREAK) {
      throw new InvalidTransitionError(session.currentState, 'end a break');
    }
    const updated = { ...session };
    const lastSeg = this.closeLastSegment(updated, serverTime);
    if (lastSeg) {
      updated.breakSeconds += lastSeg.durationSeconds;
    }
    this.openSegment(updated, AttendanceState.ACTIVE, serverTime);
    updated.previousState = AttendanceState.ON_BREAK;
    updated.currentState = AttendanceState.ACTIVE;
    this.recomputeNetSeconds(updated, serverTime);

    return {
      session: updated,
      previousState: AttendanceState.ON_BREAK,
      currentState: AttendanceState.ACTIVE,
      actionTaken: 'Close break; apply paid/unpaid policy',
    };
  }

  /**
   * Row 10: Any open state -> Socket disconnect -> DISCONNECTED (grace 120s)
   */
  public handleSocketDisconnect(
    session: AttendanceSession,
    serverTime: Date,
  ): StateMachineTransitionResult {
    const updated = { ...session };
    const prev = updated.currentState;
    updated.previousState = prev;
    updated.currentState = AttendanceState.DISCONNECTED;
    updated.graceTimerExpiresAt = new Date(
      serverTime.getTime() + this.config.disconnectGraceWindowSeconds * 1000,
    );

    return {
      session: updated,
      previousState: prev,
      currentState: AttendanceState.DISCONNECTED,
      actionTaken: 'Start 120 s grace timer; keep session open',
    };
  }

  /**
   * Row 11: DISCONNECTED -> Reconnect within 120 s -> Previous state
   */
  public handleSocketReconnect(
    session: AttendanceSession,
    // Unused here; kept so every transition handler has the same (session, serverTime) shape.
    _serverTime: Date,
  ): StateMachineTransitionResult {
    const updated = { ...session };
    const prev = updated.currentState;
    const restoredState =
      updated.previousState && updated.previousState !== AttendanceState.DISCONNECTED
        ? updated.previousState
        : AttendanceState.ACTIVE;

    updated.graceTimerExpiresAt = null;
    updated.previousState = prev;
    updated.currentState = restoredState;

    return {
      session: updated,
      previousState: prev,
      currentState: restoredState,
      actionTaken: 'Cancel timer; log gap',
    };
  }

  /**
   * Row 12: DISCONNECTED -> Grace expires -> OFFLINE (Clock-out = last valid heartbeat)
   */
  public handleGraceExpiration(
    session: AttendanceSession,
    // Unused here; kept so every transition handler has the same (session, serverTime) shape.
    _serverTime: Date,
  ): StateMachineTransitionResult {
    const updated = { ...session };
    this.closeLastSegment(updated, updated.lastHeartbeatAt);
    updated.status = SessionStatus.CLOSED;
    updated.currentState = AttendanceState.OFFLINE;
    updated.clockOutAt = updated.lastHeartbeatAt;
    updated.clockOutSource = ClockOutSource.DISCONNECT;
    updated.graceTimerExpiresAt = null;

    return {
      session: updated,
      previousState: AttendanceState.DISCONNECTED,
      currentState: AttendanceState.OFFLINE,
      actionTaken: 'Close session; clock_out_at = last valid heartbeat; source DISCONNECT',
    };
  }

  /**
   * Row 13: Any open state -> Heartbeats missing > 90 s -> OFFLINE (source TIMEOUT)
   */
  public handleMissingHeartbeatTimeout(
    session: AttendanceSession,
    // Unused here; kept so every transition handler has the same (session, serverTime) shape.
    _serverTime: Date,
  ): StateMachineTransitionResult {
    const updated = { ...session };
    const prev = updated.currentState;
    this.closeLastSegment(updated, updated.lastHeartbeatAt);
    updated.status = SessionStatus.CLOSED;
    updated.currentState = AttendanceState.OFFLINE;
    updated.clockOutAt = updated.lastHeartbeatAt;
    updated.clockOutSource = ClockOutSource.TIMEOUT;

    return {
      session: updated,
      previousState: prev,
      currentState: AttendanceState.OFFLINE,
      actionTaken: 'Reconciler closes session at last heartbeat; source TIMEOUT',
    };
  }

  /**
   * Row 14: Any open state -> Explicit logout -> OFFLINE (source LOGOUT)
   */
  public handleExplicitLogout(
    session: AttendanceSession,
    serverTime: Date,
  ): StateMachineTransitionResult {
    const updated = { ...session };
    const prev = updated.currentState;
    this.closeLastSegment(updated, serverTime);
    updated.status = SessionStatus.CLOSED;
    updated.currentState = AttendanceState.OFFLINE;
    updated.clockOutAt = serverTime;
    updated.clockOutSource = ClockOutSource.LOGOUT;

    return {
      session: updated,
      previousState: prev,
      currentState: AttendanceState.OFFLINE,
      actionTaken: 'Close session immediately; source LOGOUT',
    };
  }

  /**
   * Row 15 & FR-ATT-008: Org-timezone midnight -> splits session
   */
  public handleMidnightCheck(
    session: AttendanceSession,
    serverTime: Date,
  ): StateMachineTransitionResult {
    const currentWorkDate = this.getWorkDate(serverTime);
    if (session.workDate === currentWorkDate) {
      // Has not crossed midnight yet
      return {
        session,
        previousState: session.currentState,
        currentState: session.currentState,
        actionTaken: 'No split required',
      };
    }

    // Crossed midnight! Split into two sessions
    const { endOfDay, startOfNextDay } = this.getMidnightBoundaries(session.clockInAt);

    // 1. Close current day's session at 23:59:59.999
    const closedSession = { ...session };
    this.closeLastSegment(closedSession, endOfDay);
    closedSession.status = SessionStatus.CLOSED;
    closedSession.clockOutAt = endOfDay;
    closedSession.clockOutSource = ClockOutSource.MIDNIGHT;

    // 2. Open new session starting at 00:00:00.000 for next day
    const splitSession: AttendanceSession = {
      id: randomUUID(),
      orgId: session.orgId,
      userId: session.userId,
      deviceId: session.deviceId,
      workDate: currentWorkDate,
      clockInAt: startOfNextDay,
      clockOutAt: null,
      clockInSource: ClockInSource.AUTO_HEARTBEAT,
      clockOutSource: null,
      activeSeconds: 0,
      idleSeconds: 0,
      breakSeconds: 0,
      meetingSeconds: 0,
      netSeconds: 0,
      lastHeartbeatAt: serverTime,
      ipIn: session.ipIn,
      ipOut: null,
      flags: ['MIDNIGHT_SPLIT'],
      status: SessionStatus.OPEN,
      currentState: session.currentState,
      previousState: session.currentState,
      segments: [
        {
          id: randomUUID(),
          state: session.currentState,
          startedAt: startOfNextDay,
          endedAt: null,
          durationSeconds: 0,
          flags: ['MIDNIGHT_SPLIT'],
        },
      ],
      graceTimerExpiresAt: null,
      consecutiveIdleSeconds: 0,
    };

    return {
      session: closedSession,
      previousState: session.currentState,
      currentState: session.currentState,
      actionTaken: 'Close session at 23:59:59.999 and open new session at 00:00:00',
      splitSession,
    };
  }

  /**
   * Row 16 & FR-ATT-009: Session length > 14 h -> OFFLINE with MAX_LENGTH flag
   */
  public handleMaxLengthCheck(
    session: AttendanceSession,
    serverTime: Date,
  ): StateMachineTransitionResult {
    const elapsedSeconds = (serverTime.getTime() - session.clockInAt.getTime()) / 1000;
    if (elapsedSeconds <= this.config.maxSessionLengthSeconds) {
      return {
        session,
        previousState: session.currentState,
        currentState: session.currentState,
        actionTaken: 'Within maximum session length',
      };
    }

    const updated = { ...session };
    const prev = updated.currentState;
    this.closeLastSegment(updated, updated.lastHeartbeatAt, ['MAX_LENGTH']);
    updated.status = SessionStatus.CLOSED;
    updated.currentState = AttendanceState.OFFLINE;
    updated.clockOutAt = updated.lastHeartbeatAt;
    updated.clockOutSource = ClockOutSource.MAX_LENGTH;
    if (!updated.flags.includes('MAX_LENGTH')) {
      updated.flags.push('MAX_LENGTH');
    }

    return {
      session: updated,
      previousState: prev,
      currentState: AttendanceState.OFFLINE,
      actionTaken: 'Close at last heartbeat; flag MAX_LENGTH for review',
    };
  }

  // --- Helper Methods ---

  /**
   * Recompute net seconds factoring in paid break allowances and multi-device union
   */
  private recomputeNetSeconds(session: AttendanceSession, serverTime: Date): void {
    const paidBreakLimitSeconds = this.config.paidBreakMinutesPerDay * 60;
    const paidBreakSeconds = Math.min(session.breakSeconds, paidBreakLimitSeconds);

    if (session.flags.includes('MULTI_DEVICE')) {
      // Use wall-clock interval union across segments to eliminate double counting
      const intervals = session.segments
        .filter((s) => s.state === AttendanceState.ACTIVE || s.state === AttendanceState.IN_MEETING)
        .map((s) => ({
          start: s.startedAt,
          end: s.endedAt ? s.endedAt : serverTime,
        }));
      const unionDuration = computeIntervalUnionDurationSeconds(intervals);
      session.netSeconds = unionDuration + paidBreakSeconds;
    } else {
      session.netSeconds = session.activeSeconds + session.meetingSeconds + paidBreakSeconds;
    }
  }

  private closeLastSegment(
    session: AttendanceSession,
    endedAt: Date,
    extraFlags: string[] = [],
  ): AttendanceSegment | null {
    if (session.segments.length === 0) return null;
    const last = session.segments[session.segments.length - 1];
    if (last && !last.endedAt) {
      last.endedAt = endedAt;
      last.durationSeconds = Math.max(0, Math.round((endedAt.getTime() - last.startedAt.getTime()) / 1000));
      if (extraFlags.length > 0) {
        last.flags.push(...extraFlags);
      }
      return last;
    }
    return null;
  }

  private openSegment(
    session: AttendanceSession,
    state: AttendanceState,
    startedAt: Date,
    meetingId?: string,
  ): AttendanceSegment {
    const segment: AttendanceSegment = {
      id: randomUUID(),
      state,
      startedAt,
      endedAt: null,
      durationSeconds: 0,
      meetingId: meetingId || null,
      flags: [],
    };
    session.segments.push(segment);
    return segment;
  }
}
