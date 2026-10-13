/**
 * Comprehensive Test Suite for Attendance Engine with PostgreSQL Persistence & Section 6.6 Edge Cases
 * Rules: TDD - tests written first for FR-ATT-007..010, Reconciler Rows 12, 13, 15, 16, and Section 6.6 Edge Cases
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresAttendanceRepository } from '../src/attendance/attendance-repository.ts';
import { AttendanceService } from '../src/attendance/attendance.service.ts';
import {
  AttendanceState,
  ClockOutSource,
  SessionStatus,
} from '../../../packages/shared/src/attendance/types.ts';
import type { Clock, HeartbeatPayload } from '../../../packages/shared/src/attendance/types.ts';

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

describe('Attendance Engine PostgreSQL Persistence & Edge Cases (FR-ATT-007..010 & Section 6.6)', () => {
  let repository: PostgresAttendanceRepository;
  const orgId = '11111111-1111-1111-1111-111111111111';
  const userId = '22222222-2222-2222-2222-222222222222';
  const sessionId = 'session-pg-001';
  const secretKey = 'test-pg-hmac-secret-1234567890';
  const deviceId1 = 'device-laptop-primary';
  const deviceId2 = 'device-tablet-secondary';

  before(async () => {
    repository = new PostgresAttendanceRepository({
      host: 'localhost',
      port: 5433,
      user: 'postgres',
      password: 'postgres',
      database: 'hrvo_dev',
    });
  });

  after(async () => {
    await repository.close();
  });

  beforeEach(async () => {
    await repository.clearAll();
    // Seed test organization and user
    const pool = repository.getPool();
    await pool.query(
      `INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, $2, $3, $4)`,
      [orgId, 'ACME Global', 'acme-global', 'Asia/Colombo'],
    );
    await pool.query(
      `INSERT INTO users (id, org_id, email, display_name) VALUES ($1, $2, $3, $4)`,
      [userId, orgId, 'dev@acme.com', 'Alex Developer'],
    );
  });

  function createSignedHeartbeat(
    service: AttendanceService,
    overrides: Partial<HeartbeatPayload> = {},
  ): HeartbeatPayload {
    const unsigned: Omit<HeartbeatPayload, 'signature'> = {
      orgId,
      userId,
      deviceId: deviceId1,
      sessionId,
      sequenceNumber: 1,
      nonce: `nonce-${Date.now()}-${Math.random()}`,
      activeSeconds: 30,
      idleSeconds: 0,
      tabVisible: true,
      windowFocused: true,
      inCall: false,
      ...overrides,
    };
    const signature = service.getValidator().signHeartbeat(unsigned, secretKey);
    return { ...unsigned, signature };
  }

  // 1. Reconciler Row 12: Missing heartbeats > 90s -> TIMEOUT in Postgres
  it('Row 12: Missing heartbeats > 90s closes session at last heartbeat with source TIMEOUT in Postgres', async () => {
    const clock = new MockClock(new Date('2026-10-13T09:00:00.000Z'));
    const service = new AttendanceService({ missedHeartbeatTimeoutSeconds: 90 }, clock, repository);
    await service.registerSessionSecret(sessionId, secretKey);

    const hb1 = createSignedHeartbeat(service, { sequenceNumber: 1 });
    await service.ingestHeartbeat(hb1);

    // Verify session is OPEN in Postgres
    let session = await repository.findOpenSessionByUserId(orgId, userId);
    assert.ok(session);
    assert.equal(session.status, SessionStatus.OPEN);
    const sessionDbId = session.id;

    // Advance clock past 90s silence
    clock.advanceSeconds(95);
    const result = await service.runReconciliation();

    assert.equal(result.closedCount, 1);
    // Verify session is CLOSED in Postgres with source TIMEOUT and clockOutAt = last heartbeat
    session = await repository.findOpenSessionByUserId(orgId, userId);
    assert.equal(session, null);

    const closed = await repository.findSessionById(orgId, sessionDbId);
    assert.ok(closed);
    assert.equal(closed.status, SessionStatus.CLOSED);
    assert.equal(closed.clockOutSource, ClockOutSource.TIMEOUT);
    assert.equal(closed.clockOutAt?.toISOString(), '2026-10-13T09:00:00.000Z');
  });

  // 2. Reconciler Row 13: Grace expiry 120s -> DISCONNECT in Postgres
  it('Row 13: Socket disconnect grace expiry (120s) closes session at last heartbeat with source DISCONNECT in Postgres', async () => {
    const clock = new MockClock(new Date('2026-10-13T09:00:00.000Z'));
    const service = new AttendanceService({ disconnectGraceWindowSeconds: 120 }, clock, repository);
    await service.registerSessionSecret(sessionId, secretKey);

    await service.ingestHeartbeat(createSignedHeartbeat(service, { sequenceNumber: 1 }));

    // Socket disconnects at 09:00:10
    clock.advanceSeconds(10);
    await service.onSocketDisconnect(userId);

    // After 60s, grace is still active
    clock.advanceSeconds(50);
    let summary = await service.runReconciliation();
    assert.equal(summary.closedCount, 0);
    let openSession = await repository.findOpenSessionByUserId(orgId, userId);
    assert.ok(openSession);
    assert.equal(openSession.currentState, AttendanceState.DISCONNECTED);

    // After 125s total since disconnect, grace expires
    clock.advanceSeconds(75);
    summary = await service.runReconciliation();
    assert.equal(summary.closedCount, 1);

    openSession = await repository.findOpenSessionByUserId(orgId, userId);
    assert.equal(openSession, null);
  });

  // 3. Reconciler Row 15 & FR-ATT-008: Midnight split in org timezone (Asia/Colombo)
  it('Row 15 & FR-ATT-008: Automatically splits session crossing midnight in Asia/Colombo into two Postgres records', async () => {
    // 23:50:00 Asia/Colombo = 18:20:00 UTC
    const clock = new MockClock(new Date('2026-10-13T18:20:00.000Z'));
    const service = new AttendanceService({ orgTimezone: 'Asia/Colombo' }, clock, repository);
    await service.registerSessionSecret(sessionId, secretKey);

    const initialRes = await service.ingestHeartbeat(createSignedHeartbeat(service, { sequenceNumber: 1 }));

    // Reconciler runs at 00:05:00 next day (Colombo) = 18:35:00 UTC
    clock.advanceSeconds(900);
    const summary = await service.runReconciliation();

    assert.equal(summary.splitCount, 1);

    // Old session closed at 23:59:59.999 Colombo = 18:29:59.999 UTC
    const oldSession = await repository.findSessionById(orgId, initialRes.session.id);
    assert.ok(oldSession);
    assert.equal(oldSession.status, SessionStatus.CLOSED);
    assert.equal(oldSession.clockOutSource, ClockOutSource.MIDNIGHT);
    assert.equal(oldSession.clockOutAt?.toISOString(), '2026-10-13T18:29:59.999Z');

    // New session opened at 00:00:00.000 Colombo = 18:30:00.000 UTC
    const newSession = await repository.findOpenSessionByUserId(orgId, userId);
    assert.ok(newSession);
    assert.equal(newSession.status, SessionStatus.OPEN);
    assert.equal(newSession.clockInAt.toISOString(), '2026-10-13T18:30:00.000Z');
    assert.equal(newSession.workDate, '2026-10-14');
    assert.ok(newSession.flags.includes('MIDNIGHT_SPLIT'));
  });

  // 4. Reconciler Row 16 & FR-ATT-009: Max session length 14h
  it('Row 16 & FR-ATT-009: Closes session open longer than 14 hours at last heartbeat with MAX_LENGTH flag', async () => {
    const clock = new MockClock(new Date('2026-10-13T01:00:00.000Z'));
    const service = new AttendanceService(
      { maxSessionLengthSeconds: 14 * 3600, orgTimezone: 'UTC' },
      clock,
      repository,
    );
    await service.registerSessionSecret(sessionId, secretKey);

    const initial = await service.ingestHeartbeat(createSignedHeartbeat(service, { sequenceNumber: 1 }));

    // Advance clock past 14 hours (14h + 1m = 50460s)
    clock.advanceSeconds(50460);
    const summary = await service.runReconciliation();

    assert.equal(summary.closedCount, 1);
    const closed = await repository.findSessionById(orgId, initial.session.id);
    assert.ok(closed);
    assert.equal(closed.status, SessionStatus.CLOSED);
    assert.equal(closed.clockOutSource, ClockOutSource.MAX_LENGTH);
    assert.ok(closed.flags.includes('MAX_LENGTH'));
  });

  // 5. FR-ATT-010: Multi-device merge without double counting
  it('FR-ATT-010: Merges overlapping multi-device sessions using interval union without double-counting time', async () => {
    const clock = new MockClock(new Date('2026-10-13T10:00:00.000Z'));
    const service = new AttendanceService({}, clock, repository);
    await service.registerSessionSecret(sessionId, secretKey);

    // Device 1 active from 10:00:00 to 10:01:00 (60s)
    await service.ingestHeartbeat(
      createSignedHeartbeat(service, { deviceId: deviceId1, sequenceNumber: 1, activeSeconds: 30, idleSeconds: 0 }),
    );
    clock.advanceSeconds(30);
    await service.ingestHeartbeat(
      createSignedHeartbeat(service, { deviceId: deviceId1, sequenceNumber: 2, activeSeconds: 30, idleSeconds: 0 }),
    );

    // Device 2 simultaneously active at 10:00:45
    clock.setTime(new Date('2026-10-13T10:00:45.000Z'));
    await service.ingestHeartbeat(
      createSignedHeartbeat(service, { deviceId: deviceId2, sequenceNumber: 1, activeSeconds: 30, idleSeconds: 0 }),
    );

    const session = await repository.findOpenSessionByUserId(orgId, userId);
    assert.ok(session);
    assert.ok(session.flags.includes('MULTI_DEVICE'), 'Session must be flagged MULTI_DEVICE');
    // Wall-clock span from 10:00:00 to 10:01:15 is 75 seconds. Net seconds must NOT equal 90s (30+30+30)!
    assert.ok(session.netSeconds <= 75, `Net seconds (${session.netSeconds}) must equal union duration, not sum`);
  });

  // 6. Reconciler Idempotency
  it('Reconciler Idempotency: Running reconciliation multiple times yields exact same state without duplicate action', async () => {
    const clock = new MockClock(new Date('2026-10-13T09:00:00.000Z'));
    const service = new AttendanceService({ missedHeartbeatTimeoutSeconds: 90 }, clock, repository);
    await service.registerSessionSecret(sessionId, secretKey);

    await service.ingestHeartbeat(createSignedHeartbeat(service, { sequenceNumber: 1 }));

    // Timeout triggered
    clock.advanceSeconds(95);
    const firstRun = await service.runReconciliation();
    assert.equal(firstRun.closedCount, 1);

    // Second run immediately after
    const secondRun = await service.runReconciliation();
    assert.equal(secondRun.closedCount, 0);
    assert.equal(secondRun.splitCount, 0);

    // Third run
    const thirdRun = await service.runReconciliation();
    assert.equal(thirdRun.closedCount, 0);
  });

  // 7. Edge Case 6.6: Laptop sleep / lid closed
  it('Section 6.6 Edge Case: Laptop lid closed stops heartbeats; closed at last heartbeat; wake starts new session; gap is unpaid', async () => {
    const clock = new MockClock(new Date('2026-10-13T09:00:00.000Z'));
    const service = new AttendanceService({ missedHeartbeatTimeoutSeconds: 90 }, clock, repository);
    await service.registerSessionSecret(sessionId, secretKey);

    const hb1 = await service.ingestHeartbeat(createSignedHeartbeat(service, { sequenceNumber: 1 }));

    // Laptop sleeps. Silence for 30 minutes. Reconciler runs at 09:02:00.
    clock.advanceSeconds(120);
    await service.runReconciliation();

    const session1 = await repository.findSessionById(orgId, hb1.session.id);
    assert.equal(session1?.status, SessionStatus.CLOSED);
    assert.equal(session1?.clockOutAt?.toISOString(), '2026-10-13T09:00:00.000Z');

    // User wakes laptop 30 minutes later at 09:30:00
    clock.setTime(new Date('2026-10-13T09:30:00.000Z'));
    const hbWake = await service.ingestHeartbeat(
      createSignedHeartbeat(service, { sequenceNumber: 2, activeSeconds: 30, idleSeconds: 0 }),
    );

    assert.equal(hbWake.session.status, SessionStatus.OPEN);
    assert.equal(hbWake.session.clockInAt.toISOString(), '2026-10-13T09:30:00.000Z');
    assert.notEqual(hbWake.session.id, session1?.id);
    // Gap between 09:00:00 and 09:30:00 is completely unpaid
  });

  // 8. Edge Case 6.6: 10-minute network outage
  it('Section 6.6 Edge Case: 10-minute network outage triggers grace disconnect closure, then recovers on reconnect', async () => {
    const clock = new MockClock(new Date('2026-10-13T10:00:00.000Z'));
    const service = new AttendanceService({ disconnectGraceWindowSeconds: 120 }, clock, repository);
    await service.registerSessionSecret(sessionId, secretKey);

    await service.ingestHeartbeat(createSignedHeartbeat(service, { sequenceNumber: 1 }));

    // Outage starts: socket disconnects at 10:00:15
    clock.advanceSeconds(15);
    await service.onSocketDisconnect(userId);

    // After 120s grace (10:02:15), reconciler closes session
    clock.advanceSeconds(120);
    await service.runReconciliation();
    assert.equal(await repository.findOpenSessionByUserId(orgId, userId), null);

    // Network recovers after 10 minutes total (10:10:15)
    clock.setTime(new Date('2026-10-13T10:10:15.000Z'));
    const hbReconnect = await service.ingestHeartbeat(
      createSignedHeartbeat(service, { sequenceNumber: 2, activeSeconds: 30, idleSeconds: 0 }),
    );

    assert.equal(hbReconnect.session.status, SessionStatus.OPEN);
    assert.equal(hbReconnect.session.clockInAt.toISOString(), '2026-10-13T10:10:15.000Z');
  });

  // 9. Edge Case 6.6: Forgotten logout overnight
  it('Section 6.6 Edge Case: Forgotten logout overnight accrues zero phantom payable hours', async () => {
    // Starts at 17:00 Colombo = 11:30 UTC
    const clock = new MockClock(new Date('2026-10-13T11:30:00.000Z'));
    const service = new AttendanceService(
      { idleThresholdSeconds: 300, pauseThresholdSeconds: 900, orgTimezone: 'Asia/Colombo' },
      clock,
      repository,
    );
    await service.registerSessionSecret(sessionId, secretKey);

    // User works 30 mins active (60 intervals)
    for (let i = 1; i <= 60; i++) {
      clock.advanceSeconds(30);
      await service.ingestHeartbeat(
        createSignedHeartbeat(service, { sequenceNumber: i, activeSeconds: 30, idleSeconds: 0 }),
      );
    }

    // User leaves desk overnight without logging out. Browser sends idle heartbeats.
    for (let i = 61; i <= 95; i++) {
      clock.advanceSeconds(30);
      await service.ingestHeartbeat(
        createSignedHeartbeat(service, { sequenceNumber: i, activeSeconds: 0, idleSeconds: 30 }),
      );
    }

    // At this point (after 15m idle), state is PAUSED
    let s = await repository.findOpenSessionByUserId(orgId, userId);
    assert.equal(s?.currentState, AttendanceState.PAUSED);

    // Advance clock past midnight Colombo (18:30 UTC) to next morning 08:00 Colombo (02:30 UTC)
    clock.setTime(new Date('2026-10-14T02:30:00.000Z'));
    await service.runReconciliation();

    // Midnight split occurred; check previous day total
    const oldSession = await repository.findSessionById(orgId, s!.id);
    assert.ok(oldSession);
    assert.equal(oldSession.status, SessionStatus.CLOSED);
    // Paid work time is strictly limited to initial 30 minutes (1800s); no phantom hours!
    assert.equal(oldSession.activeSeconds, 1800);
    assert.equal(oldSession.netSeconds, 1800);
  });

  // 10. Edge Case 6.6: Daylight Saving Time (DST) day boundary
  it('Section 6.6 Edge Case: DST transitions in America/New_York split midnight cleanly without day drift', async () => {
    // US Spring Forward: 2026-03-08.
    // 23:50 New York on Mar 7 = 2026-03-08 04:50:00 UTC (UTC-5)
    const clock = new MockClock(new Date('2026-03-08T04:50:00.000Z'));
    const service = new AttendanceService({ orgTimezone: 'America/New_York' }, clock, repository);
    await service.registerSessionSecret(sessionId, secretKey);

    const initial = await service.ingestHeartbeat(createSignedHeartbeat(service, { sequenceNumber: 1 }));

    // Reconciler runs at 00:10 New York on Mar 8 = 2026-03-08 05:10:00 UTC
    clock.setTime(new Date('2026-03-08T05:10:00.000Z'));
    const summary = await service.runReconciliation();

    assert.equal(summary.splitCount, 1);
    const oldSession = await repository.findSessionById(orgId, initial.session.id);
    assert.ok(oldSession);
    assert.equal(oldSession.status, SessionStatus.CLOSED);
    assert.equal(oldSession.workDate, '2026-03-07');
    assert.equal(oldSession.clockOutAt?.toISOString(), '2026-03-08T04:59:59.999Z');

    const newSession = await repository.findOpenSessionByUserId(orgId, userId);
    assert.ok(newSession);
    assert.equal(newSession.workDate, '2026-03-08');
    assert.equal(newSession.clockInAt.toISOString(), '2026-03-08T05:00:00.000Z');
  });

  // 11. Edge Case 6.6: Server restart during session
  it('Section 6.6 Edge Case: Server restart restores active session & sequence state from PostgreSQL', async () => {
    const clock = new MockClock(new Date('2026-10-13T10:00:00.000Z'));
    // Server instance 1
    const serverInstance1 = new AttendanceService({}, clock, repository);
    await serverInstance1.registerSessionSecret(sessionId, secretKey);

    await serverInstance1.ingestHeartbeat(
      createSignedHeartbeat(serverInstance1, { sequenceNumber: 1, activeSeconds: 30, idleSeconds: 0 }),
    );

    // SERVER CRASHES / RESTARTS: serverInstance1 is discarded from memory!
    // Server instance 2 initializes with same repository
    const serverInstance2 = new AttendanceService({}, clock, repository);

    // Sequence 1 must be remembered by Postgres, so replaying sequence 1 must fail
    await assert.rejects(
      async () => {
        await serverInstance2.ingestHeartbeat(
          createSignedHeartbeat(serverInstance2, { sequenceNumber: 1, activeSeconds: 30, idleSeconds: 0 }),
        );
      },
      /Sequence violation/,
    );

    // Sequence 2 must succeed and continue the existing session from PostgreSQL
    clock.advanceSeconds(30);
    const resAfterRestart = await serverInstance2.ingestHeartbeat(
      createSignedHeartbeat(serverInstance2, { sequenceNumber: 2, activeSeconds: 30, idleSeconds: 0 }),
    );

    assert.equal(resAfterRestart.session.status, SessionStatus.OPEN);
    assert.equal(resAfterRestart.session.activeSeconds, 60);
    assert.equal(resAfterRestart.session.segments.length, 1);

    // Verify secret retrieval from DB on cold instance and revocation
    const coldInstance = new AttendanceService({}, clock, repository);
    const retrievedSecret = await coldInstance.getSessionSecret(sessionId);
    assert.equal(retrievedSecret, secretKey);

    await coldInstance.revokeSessionSecret(sessionId);
    assert.equal(await coldInstance.getSessionSecret(sessionId), undefined);
  });

  // 12. Interval Merger Unit Coverage (empty, invalid, disjoint intervals)
  it('FR-ATT-010: Interval merger correctly handles empty, invalid, and disjoint intervals', async () => {
    const { computeIntervalUnionDurationSeconds } = await import('../src/attendance/interval-merger.ts');

    assert.equal(computeIntervalUnionDurationSeconds([]), 0);

    // Invalid interval: end before start
    const invalid = [{ start: new Date('2026-10-13T10:00:00Z'), end: new Date('2026-10-13T09:00:00Z') }];
    assert.equal(computeIntervalUnionDurationSeconds(invalid), 0);

    // Disjoint intervals: 10:00:00-10:00:30 (30s) and 10:01:00-10:01:30 (30s) -> total 60s
    const disjoint = [
      { start: new Date('2026-10-13T10:00:00Z'), end: new Date('2026-10-13T10:00:30Z') },
      { start: new Date('2026-10-13T10:01:00Z'), end: new Date('2026-10-13T10:01:30Z') },
    ];
    assert.equal(computeIntervalUnionDurationSeconds(disjoint), 60);
  });

  // 13. ValidatorAsync DB rejection paths (privacy, negative counters, excessive total)
  it('HeartbeatValidator validateAsync rejects privacy violations and invalid bounds against DB', async () => {
    const service = new AttendanceService({}, new MockClock(), repository);
    await service.registerSessionSecret(sessionId, secretKey);

    // Privacy violation with DB
    const privHb = createSignedHeartbeat(service, { sequenceNumber: 1 });
    (privHb as any).keystrokes = 'secret-keys';
    await assert.rejects(
      async () => await service.ingestHeartbeat(privHb),
      /Privacy violation/,
    );

    // Negative counter with DB
    const negHb = createSignedHeartbeat(service, { sequenceNumber: 1, activeSeconds: -5 });
    await assert.rejects(
      async () => await service.ingestHeartbeat(negHb),
      /Invalid counter values/,
    );

    // Excessive total with DB
    const excessHb = createSignedHeartbeat(service, { sequenceNumber: 1, activeSeconds: 20, idleSeconds: 20 });
    await assert.rejects(
      async () => await service.ingestHeartbeat(excessHb),
      /exceeds interval threshold/,
    );
  });
});
