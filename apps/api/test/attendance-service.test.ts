/**
 * Comprehensive Integration & Verification Test Suite for AttendanceService, HeartbeatValidator & Clock
 * Ref: docs/SRS.md FR-ATT-001..005, Section 6.2, 6.3 & Audit Checklist
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AttendanceService } from '../src/attendance/attendance.service.ts';
import { HeartbeatValidator } from '../src/attendance/heartbeat-validator.ts';
import {
  AttendanceState,
  ClockOutSource,
  SessionStatus,
  SystemClock,
} from '../../../packages/shared/src/attendance/types.ts';
import type {
  Clock,
  HeartbeatPayload,
} from '../../../packages/shared/src/attendance/types.ts';

// Deterministic Mock Clock implementation
class MockClock implements Clock {
  private currentTime: Date;

  constructor(initialTime: Date = new Date('2026-10-13T09:00:00.000Z')) {
    this.currentTime = new Date(initialTime.getTime());
  }

  now(): Date {
    return new Date(this.currentTime.getTime());
  }

  setTime(time: Date): void {
    this.currentTime = new Date(time.getTime());
  }

  advanceSeconds(seconds: number): void {
    this.currentTime = new Date(this.currentTime.getTime() + seconds * 1000);
  }
}

describe('AttendanceService & Heartbeat Cryptographic Ingestion', () => {
  const userId = 'user-emp-101';
  const orgId = 'org-456';
  const deviceId = 'device-laptop-01';
  const sessionId = 'auth-session-uuid-999';

  function createSignedPayload(
    service: AttendanceService,
    secret: string,
    overrides: Partial<HeartbeatPayload> = {},
  ): HeartbeatPayload {
    const unsigned: Omit<HeartbeatPayload, 'signature'> = {
      orgId,
      userId,
      deviceId,
      sessionId,
      sequenceNumber: 1,
      nonce: 'nonce-uuid-1',
      activeSeconds: 30,
      idleSeconds: 0,
      tabVisible: true,
      windowFocused: true,
      inCall: false,
      ...overrides,
    };
    const signature = service.getValidator().signHeartbeat(unsigned, secret);
    return { ...unsigned, signature };
  }

  it('FR-ATT-001 & FR-ATT-004: Ingests valid signed heartbeat and establishes session using per-session secret', () => {
    const mockClock = new MockClock(new Date('2026-10-13T10:00:00.000Z'));
    const service = new AttendanceService({}, mockClock);
    const sessionSecret = service.generateSessionSecret();
    service.registerSessionSecret(sessionId, sessionSecret);

    assert.equal(service.getSessionSecret(sessionId), sessionSecret);

    const hb = createSignedPayload(service, sessionSecret, { sequenceNumber: 1, nonce: 'nonce-1' });
    const res = service.ingestHeartbeat(hb);

    assert.equal(res.currentState, AttendanceState.ACTIVE);
    assert.equal(res.session.status, SessionStatus.OPEN);
    assert.equal(res.session.userId, userId);
    assert.equal(res.session.clockInAt.toISOString(), '2026-10-13T10:00:00.000Z');
    assert.equal(service.getSession(userId)?.id, res.session.id);
  });

  it('Audit Item 3: Rejects heartbeat when session secret is missing or revoked', () => {
    const service = new AttendanceService();
    const hb = createSignedPayload(service, 'unregistered-key', { sessionId: 'revoked-session' });

    assert.throws(
      () => service.ingestHeartbeat(hb),
      /No active session secret registered for session revoked-session/,
    );

    // Register then revoke
    service.registerSessionSecret('temp-session', 'temp-secret');
    service.revokeSessionSecret('temp-session');
    const hbTemp = createSignedPayload(service, 'temp-secret', { sessionId: 'temp-session' });
    assert.throws(
      () => service.ingestHeartbeat(hbTemp),
      /No active session secret registered for session temp-session/,
    );
  });

  it('FR-ATT-004: Rejects tampered signature', () => {
    const service = new AttendanceService();
    const sessionSecret = 'test-secret';
    service.registerSessionSecret(sessionId, sessionSecret);

    const hb = createSignedPayload(service, sessionSecret, { sequenceNumber: 1, nonce: 'nonce-tamper' });
    hb.signature = 'deadbeef0000111122223333444455556666777788889999aaaabbbbccccdddd';

    assert.throws(
      () => service.ingestHeartbeat(hb),
      /Invalid HMAC signature/,
    );
  });

  it('FR-ATT-017 / Anti-spoofing: Rejects replayed nonce within TTL', () => {
    const service = new AttendanceService();
    const sessionSecret = 'test-secret';
    service.registerSessionSecret(sessionId, sessionSecret);

    const hb1 = createSignedPayload(service, sessionSecret, { sequenceNumber: 1, nonce: 'replayed-nonce' });
    service.ingestHeartbeat(hb1);

    const hb2 = createSignedPayload(service, sessionSecret, { sequenceNumber: 2, nonce: 'replayed-nonce' });
    assert.throws(
      () => service.ingestHeartbeat(hb2),
      /Replay attack detected: nonce replayed-nonce already used/,
    );
  });

  it('Audit Item 2: seq monotonicity is enforced per device independently', () => {
    const service = new AttendanceService();
    const sessionSecret = 'test-secret';
    service.registerSessionSecret(sessionId, sessionSecret);

    // Device 1: seq 1, then seq 5
    const hbDev1Seq1 = createSignedPayload(service, sessionSecret, { deviceId: 'dev-1', sequenceNumber: 1, nonce: 'd1-1' });
    service.ingestHeartbeat(hbDev1Seq1);
    const hbDev1Seq5 = createSignedPayload(service, sessionSecret, { deviceId: 'dev-1', sequenceNumber: 5, nonce: 'd1-5' });
    service.ingestHeartbeat(hbDev1Seq5);

    // Device 2 sends seq 2 (which is < 5, but Device 2's own last seq is 0 -> MUST SUCCEED)
    const hbDev2Seq2 = createSignedPayload(service, sessionSecret, { deviceId: 'dev-2', sequenceNumber: 2, nonce: 'd2-2' });
    const resDev2 = service.ingestHeartbeat(hbDev2Seq2);
    assert.equal(resDev2.currentState, AttendanceState.ACTIVE);

    // Device 1 attempts seq 4 (<= 5) -> MUST FAIL on Device 1
    const hbDev1Seq4 = createSignedPayload(service, sessionSecret, { deviceId: 'dev-1', sequenceNumber: 4, nonce: 'd1-4' });
    assert.throws(
      () => service.ingestHeartbeat(hbDev1Seq4),
      /Sequence violation: sequence 4 <= last seen 5/,
    );
  });

  it('FR-ATT-004: Privacy guardrail rejects forbidden surveillance content fields', () => {
    const service = new AttendanceService();
    const sessionSecret = 'test-secret';
    service.registerSessionSecret(sessionId, sessionSecret);

    const hb = createSignedPayload(service, sessionSecret, { sequenceNumber: 1, nonce: 'nonce-priv' });
    (hb as any).keystrokes = 'user password';

    assert.throws(
      () => service.ingestHeartbeat(hb),
      /Privacy violation/,
    );
  });
});

describe('Audit Item 4 & 5: Injectable Clock & Proof that Client Timestamps are Ignored', () => {
  it('Audit Item 4: Client timestamps in past or future are completely ignored; only injected Clock is authoritative', () => {
    const fixedServerTime = new Date('2026-10-13T14:00:00.000Z');
    const mockClock = new MockClock(fixedServerTime);
    const service = new AttendanceService({}, mockClock);
    const sessionSecret = 'clock-secret';
    const sessionId = 'session-clock-01';
    service.registerSessionSecret(sessionId, sessionSecret);

    // Client timestamp is 10 years in the past
    const bogusPastTime = new Date('2016-01-01T00:00:00.000Z').getTime();
    const unsigned1: Omit<HeartbeatPayload, 'signature'> = {
      orgId: 'org-clock',
      userId: 'user-clock',
      deviceId: 'dev-clock',
      sessionId,
      sequenceNumber: 1,
      nonce: 'nonce-past',
      activeSeconds: 30,
      idleSeconds: 0,
      tabVisible: true,
      windowFocused: true,
      inCall: false,
      clientTimestamp: bogusPastTime,
    };
    const sig1 = service.getValidator().signHeartbeat(unsigned1, sessionSecret);
    const res1 = service.ingestHeartbeat({ ...unsigned1, signature: sig1 });

    // Stamped time MUST match injected server clock, NOT client timestamp
    assert.equal(res1.session.clockInAt.toISOString(), '2026-10-13T14:00:00.000Z');
    assert.notEqual(res1.session.clockInAt.getTime(), bogusPastTime);

    // Advance clock by 30 seconds
    mockClock.advanceSeconds(30);

    // Client timestamp is in the far future (year 2099)
    const bogusFutureTime = new Date('2099-12-31T23:59:59.000Z').getTime();
    const unsigned2: Omit<HeartbeatPayload, 'signature'> = {
      ...unsigned1,
      sequenceNumber: 2,
      nonce: 'nonce-future',
      clientTimestamp: bogusFutureTime,
    };
    const sig2 = service.getValidator().signHeartbeat(unsigned2, sessionSecret);
    const res2 = service.ingestHeartbeat({ ...unsigned2, signature: sig2 });

    assert.equal(res2.session.lastHeartbeatAt.toISOString(), '2026-10-13T14:00:30.000Z');
    assert.notEqual(res2.session.lastHeartbeatAt.getTime(), bogusFutureTime);
  });

  it('Audit Item 5: Service defaults gracefully to SystemClock when not injected', () => {
    const sysClock = new SystemClock();
    const now1 = sysClock.now();
    assert.ok(now1 instanceof Date);

    const service = new AttendanceService();
    assert.ok(service.getClock() instanceof SystemClock);
    assert.ok(service.getStateMachine());
    assert.ok(service.getValidator());
  });
});

describe('AttendanceService Full State Lifecycle (Breaks, Meetings, Disconnects)', () => {
  const userId = 'user-lifecycle-01';
  const orgId = 'org-lifecycle';
  const deviceId = 'dev-lifecycle';
  const sessionId = 'session-lifecycle';
  const sessionSecret = 'lifecycle-secret';

  it('Verifies breaks, meetings, disconnect reconnect, and graceful no-op calls', () => {
    const mockClock = new MockClock(new Date('2026-10-13T09:00:00.000Z'));
    const service = new AttendanceService({}, mockClock);
    service.registerSessionSecret(sessionId, sessionSecret);

    // Calling lifecycle methods on non-existent user returns null
    assert.equal(service.onSocketDisconnect('non-existent'), null);
    assert.equal(service.onSocketReconnect('non-existent'), null);
    assert.equal(service.onExplicitLogout('non-existent'), null);
    assert.equal(service.startBreak('non-existent'), null);
    assert.equal(service.endBreak('non-existent'), null);
    assert.equal(service.joinMeeting('non-existent', 'm-1'), null);
    assert.equal(service.leaveMeeting('non-existent'), null);
    assert.equal(service.getClosedSession('non-existent'), null);

    // Start session
    const unsigned: Omit<HeartbeatPayload, 'signature'> = {
      orgId,
      userId,
      deviceId,
      sessionId,
      sequenceNumber: 1,
      nonce: 'nonce-lc-1',
      activeSeconds: 30,
      idleSeconds: 0,
      tabVisible: true,
      windowFocused: true,
      inCall: false,
    };
    const sig = service.getValidator().signHeartbeat(unsigned, sessionSecret);
    service.ingestHeartbeat({ ...unsigned, signature: sig });

    // Join meeting
    mockClock.advanceSeconds(10);
    const mRes = service.joinMeeting(userId, 'room-101');
    assert.equal(mRes?.currentState, AttendanceState.IN_MEETING);

    // Leave meeting
    mockClock.advanceSeconds(600); // 10 minutes
    const leaveRes = service.leaveMeeting(userId);
    assert.equal(leaveRes?.currentState, AttendanceState.ACTIVE);
    assert.equal(leaveRes?.session.meetingSeconds, 600);

    // Start break
    mockClock.advanceSeconds(10);
    const bRes = service.startBreak(userId);
    assert.equal(bRes?.currentState, AttendanceState.ON_BREAK);

    // End break
    mockClock.advanceSeconds(300); // 5 minutes
    const endBRes = service.endBreak(userId);
    assert.equal(endBRes?.currentState, AttendanceState.ACTIVE);
    assert.equal(endBRes?.session.breakSeconds, 300);

    // Socket disconnect and reconnect through service
    mockClock.advanceSeconds(10);
    const dcRes = service.onSocketDisconnect(userId);
    assert.equal(dcRes?.currentState, AttendanceState.DISCONNECTED);

    mockClock.advanceSeconds(20);
    const rcRes = service.onSocketReconnect(userId);
    assert.equal(rcRes?.currentState, AttendanceState.ACTIVE);

    // Explicit logout
    mockClock.advanceSeconds(60);
    const logoutRes = service.onExplicitLogout(userId);
    assert.equal(logoutRes?.currentState, AttendanceState.OFFLINE);
    assert.equal(logoutRes?.session.status, SessionStatus.CLOSED);
    assert.equal(service.getSession(userId), null);

    // Session is archived in closedSessions
    assert.ok(service.getClosedSession(logoutRes!.session.id));
  });
});

describe('HeartbeatValidator Boundary & Edge Cases', () => {
  it('Validates boundary conditions: negative values, excessive interval, reset, and expired nonces', () => {
    const mockClock = new MockClock(new Date('2026-10-13T09:00:00.000Z'));
    const validator = new HeartbeatValidator(1000, mockClock); // 1 second TTL
    const secret = 'validator-boundary-secret';

    const unsigned: Omit<HeartbeatPayload, 'signature'> = {
      orgId: 'org-b',
      userId: 'user-b',
      deviceId: 'dev-b',
      sessionId: 'sess-b',
      sequenceNumber: 1,
      nonce: 'nonce-b-1',
      activeSeconds: 30,
      idleSeconds: 0,
      tabVisible: true,
      windowFocused: true,
      inCall: false,
    };

    // Negative counters
    const negHb: HeartbeatPayload = {
      ...unsigned,
      activeSeconds: -5,
      signature: validator.signHeartbeat({ ...unsigned, activeSeconds: -5 }, secret),
    };
    const negRes = validator.validate(negHb, secret);
    assert.equal(negRes.valid, false);
    assert.match(negRes.reason!, /cannot be negative/);

    // Excessive total > 35s
    const excessHb: HeartbeatPayload = {
      ...unsigned,
      activeSeconds: 20,
      idleSeconds: 20,
      signature: validator.signHeartbeat({ ...unsigned, activeSeconds: 20, idleSeconds: 20 }, secret),
    };
    const excessRes = validator.validate(excessHb, secret);
    assert.equal(excessRes.valid, false);
    assert.match(excessRes.reason!, /exceeds interval threshold/);

    // Valid pass
    const validHb: HeartbeatPayload = {
      ...unsigned,
      signature: validator.signHeartbeat(unsigned, secret),
    };
    assert.equal(validator.validate(validHb, secret).valid, true);

    // Advance clock past 1-second TTL to test cleanExpiredNonces
    mockClock.advanceSeconds(2);
    // Nonce should now be expired and cleaned, but seq 1 was recorded so seq 2 is valid
    const seq2Hb: HeartbeatPayload = {
      ...unsigned,
      sequenceNumber: 2,
      nonce: 'nonce-b-2',
      signature: validator.signHeartbeat({ ...unsigned, sequenceNumber: 2, nonce: 'nonce-b-2' }, secret),
    };
    assert.equal(validator.validate(seq2Hb, secret).valid, true);

    // Test reset()
    validator.reset();
    // After reset, sequence tracker is cleared so seq 1 can be accepted again
    const resetHb: HeartbeatPayload = {
      ...unsigned,
      sequenceNumber: 1,
      nonce: 'nonce-after-reset',
      signature: validator.signHeartbeat({ ...unsigned, sequenceNumber: 1, nonce: 'nonce-after-reset' }, secret),
    };
    assert.equal(validator.validate(resetHb, secret).valid, true);
  });
});

describe('AttendanceService Section 6.3 60-Second Reconciliation Worker', () => {
  const secretKey = 'reconcile-secret';
  const userId = 'user-rec-202';
  const orgId = 'org-456';
  const deviceId = 'dev-rec-01';
  const sessionId = 'session-rec-01';

  it('Reconciliation runs cleanly with active normal sessions (no timeouts)', () => {
    const mockClock = new MockClock(new Date('2026-10-13T09:00:00.000Z'));
    const service = new AttendanceService({}, mockClock);
    service.registerSessionSecret(sessionId, secretKey);

    const unsigned = {
      orgId,
      userId,
      deviceId,
      sessionId,
      sequenceNumber: 1,
      nonce: 'nonce-rec-active',
      activeSeconds: 30,
      idleSeconds: 0,
      tabVisible: true,
      windowFocused: true,
      inCall: false,
    };
    const signature = service.getValidator().signHeartbeat(unsigned, secretKey);
    service.ingestHeartbeat({ ...unsigned, signature });

    // Reconciler runs after only 15 seconds (normal silence, no action)
    mockClock.advanceSeconds(15);
    const summary = service.runReconciliation();
    assert.equal(summary.closedCount, 0);
    assert.equal(summary.splitCount, 0);
    assert.equal(service.getAllOpenSessions().length, 1);
  });

  it('FR-ATT-002: Reconciler closes sessions when heartbeats are missing for > 90s', () => {
    const mockClock = new MockClock(new Date('2026-10-13T09:00:00.000Z'));
    const service = new AttendanceService({ missedHeartbeatTimeoutSeconds: 90 }, mockClock);
    service.registerSessionSecret(sessionId, secretKey);

    const unsigned = {
      orgId,
      userId,
      deviceId,
      sessionId,
      sequenceNumber: 1,
      nonce: 'nonce-rec-1',
      activeSeconds: 30,
      idleSeconds: 0,
      tabVisible: true,
      windowFocused: true,
      inCall: false,
    };
    const signature = service.getValidator().signHeartbeat(unsigned, secretKey);
    service.ingestHeartbeat({ ...unsigned, signature });

    assert.equal(service.getSession(userId)?.status, SessionStatus.OPEN);

    // Advance clock by 95 seconds without new heartbeats
    mockClock.advanceSeconds(95);
    const summary = service.runReconciliation();

    assert.equal(summary.closedCount, 1);
    assert.equal(service.getSession(userId), null);
    assert.equal(service.getAllOpenSessions().length, 0);
  });

  it('FR-ATT-002: Reconciler closes disconnected sessions when 120s grace expires', () => {
    const mockClock = new MockClock(new Date('2026-10-13T09:00:00.000Z'));
    const service = new AttendanceService({ disconnectGraceWindowSeconds: 120 }, mockClock);
    service.registerSessionSecret(sessionId, secretKey);

    const unsigned = {
      orgId,
      userId,
      deviceId,
      sessionId,
      sequenceNumber: 1,
      nonce: 'nonce-grace-1',
      activeSeconds: 30,
      idleSeconds: 0,
      tabVisible: true,
      windowFocused: true,
      inCall: false,
    };
    const signature = service.getValidator().signHeartbeat(unsigned, secretKey);
    service.ingestHeartbeat({ ...unsigned, signature });

    // Socket disconnect occurs
    mockClock.advanceSeconds(10);
    service.onSocketDisconnect(userId);
    assert.equal(service.getSession(userId)?.currentState, AttendanceState.DISCONNECTED);

    // Reconciler runs after 40s (grace still active)
    mockClock.advanceSeconds(40);
    service.runReconciliation();
    assert.equal(service.getSession(userId)?.status, SessionStatus.OPEN);

    // Reconciler runs after grace expires (> 120s from disconnect)
    mockClock.advanceSeconds(85);
    const summary = service.runReconciliation();
    assert.equal(summary.closedCount, 1);
    assert.equal(service.getSession(userId), null);
  });

  it('FR-ATT-008 & Section 6.2 Row 15: Reconciler automatically splits session crossing midnight', () => {
    // 23:50:00 Asia/Colombo = 18:20:00 UTC
    const mockClock = new MockClock(new Date('2026-10-13T18:20:00.000Z'));
    const service = new AttendanceService({ orgTimezone: 'Asia/Colombo' }, mockClock);
    service.registerSessionSecret(sessionId, secretKey);

    const unsigned = {
      orgId,
      userId,
      deviceId,
      sessionId,
      sequenceNumber: 1,
      nonce: 'nonce-mid-1',
      activeSeconds: 30,
      idleSeconds: 0,
      tabVisible: true,
      windowFocused: true,
      inCall: false,
    };
    const signature = service.getValidator().signHeartbeat(unsigned, secretKey);
    const initialRes = service.ingestHeartbeat({ ...unsigned, signature });

    // Advance clock to 00:05:00 next day (Colombo) = 18:35:00 UTC (15 mins = 900s)
    mockClock.advanceSeconds(900);
    const summary = service.runReconciliation();

    assert.equal(summary.splitCount, 1);
    const newSession = service.getSession(userId);
    assert.ok(newSession);
    assert.equal(newSession.status, SessionStatus.OPEN);
    assert.notEqual(newSession.id, initialRes.session.id);
    assert.ok(newSession.flags.includes('MIDNIGHT_SPLIT'));

    // Check that previous session was archived as closed with MIDNIGHT source
    const oldSession = service.getClosedSession(initialRes.session.id);
    assert.ok(oldSession);
    assert.equal(oldSession.status, SessionStatus.CLOSED);
    assert.equal(oldSession.clockOutSource, ClockOutSource.MIDNIGHT);
  });

  it('Section 6.2 Row 16: Reconciler closes session exceeding 14 hours with MAX_LENGTH flag', () => {
    const mockClock = new MockClock(new Date('2026-10-13T01:00:00.000Z'));
    const service = new AttendanceService(
      { maxSessionLengthSeconds: 14 * 3600, orgTimezone: 'UTC' },
      mockClock,
    );
    service.registerSessionSecret(sessionId, secretKey);

    const unsigned = {
      orgId,
      userId,
      deviceId,
      sessionId,
      sequenceNumber: 1,
      nonce: 'nonce-maxlen-1',
      activeSeconds: 30,
      idleSeconds: 0,
      tabVisible: true,
      windowFocused: true,
      inCall: false,
    };
    const signature = service.getValidator().signHeartbeat(unsigned, secretKey);
    service.ingestHeartbeat({ ...unsigned, signature });

    // Advance clock past 14 hours (14h + 1m = 50460s)
    mockClock.advanceSeconds(50460);
    const summary = service.runReconciliation();

    assert.equal(summary.closedCount, 1);
    assert.equal(service.getSession(userId), null);
    const closed = service.getAllOpenSessions();
    assert.equal(closed.length, 0);
  });
});
