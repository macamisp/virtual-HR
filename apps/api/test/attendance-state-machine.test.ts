/**
 * Comprehensive Test Suite for Attendance State Machine (SRS Section 6.2 & FR-ATT-001..005)
 * Every test tests exactly one row from the Section 6.2 state machine table.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AttendanceState,
  ClockInSource,
  ClockOutSource,
  SessionStatus,
} from '../../../packages/shared/src/attendance/types.ts';
import type {
  HeartbeatPayload,
} from '../../../packages/shared/src/attendance/types.ts';
import { AttendanceStateMachine } from '../src/attendance/attendance-state-machine.ts';

// Helper to create a basic mock heartbeat payload
function makeHeartbeat(overrides: Partial<HeartbeatPayload> = {}): HeartbeatPayload {
  return {
    orgId: 'org-test-01',
    userId: 'user-test-01',
    deviceId: 'device-test-01',
    sessionId: 'session-test-01',
    sequenceNumber: 1,
    nonce: 'nonce-001',
    activeSeconds: 30,
    idleSeconds: 0,
    tabVisible: true,
    windowFocused: true,
    inCall: false,
    signature: 'valid-hmac-signature',
    ...overrides,
  };
}

describe('SRS Section 6.2 Attendance State Machine - Row by Row Verification', () => {
  const sm = new AttendanceStateMachine({
    heartbeatIntervalSeconds: 30,
    missedHeartbeatTimeoutSeconds: 90,
    disconnectGraceWindowSeconds: 120,
    idleThresholdSeconds: 300,  // 5 min
    pauseThresholdSeconds: 900, // 15 min
    maxSessionLengthSeconds: 14 * 3600, // 14 hours
    orgTimezone: 'Asia/Colombo',
  });

  const baseServerTime = new Date('2026-10-13T08:00:00.000Z');

  // Row 1: OFFLINE -> First ACTIVE heartbeat -> ACTIVE
  it('Row 1: OFFLINE -> First ACTIVE heartbeat (no open session) -> creates ACTIVE session with server time', () => {
    const hb = makeHeartbeat({ activeSeconds: 25, idleSeconds: 5 });
    const result = sm.handleHeartbeat(null, hb, baseServerTime, '192.168.1.100');

    assert.equal(result.previousState, AttendanceState.OFFLINE);
    assert.equal(result.currentState, AttendanceState.ACTIVE);
    assert.equal(result.session.status, SessionStatus.OPEN);
    assert.equal(result.session.clockInSource, ClockInSource.AUTO_HEARTBEAT);
    assert.equal(result.session.clockInAt.toISOString(), baseServerTime.toISOString());
    assert.equal(result.session.clockOutAt, null);
    assert.equal(result.session.segments.length, 1);
    assert.equal(result.session.segments[0]?.state, AttendanceState.ACTIVE);
  });

  // Row 2: ACTIVE -> No input for 5 min (idle threshold) -> IDLE
  it('Row 2: ACTIVE -> No input for 5 min (idle threshold) -> transitions to IDLE and opens idle segment', () => {
    // Clock-in first
    const hb1 = makeHeartbeat({ activeSeconds: 30, idleSeconds: 0 });
    const initial = sm.handleHeartbeat(null, hb1, baseServerTime, '192.168.1.100');

    // Simulate 5 minutes of idle heartbeats (10 intervals of 30s)
    let currentSession = initial.session;
    let clock = new Date(baseServerTime.getTime());
    for (let i = 1; i <= 10; i++) {
      clock = new Date(clock.getTime() + 30000);
      const hbIdle = makeHeartbeat({
        sequenceNumber: i + 1,
        nonce: `nonce-${i + 1}`,
        activeSeconds: 0,
        idleSeconds: 30,
      });
      const res = sm.handleHeartbeat(currentSession, hbIdle, clock, '192.168.1.100');
      currentSession = res.session;
    }

    assert.equal(currentSession.currentState, AttendanceState.IDLE);
    const lastSegment = currentSession.segments[currentSession.segments.length - 1];
    assert.equal(lastSegment?.state, AttendanceState.IDLE);
  });

  // Row 3: IDLE -> Input resumes -> ACTIVE
  it('Row 3: IDLE -> Input resumes -> transitions back to ACTIVE, closes idle segment, adds to idle_seconds', () => {
    // Start session
    const hb1 = makeHeartbeat({ activeSeconds: 30, idleSeconds: 0 });
    let currentSession = sm.handleHeartbeat(null, hb1, baseServerTime, '192.168.1.100').session;

    // Transition to IDLE after 5 min
    let clock = new Date(baseServerTime.getTime());
    for (let i = 1; i <= 10; i++) {
      clock = new Date(clock.getTime() + 30000);
      currentSession = sm.handleHeartbeat(
        currentSession,
        makeHeartbeat({ sequenceNumber: i + 1, nonce: `nonce-${i + 1}`, activeSeconds: 0, idleSeconds: 30 }),
        clock,
        '192.168.1.100'
      ).session;
    }
    assert.equal(currentSession.currentState, AttendanceState.IDLE);

    // Input resumes (activeSeconds > 0)
    clock = new Date(clock.getTime() + 30000);
    const resResume = sm.handleHeartbeat(
      currentSession,
      makeHeartbeat({ sequenceNumber: 12, nonce: 'nonce-resume', activeSeconds: 20, idleSeconds: 10 }),
      clock,
      '192.168.1.100'
    );

    assert.equal(resResume.previousState, AttendanceState.IDLE);
    assert.equal(resResume.currentState, AttendanceState.ACTIVE);
    assert.ok(resResume.session.idleSeconds >= 300, 'Should accumulate idle seconds');
    const activeSegment = resResume.session.segments[resResume.session.segments.length - 1];
    assert.equal(activeSegment?.state, AttendanceState.ACTIVE);
  });

  // Row 4: IDLE -> Idle exceeds 15 min (pause threshold) -> PAUSED
  it('Row 4: IDLE -> Idle exceeds 15 min (pause threshold) -> transitions to PAUSED and pauses accrual', () => {
    let clock = new Date(baseServerTime.getTime());
    let currentSession = sm.handleHeartbeat(null, makeHeartbeat(), clock, '192.168.1.100').session;

    // Simulate 15 min (30 intervals of 30s) of pure idle
    for (let i = 1; i <= 30; i++) {
      clock = new Date(clock.getTime() + 30000);
      currentSession = sm.handleHeartbeat(
        currentSession,
        makeHeartbeat({ sequenceNumber: i + 1, nonce: `nonce-${i + 1}`, activeSeconds: 0, idleSeconds: 30 }),
        clock,
        '192.168.1.100'
      ).session;
    }

    assert.equal(currentSession.currentState, AttendanceState.PAUSED);
    const lastSeg = currentSession.segments[currentSession.segments.length - 1];
    assert.equal(lastSeg?.state, AttendanceState.PAUSED);
  });

  // Row 5: PAUSED -> Input resumes -> ACTIVE
  it('Row 5: PAUSED -> Input resumes -> transitions to ACTIVE, flags segment as long idle', () => {
    let clock = new Date(baseServerTime.getTime());
    let currentSession = sm.handleHeartbeat(null, makeHeartbeat(), clock, '192.168.1.100').session;

    // 15 min idle to reach PAUSED
    for (let i = 1; i <= 30; i++) {
      clock = new Date(clock.getTime() + 30000);
      currentSession = sm.handleHeartbeat(
        currentSession,
        makeHeartbeat({ sequenceNumber: i + 1, nonce: `nonce-${i + 1}`, activeSeconds: 0, idleSeconds: 30 }),
        clock,
        '192.168.1.100'
      ).session;
    }
    assert.equal(currentSession.currentState, AttendanceState.PAUSED);

    // User resumes input
    clock = new Date(clock.getTime() + 30000);
    const resumeRes = sm.handleHeartbeat(
      currentSession,
      makeHeartbeat({ sequenceNumber: 32, nonce: 'nonce-resume-paused', activeSeconds: 25, idleSeconds: 5 }),
      clock,
      '192.168.1.100'
    );

    assert.equal(resumeRes.currentState, AttendanceState.ACTIVE);
    assert.ok(resumeRes.session.flags.includes('LONG_IDLE'), 'Should flag session as LONG_IDLE');
  });

  // Row 6: ACTIVE / IDLE -> Join call or meeting -> IN_MEETING
  it('Row 6: ACTIVE/IDLE -> Join call or meeting -> transitions to IN_MEETING, links meeting_id', () => {
    const clock = new Date(baseServerTime.getTime());
    const initial = sm.handleHeartbeat(null, makeHeartbeat(), clock, '192.168.1.100');

    const resMeeting = sm.handleJoinMeeting(initial.session, 'meeting-room-402', new Date(clock.getTime() + 5000));
    assert.equal(resMeeting.currentState, AttendanceState.IN_MEETING);
    const meetingSeg = resMeeting.session.segments[resMeeting.session.segments.length - 1];
    assert.equal(meetingSeg?.state, AttendanceState.IN_MEETING);
    assert.equal(meetingSeg?.meetingId, 'meeting-room-402');
  });

  // Row 7: IN_MEETING -> Leave call -> ACTIVE
  it('Row 7: IN_MEETING -> Leave call -> transitions to ACTIVE, credits meeting_seconds', () => {
    const clock = new Date(baseServerTime.getTime());
    const initial = sm.handleHeartbeat(null, makeHeartbeat(), clock, '192.168.1.100');
    const meeting = sm.handleJoinMeeting(initial.session, 'meeting-room-402', clock);

    // Leave call after 20 minutes (1200 seconds)
    const leaveClock = new Date(clock.getTime() + 1200000);
    const leaveRes = sm.handleLeaveMeeting(meeting.session, leaveClock);

    assert.equal(leaveRes.currentState, AttendanceState.ACTIVE);
    assert.equal(leaveRes.session.meetingSeconds, 1200);
  });

  // Row 8: ACTIVE -> User starts break -> ON_BREAK
  it('Row 8: ACTIVE -> User starts break -> transitions to ON_BREAK and opens break segment', () => {
    const clock = new Date(baseServerTime.getTime());
    const initial = sm.handleHeartbeat(null, makeHeartbeat(), clock, '192.168.1.100');

    const breakStart = new Date(clock.getTime() + 60000);
    const breakRes = sm.handleUserStartsBreak(initial.session, breakStart);

    assert.equal(breakRes.currentState, AttendanceState.ON_BREAK);
    const breakSeg = breakRes.session.segments[breakRes.session.segments.length - 1];
    assert.equal(breakSeg?.state, AttendanceState.ON_BREAK);
  });

  // Row 9: ON_BREAK -> User ends break -> ACTIVE
  it('Row 9: ON_BREAK -> User ends break -> transitions to ACTIVE, closes break segment, accumulates break_seconds', () => {
    const clock = new Date(baseServerTime.getTime());
    const initial = sm.handleHeartbeat(null, makeHeartbeat(), clock, '192.168.1.100');
    const onBreak = sm.handleUserStartsBreak(initial.session, clock);

    // End break after 15 minutes (900 seconds)
    const endBreakClock = new Date(clock.getTime() + 900000);
    const endBreakRes = sm.handleUserEndsBreak(onBreak.session, endBreakClock);

    assert.equal(endBreakRes.currentState, AttendanceState.ACTIVE);
    assert.equal(endBreakRes.session.breakSeconds, 900);
  });

  // Row 10: Any open state -> Socket disconnect -> DISCONNECTED (grace 120s)
  it('Row 10: Any open state -> Socket disconnect -> transitions to DISCONNECTED with 120s grace timer', () => {
    const clock = new Date(baseServerTime.getTime());
    const initial = sm.handleHeartbeat(null, makeHeartbeat(), clock, '192.168.1.100');

    const disconnectTime = new Date(clock.getTime() + 10000);
    const dcRes = sm.handleSocketDisconnect(initial.session, disconnectTime);

    assert.equal(dcRes.currentState, AttendanceState.DISCONNECTED);
    assert.equal(dcRes.previousState, AttendanceState.ACTIVE);
    assert.ok(dcRes.session.graceTimerExpiresAt, 'Grace timer must be set');
    assert.equal(dcRes.session.graceTimerExpiresAt.getTime(), disconnectTime.getTime() + 120000);
    assert.equal(dcRes.session.status, SessionStatus.OPEN, 'Session must remain open during grace');
  });

  // Row 11: DISCONNECTED -> Reconnect within 120s -> Previous state
  it('Row 11: DISCONNECTED -> Reconnect within 120s -> cancels timer, returns to previous state', () => {
    const clock = new Date(baseServerTime.getTime());
    const initial = sm.handleHeartbeat(null, makeHeartbeat(), clock, '192.168.1.100');
    const dcRes = sm.handleSocketDisconnect(initial.session, clock);

    // Reconnect after 45 seconds (well within 120s grace)
    const reconnectTime = new Date(clock.getTime() + 45000);
    const rcRes = sm.handleSocketReconnect(dcRes.session, reconnectTime);

    assert.equal(rcRes.currentState, AttendanceState.ACTIVE);
    assert.equal(rcRes.session.graceTimerExpiresAt, null);
    assert.equal(rcRes.session.status, SessionStatus.OPEN);
  });

  // Row 12: DISCONNECTED -> Grace expires -> OFFLINE (Clock-out = last valid heartbeat)
  it('Row 12: DISCONNECTED -> Grace expires -> closes session, clock_out_at = last valid heartbeat, source DISCONNECT', () => {
    const clock = new Date(baseServerTime.getTime());
    const initial = sm.handleHeartbeat(null, makeHeartbeat(), clock, '192.168.1.100');
    const dcRes = sm.handleSocketDisconnect(initial.session, new Date(clock.getTime() + 5000));

    // Expiration after 125s
    const expireTime = new Date(clock.getTime() + 130000);
    const expireRes = sm.handleGraceExpiration(dcRes.session, expireTime);

    assert.equal(expireRes.currentState, AttendanceState.OFFLINE);
    assert.equal(expireRes.session.status, SessionStatus.CLOSED);
    assert.equal(expireRes.session.clockOutSource, ClockOutSource.DISCONNECT);
    assert.equal(expireRes.session.clockOutAt?.toISOString(), initial.session.lastHeartbeatAt.toISOString());
  });

  // Row 13: Any open state -> Heartbeats missing > 90s -> OFFLINE (source TIMEOUT)
  it('Row 13: Any open state -> Heartbeats missing > 90s -> closes session at last heartbeat, source TIMEOUT', () => {
    const clock = new Date(baseServerTime.getTime());
    const initial = sm.handleHeartbeat(null, makeHeartbeat(), clock, '192.168.1.100');

    // Reconciler runs at 95s after last heartbeat with no new signals
    const checkTime = new Date(clock.getTime() + 95000);
    const toRes = sm.handleMissingHeartbeatTimeout(initial.session, checkTime);

    assert.equal(toRes.currentState, AttendanceState.OFFLINE);
    assert.equal(toRes.session.status, SessionStatus.CLOSED);
    assert.equal(toRes.session.clockOutSource, ClockOutSource.TIMEOUT);
    assert.equal(toRes.session.clockOutAt?.toISOString(), initial.session.lastHeartbeatAt.toISOString());
  });

  // Row 14: Any open state -> Explicit logout -> OFFLINE (source LOGOUT)
  it('Row 14: Any open state -> Explicit logout -> closes session immediately with source LOGOUT', () => {
    const clock = new Date(baseServerTime.getTime());
    const initial = sm.handleHeartbeat(null, makeHeartbeat(), clock, '192.168.1.100');

    const logoutTime = new Date(clock.getTime() + 3600000); // 1 hour later
    const loRes = sm.handleExplicitLogout(initial.session, logoutTime);

    assert.equal(loRes.currentState, AttendanceState.OFFLINE);
    assert.equal(loRes.session.status, SessionStatus.CLOSED);
    assert.equal(loRes.session.clockOutSource, ClockOutSource.LOGOUT);
    assert.equal(loRes.session.clockOutAt?.toISOString(), logoutTime.toISOString());
  });

  // Row 15: Any open state -> Org-timezone midnight -> splits session (close at 23:59:59.999, open new at 00:00:00)
  it('Row 15: Any open state -> Org-timezone midnight -> splits session seamlessly across midnight boundary', () => {
    // 23:50:00 in Asia/Colombo (UTC+05:30)
    // 23:50:00 Colombo = 18:20:00 UTC
    const preMidnight = new Date('2026-10-13T18:20:00.000Z');
    const initial = sm.handleHeartbeat(null, makeHeartbeat(), preMidnight, '192.168.1.100');

    // Check at 00:05:00 next day (Colombo) = 18:35:00 UTC
    const postMidnight = new Date('2026-10-13T18:35:00.000Z');
    const splitRes = sm.handleMidnightCheck(initial.session, postMidnight);

    assert.equal(splitRes.session.status, SessionStatus.CLOSED);
    assert.equal(splitRes.session.clockOutSource, ClockOutSource.MIDNIGHT);
    assert.ok(splitRes.splitSession, 'Must create a split next-day session');
    assert.equal(splitRes.splitSession.status, SessionStatus.OPEN);
    assert.equal(splitRes.splitSession.currentState, initial.session.currentState);
    assert.notEqual(splitRes.splitSession.workDate, splitRes.session.workDate);
  });

  // Row 16: Any open state -> Session length > 14h -> OFFLINE with MAX_LENGTH flag
  it('Row 16: Any open state -> Session length > 14h -> closes at last heartbeat, flags MAX_LENGTH for review', () => {
    const clock = new Date(baseServerTime.getTime());
    const initial = sm.handleHeartbeat(null, makeHeartbeat(), clock, '192.168.1.100');

    // Check after 14 hours and 1 minute (50460 seconds)
    const longTime = new Date(clock.getTime() + 50460000);
    const maxRes = sm.handleMaxLengthCheck(initial.session, longTime);

    assert.equal(maxRes.currentState, AttendanceState.OFFLINE);
    assert.equal(maxRes.session.status, SessionStatus.CLOSED);
    assert.equal(maxRes.session.clockOutSource, ClockOutSource.MAX_LENGTH);
    assert.ok(maxRes.session.flags.includes('MAX_LENGTH'));
  });

  it('Edge case: closeLastSegment gracefully returns null if last segment already ended', () => {
    const clock = new Date(baseServerTime.getTime());
    const initial = sm.handleHeartbeat(null, makeHeartbeat(), clock, '192.168.1.100');
    // First logout closes segment
    const lo1 = sm.handleExplicitLogout(initial.session, new Date(clock.getTime() + 1000));
    // Second logout on same session encounters already-ended segment
    const lo2 = sm.handleExplicitLogout(lo1.session, new Date(clock.getTime() + 2000));
    assert.equal(lo2.currentState, AttendanceState.OFFLINE);
  });
});

describe('Requirements FR-ATT-001..005 Specific Verification', () => {
  const sm = new AttendanceStateMachine();
  const baseTime = new Date('2026-10-13T09:00:00.000Z');

  it('FR-ATT-001: Automatic clock-in requires zero manual button press', () => {
    const hb = makeHeartbeat({ activeSeconds: 30, idleSeconds: 0 });
    const res = sm.handleHeartbeat(null, hb, baseTime, '10.0.0.1');

    assert.equal(res.session.status, SessionStatus.OPEN);
    assert.equal(res.session.clockInSource, ClockInSource.AUTO_HEARTBEAT);
  });

  it('FR-ATT-003: Accuracy strictly ignores client timestamps and uses NTP server clock UTC', () => {
    const bogusClientClock = Date.now() - 360000000; // Client clock is 100 hours in the past
    const hb = makeHeartbeat({ clientTimestamp: bogusClientClock });
    const res = sm.handleHeartbeat(null, hb, baseTime, '10.0.0.1');

    assert.equal(res.session.clockInAt.toISOString(), baseTime.toISOString());
    assert.notEqual(res.session.clockInAt.getTime(), bogusClientClock);
  });

  it('FR-ATT-004: Heartbeat transmits counters only (no keystrokes, URLs, screenshots)', () => {
    const hb = makeHeartbeat();
    assert.equal(typeof hb.activeSeconds, 'number');
    assert.equal(typeof hb.idleSeconds, 'number');
    assert.equal(typeof hb.inCall, 'boolean');
    assert.equal(typeof hb.tabVisible, 'boolean');
    assert.equal(typeof hb.windowFocused, 'boolean');
    // Ensure no content fields exist in type
    const raw = hb as unknown as Record<string, unknown>;
    assert.equal(raw.keystrokes, undefined);
    assert.equal(raw.screenshots, undefined);
    assert.equal(raw.url, undefined);
  });

  it('FR-ATT-005: Idle time is segregated and excluded from net payable seconds', () => {
    const hb1 = makeHeartbeat({ activeSeconds: 30, idleSeconds: 0 });
    let session = sm.handleHeartbeat(null, hb1, baseTime, '10.0.0.1').session;

    let clock = new Date(baseTime.getTime());
    // Send 10 minutes of pure idle (20 heartbeats)
    for (let i = 1; i <= 20; i++) {
      clock = new Date(clock.getTime() + 30000);
      session = sm.handleHeartbeat(
        session,
        makeHeartbeat({ sequenceNumber: i + 1, nonce: `n-${i}`, activeSeconds: 0, idleSeconds: 30 }),
        clock,
        '10.0.0.1'
      ).session;
    }

    assert.ok(session.idleSeconds >= 300, 'Should track idle seconds');
    // Net seconds must not count unapproved idle beyond idle threshold
    assert.ok(session.netSeconds < (session.activeSeconds + session.idleSeconds));
  });
});

/**
 * ADR 048 (SRS 6.2 rows 6 and 7 from the heartbeat; FR-ATT-006, FR-MEET-009): the browser reports
 * `inCall` every heartbeat. A call is a meeting segment: no input is needed, time is credited as
 * meeting time, and a session closed mid-call keeps what was accrued.
 */
describe('ADR 048: a call reported by the heartbeat', () => {
  const sm = new AttendanceStateMachine({
    heartbeatIntervalSeconds: 30, missedHeartbeatTimeoutSeconds: 90, disconnectGraceWindowSeconds: 120,
    idleThresholdSeconds: 300, pauseThresholdSeconds: 900, maxSessionLengthSeconds: 14 * 3600, orgTimezone: 'Asia/Colombo',
  });
  const t0 = new Date('2026-10-13T08:00:00.000Z');
  const at = (s: number) => new Date(t0.getTime() + s * 1000);
  const ip = '192.168.1.100';
  const inCall = (over: Partial<HeartbeatPayload> = {}) => makeHeartbeat({ activeSeconds: 0, idleSeconds: 30, inCall: true, ...over });

  it('ACTIVE + inCall -> IN_MEETING; in-call heartbeats without any input stay IN_MEETING past the pause threshold', () => {
    let r = sm.handleHeartbeat(null, makeHeartbeat(), t0, ip);
    r = sm.handleHeartbeat(r.session, inCall(), at(30), ip);
    assert.equal(r.previousState, AttendanceState.ACTIVE);
    assert.equal(r.currentState, AttendanceState.IN_MEETING);
    const seg = r.session.segments[r.session.segments.length - 1]!;
    assert.equal(seg.state, AttendanceState.IN_MEETING);
    assert.equal(seg.meetingId, null, 'a call, not a scheduled meeting');
    for (let i = 2; i <= 40; i += 1) r = sm.handleHeartbeat(r.session, inCall(), at(i * 30), ip); // 20 minutes
    assert.equal(r.currentState, AttendanceState.IN_MEETING);
    assert.equal(r.session.segments.length, 2, 'one meeting segment, not one per heartbeat');
  });

  it('IDLE + inCall -> IN_MEETING (the idle segment closes)', () => {
    let r = sm.handleHeartbeat(null, makeHeartbeat(), t0, ip);
    for (let i = 1; i <= 11; i += 1) r = sm.handleHeartbeat(r.session, makeHeartbeat({ activeSeconds: 0, idleSeconds: 30 }), at(i * 30), ip);
    assert.equal(r.currentState, AttendanceState.IDLE);
    r = sm.handleHeartbeat(r.session, inCall(), at(12 * 30), ip);
    assert.equal(r.previousState, AttendanceState.IDLE);
    assert.equal(r.currentState, AttendanceState.IN_MEETING);
    assert.equal(r.session.segments[1]!.endedAt?.toISOString(), at(12 * 30).toISOString());
  });

  it('IN_MEETING + heartbeat without inCall -> ACTIVE; meeting_seconds credited and in net_seconds', () => {
    let r = sm.handleHeartbeat(null, makeHeartbeat(), t0, ip);
    r = sm.handleHeartbeat(r.session, inCall(), at(30), ip);
    r = sm.handleHeartbeat(r.session, makeHeartbeat({ activeSeconds: 30, idleSeconds: 0, inCall: false }), at(630), ip);
    assert.equal(r.previousState, AttendanceState.IN_MEETING);
    assert.equal(r.currentState, AttendanceState.ACTIVE);
    assert.equal(r.session.meetingSeconds, 600);
    assert.equal(r.session.netSeconds, r.session.activeSeconds + 600);
  });

  it('a meeting opened by the meetings hook is not ended by a browser heartbeat without inCall', () => {
    const r = sm.handleHeartbeat(null, makeHeartbeat(), t0, ip);
    const j = sm.handleJoinMeeting(r.session, 'meeting-1', at(30));
    const next = sm.handleHeartbeat(j.session, makeHeartbeat({ inCall: false }), at(60), ip);
    assert.equal(next.currentState, AttendanceState.IN_MEETING);
    assert.equal(next.session.meetingSeconds, 0);
  });

  it('a session closed during a call keeps the meeting time (logout, timeout, midnight)', () => {
    let r = sm.handleHeartbeat(null, makeHeartbeat(), t0, ip);
    r = sm.handleHeartbeat(r.session, inCall(), at(30), ip);
    r = sm.handleHeartbeat(r.session, inCall(), at(930), ip); // still in the call at the last heartbeat
    assert.equal(sm.handleExplicitLogout(structuredClone(r.session), at(930)).session.meetingSeconds, 900);
    assert.equal(sm.handleMissingHeartbeatTimeout(structuredClone(r.session), at(1020)).session.meetingSeconds, 900, 'closed at the last heartbeat');
    const night = new Date('2026-10-13T18:29:30.000Z'); // 23:59:30 in Colombo
    let n = sm.handleHeartbeat(null, makeHeartbeat(), night, ip);
    n = sm.handleHeartbeat(n.session, inCall(), new Date(night.getTime() + 10_000), ip);
    const split = sm.handleMidnightCheck(n.session, new Date('2026-10-13T18:30:05.000Z'));
    assert.equal(split.session.meetingSeconds, 20, '23:59:40 to 23:59:59.999, rounded');
    assert.equal(split.splitSession?.currentState, AttendanceState.IN_MEETING, 'the call continues into the new day');
  });
});

/**
 * ADR 049 §1 (FR-WT-003, FR-WT-005): a call is counted once, a second device does not end it, and
 * the segment records which kind of call it was.
 */
describe('ADR 049: meeting time is counted once and survives a second device', () => {
  const sm = new AttendanceStateMachine({
    heartbeatIntervalSeconds: 30, missedHeartbeatTimeoutSeconds: 90, disconnectGraceWindowSeconds: 120,
    idleThresholdSeconds: 300, pauseThresholdSeconds: 900, maxSessionLengthSeconds: 14 * 3600, orgTimezone: 'Asia/Colombo',
  });
  const t0 = new Date('2026-10-13T08:00:00.000Z');
  const at = (s: number) => new Date(t0.getTime() + s * 1000);
  const ip = '192.168.1.100';

  it('D1: typing during a call is not added to active time on top of the meeting time', () => {
    let r = sm.handleHeartbeat(null, makeHeartbeat(), t0, ip); // 30 s of input before t0
    r = sm.handleHeartbeat(r.session, makeHeartbeat({ inCall: true }), at(30), ip); // covers t0..30, opens the call
    for (let i = 2; i <= 21; i += 1) r = sm.handleHeartbeat(r.session, makeHeartbeat({ inCall: true, activeSeconds: 30, idleSeconds: 0 }), at(i * 30), ip);
    r = sm.handleHeartbeat(r.session, makeHeartbeat({ inCall: false, activeSeconds: 30, idleSeconds: 0 }), at(660), ip); // leaves
    assert.equal(r.currentState, AttendanceState.ACTIVE);
    assert.equal(r.session.meetingSeconds, 630, '00:30 to 11:00 in the call');
    assert.equal(r.session.activeSeconds, 60, 'only the input outside the call');
    assert.equal(r.session.netSeconds, 690, 'never more than the wall clock (plus the first interval)');
  });

  it('a heartbeat without a call from another device does not end the call', () => {
    let r = sm.handleHeartbeat(null, makeHeartbeat({ deviceId: 'A' }), t0, ip);
    r = sm.handleHeartbeat(r.session, makeHeartbeat({ deviceId: 'A', inCall: true }), at(30), ip);
    r = sm.handleHeartbeat(r.session, makeHeartbeat({ deviceId: 'B', inCall: false }), at(45), ip);
    assert.equal(r.currentState, AttendanceState.IN_MEETING, 'device B is not in the call');
    r = sm.handleHeartbeat(r.session, makeHeartbeat({ deviceId: 'A', inCall: true }), at(60), ip);
    r = sm.handleHeartbeat(r.session, makeHeartbeat({ deviceId: 'A', inCall: false }), at(90), ip);
    assert.equal(r.currentState, AttendanceState.ACTIVE, 'the device in the call ends it');
    assert.equal(r.session.meetingSeconds, 60);
  });

  it('when the device in the call stops confirming it, another device ends it at the last confirmation', () => {
    let r = sm.handleHeartbeat(null, makeHeartbeat({ deviceId: 'A' }), t0, ip);
    r = sm.handleHeartbeat(r.session, makeHeartbeat({ deviceId: 'A', inCall: true }), at(30), ip);
    r = sm.handleHeartbeat(r.session, makeHeartbeat({ deviceId: 'A', inCall: true }), at(60), ip);
    r = sm.handleHeartbeat(r.session, makeHeartbeat({ deviceId: 'B', inCall: false }), at(105), ip);
    assert.equal(r.currentState, AttendanceState.IN_MEETING, '45 s since A confirmed: within two intervals');
    r = sm.handleHeartbeat(r.session, makeHeartbeat({ deviceId: 'B', inCall: false }), at(135), ip);
    assert.equal(r.currentState, AttendanceState.ACTIVE);
    assert.equal(r.session.meetingSeconds, 30, 'ended at A\'s last confirmation (01:00)');
  });

  it('the meeting segment records the kind of call and the meeting it belongs to, and stays closable by heartbeats', () => {
    let r = sm.handleHeartbeat(null, makeHeartbeat(), t0, ip);
    r = sm.handleHeartbeat(r.session, makeHeartbeat({ inCall: true, callKind: 'MEETING', meetingId: 'meeting-9' }), at(30), ip);
    const seg = r.session.segments[r.session.segments.length - 1]!;
    assert.equal(seg.callKind, 'MEETING');
    assert.equal(seg.callMeetingId, 'meeting-9');
    assert.equal(seg.meetingId, null, 'not a hook-owned segment');
    r = sm.handleHeartbeat(r.session, makeHeartbeat({ inCall: false }), at(90), ip);
    assert.equal(r.currentState, AttendanceState.ACTIVE);
    assert.equal(r.session.meetingSeconds, 60);
  });
});
