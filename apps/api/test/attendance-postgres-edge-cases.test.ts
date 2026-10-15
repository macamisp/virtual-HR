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
      appPoolConfig: {
        host: process.env.PGHOST || 'localhost',
        port: Number(process.env.PGPORT || 5433),
        user: process.env.PGUSER || 'hrvo_app',
        password: process.env.PGPASSWORD || 'hrvo_app_pass',
        database: process.env.PGDATABASE || 'hrvo_dev',
      },
      adminPoolConfig: {
        host: process.env.PGHOST || 'localhost',
        port: Number(process.env.PGPORT || 5433),
        user: process.env.PGADMIN_USER || 'postgres',
        password: process.env.PGADMIN_PASSWORD || 'postgres',
        database: process.env.PGDATABASE || 'hrvo_dev',
      },
    });
  });

  after(async () => {
    await repository.clearAll(orgId);
    await repository.close();
  });

  beforeEach(async () => {
    await repository.clearAll(orgId);
    // Seed test organization and user using adminPool (as migration/owner role)
    const adminPool = repository.getAdminPool();
    await adminPool.query(
      `INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, $2, $3, $4)`,
      [orgId, 'ACME Global', 'acme-global', 'Asia/Colombo'],
    );
    await adminPool.query(
      `INSERT INTO users (id, org_id, email, display_name) VALUES ($1, $2, $3, $4)`,
      [userId, orgId, 'dev@acme.com', 'Alex Developer'],
    );
    await adminPool.query(
      `INSERT INTO monitoring_consents (id, org_id, user_id, notice_version, accepted_at) VALUES (gen_random_uuid(), $1, $2, 'v1.0.0', CURRENT_TIMESTAMP)`,
      [orgId, userId],
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
    const service = new AttendanceService({ missedHeartbeatTimeoutSeconds: 90 }, clock, repository, orgId);
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
    const service = new AttendanceService({ disconnectGraceWindowSeconds: 120 }, clock, repository, orgId);
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
    const service = new AttendanceService({ orgTimezone: 'Asia/Colombo' }, clock, repository, orgId);
    await service.registerSessionSecret(sessionId, secretKey);

    const initialRes = await service.ingestHeartbeat(createSignedHeartbeat(service, { sequenceNumber: 1 }));

    // Reconciler runs at 00:05:00 next day (Colombo) = 18:35:00 UTC
    clock.advanceSeconds(900);
    const summary = await service.runReconciliation();

    assert.equal(summary.splitCount, 1);

    // Old session must be closed at 23:59:59.999 local (18:29:59.999 UTC) with MIDNIGHT source
    const oldSession = await repository.findSessionById(orgId, initialRes.session.id);
    assert.ok(oldSession);
    assert.equal(oldSession.status, SessionStatus.CLOSED);
    assert.equal(oldSession.clockOutSource, ClockOutSource.MIDNIGHT);
    assert.equal(oldSession.workDate, '2026-10-13');
    assert.equal(oldSession.clockOutAt?.toISOString(), '2026-10-13T18:29:59.999Z');

    // New session opened at 00:00:00.000 local (18:30:00 UTC) with work date 2026-10-14
    const newSession = await repository.findOpenSessionByUserId(orgId, userId);
    assert.ok(newSession);
    assert.equal(newSession.status, SessionStatus.OPEN);
    assert.equal(newSession.workDate, '2026-10-14');
    assert.equal(newSession.clockInAt.toISOString(), '2026-10-13T18:30:00.000Z');
    assert.ok(newSession.flags.includes('MIDNIGHT_SPLIT'));
  });

  // 4. Reconciler Row 16 & FR-ATT-009: Max session length 14h close + MAX_LENGTH flag
  it('Row 16 & FR-ATT-009: Closes session open longer than 14 hours at last heartbeat with MAX_LENGTH flag', async () => {
    const clock = new MockClock(new Date('2026-10-13T01:00:00.000Z'));
    const service = new AttendanceService({ maxSessionLengthSeconds: 14 * 3600 }, clock, repository, orgId);
    await service.registerSessionSecret(sessionId, secretKey);

    const hb1 = createSignedHeartbeat(service, { sequenceNumber: 1 });
    await service.ingestHeartbeat(hb1);

    // Advance 14 hours and 1 minute
    clock.advanceSeconds(14 * 3600 + 60);
    const summary = await service.runReconciliation();

    assert.equal(summary.closedCount, 1);
    const openSession = await repository.findOpenSessionByUserId(orgId, userId);
    assert.equal(openSession, null);

    const closed = await repository.findSessionById(orgId, (await repository.getAdminPool().query(`SELECT id FROM attendance_sessions WHERE user_id = $1`, [userId])).rows[0].id);
    assert.ok(closed);
    assert.equal(closed.status, SessionStatus.CLOSED);
    assert.equal(closed.clockOutSource, ClockOutSource.MAX_LENGTH);
    assert.ok(closed.flags.includes('MAX_LENGTH'));
  });

  // 5. FR-ATT-010: Multi-device merge without double counting
  it('FR-ATT-010: Merges overlapping multi-device sessions using interval union without double-counting time', async () => {
    const clock = new MockClock(new Date('2026-10-13T10:00:00.000Z'));
    const service = new AttendanceService({}, clock, repository, orgId);
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
    const service = new AttendanceService({ missedHeartbeatTimeoutSeconds: 90 }, clock, repository, orgId);
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
    const service = new AttendanceService({ missedHeartbeatTimeoutSeconds: 90 }, clock, repository, orgId);
    await service.registerSessionSecret(sessionId, secretKey);

    // Laptop active at 09:00:00 and 09:00:30
    await service.ingestHeartbeat(createSignedHeartbeat(service, { sequenceNumber: 1, activeSeconds: 30 }));
    clock.advanceSeconds(30);
    const hb2 = createSignedHeartbeat(service, { sequenceNumber: 2, activeSeconds: 30 });
    const res2 = await service.ingestHeartbeat(hb2);

    // LID CLOSED at 09:00:30. No more heartbeats arrive.
    // Advance 45 minutes into sleep
    clock.advanceSeconds(2700);
    const reconResult = await service.runReconciliation();
    assert.equal(reconResult.closedCount, 1);

    // Prior session closed with clockOutAt matching last heartbeat at 09:00:30
    const sleepSession = await repository.findSessionById(orgId, res2.session.id);
    assert.ok(sleepSession);
    assert.equal(sleepSession.clockOutAt?.toISOString(), '2026-10-13T09:00:30.000Z');

    // Laptop wakes up at 09:45:30. Heartbeat resumes with sequence 3
    const hbWake = createSignedHeartbeat(service, { sequenceNumber: 3, activeSeconds: 30 });
    const wakeResult = await service.ingestHeartbeat(hbWake);

    // Starts a clean new session; the 45-minute sleep gap is completely unpaid
    assert.notEqual(wakeResult.session.id, sleepSession.id);
    assert.equal(wakeResult.session.status, SessionStatus.OPEN);
    assert.equal(wakeResult.session.clockInAt.toISOString(), '2026-10-13T09:45:30.000Z');
  });

  // 8. Edge Case 6.6: 10-minute network outage
  it('Section 6.6 Edge Case: 10-minute network outage triggers grace disconnect closure, then recovers on reconnect', async () => {
    const clock = new MockClock(new Date('2026-10-13T10:00:00.000Z'));
    const service = new AttendanceService({ disconnectGraceWindowSeconds: 120 }, clock, repository, orgId);
    await service.registerSessionSecret(sessionId, secretKey);

    const hb1 = await service.ingestHeartbeat(createSignedHeartbeat(service, { sequenceNumber: 1 }));

    // Network drops -> Socket disconnect
    clock.advanceSeconds(5);
    await service.onSocketDisconnect(userId);

    // 10 minutes pass (600 seconds)
    clock.advanceSeconds(600);
    const summary = await service.runReconciliation();
    assert.equal(summary.closedCount, 1);

    // Old session closed with DISCONNECT source
    const oldSession = await repository.findSessionById(orgId, hb1.session.id);
    assert.ok(oldSession);
    assert.equal(oldSession.status, SessionStatus.CLOSED);
    assert.equal(oldSession.clockOutSource, ClockOutSource.DISCONNECT);

    // Network recovers: client establishes new connection and sends next heartbeat
    const hbRecover = createSignedHeartbeat(service, { sequenceNumber: 2 });
    const recoverRes = await service.ingestHeartbeat(hbRecover);

    assert.equal(recoverRes.session.status, SessionStatus.OPEN);
    assert.notEqual(recoverRes.session.id, oldSession.id);
  });

  // 9. Edge Case 6.6: Forgotten logout overnight
  it('Section 6.6 Edge Case: Forgotten logout overnight accrues zero phantom payable hours', async () => {
    // User stops work at 18:00 Asia/Colombo (12:30 UTC) and forgets to log out
    const clock = new MockClock(new Date('2026-10-13T12:30:00.000Z'));
    const service = new AttendanceService(
      { orgTimezone: 'Asia/Colombo', missedHeartbeatTimeoutSeconds: 90 },
      clock,
      repository,
      orgId,
    );
    await service.registerSessionSecret(sessionId, secretKey);

    const lastWorkHb = await service.ingestHeartbeat(
      createSignedHeartbeat(service, { sequenceNumber: 1, activeSeconds: 30, idleSeconds: 0 }),
    );

    // Overnight: user walked away. No more heartbeats arrive.
    // 60-second reconciler runs 2 minutes later
    clock.advanceSeconds(120);
    const recon1 = await service.runReconciliation();
    assert.equal(recon1.closedCount, 1);

    // Clock out is pinned strictly to 12:30:00 UTC (18:00 local)
    const closedSession = await repository.findSessionById(orgId, lastWorkHb.session.id);
    assert.ok(closedSession);
    assert.equal(closedSession.clockOutAt?.toISOString(), '2026-10-13T12:30:00.000Z');

    // Fast-forward to 09:00 AM next day (14.5 hours later)
    for (let minute = 0; minute < 14 * 60; minute += 60) {
      clock.advanceSeconds(3600);
      await service.runReconciliation();
    }

    // Zero additional payable time or open sessions generated during the night
    assert.equal(await repository.findOpenSessionByUserId(orgId, userId), null);
    assert.equal(closedSession.netSeconds, 30); // ONLY the 30 active seconds were paid
  });

  // 10. Edge Case 6.6: DST change in America/New_York
  it('Section 6.6 Edge Case: DST transitions in America/New_York split midnight cleanly without day drift', async () => {
    // America/New_York DST Spring Forward: 2026-03-08
    // 23:55:00 America/New_York on 2026-03-07 = 2026-03-08T04:55:00.000Z
    const clock = new MockClock(new Date('2026-03-08T04:55:00.000Z'));
    const service = new AttendanceService({ orgTimezone: 'America/New_York' }, clock, repository, orgId);
    await service.registerSessionSecret(sessionId, secretKey);

    const initialRes = await service.ingestHeartbeat(
      createSignedHeartbeat(service, { sequenceNumber: 1 }),
    );
    assert.equal(initialRes.session.workDate, '2026-03-07');

    // Advance 10 minutes past midnight to 00:05:00 next day = 05:05:00 UTC
    clock.advanceSeconds(600);
    const summary = await service.runReconciliation();
    assert.equal(summary.splitCount, 1);

    const oldSession = await repository.findSessionById(orgId, initialRes.session.id);
    assert.ok(oldSession);
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
    const serverInstance1 = new AttendanceService({}, clock, repository, orgId);
    await serverInstance1.registerSessionSecret(sessionId, secretKey);

    await serverInstance1.ingestHeartbeat(
      createSignedHeartbeat(serverInstance1, { sequenceNumber: 1, activeSeconds: 30, idleSeconds: 0 }),
    );

    // SERVER CRASHES / RESTARTS: serverInstance1 is discarded from memory!
    // Server instance 2 initializes with same repository
    const serverInstance2 = new AttendanceService({}, clock, repository, orgId);

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
    const coldInstance = new AttendanceService({}, clock, repository, orgId);
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
    const service = new AttendanceService({}, new MockClock(), repository, orgId);
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

  // 14. RLS Hardening: Org Isolation (SELECT, UPDATE, DELETE)
  it('RLS Hardening: Org A context cannot SELECT, UPDATE, or DELETE Org B rows', async () => {
    const orgB = '33333333-3333-3333-3333-333333333333';
    const userB = '44444444-4444-4444-4444-444444444444';
    const adminPool = repository.getAdminPool();
    await repository.clearAll(orgB);
    await adminPool.query(
      `INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, $2, $3, $4)`,
      [orgB, 'Beta Corp', 'beta-corp-edge', 'UTC'],
    );
    await adminPool.query(
      `INSERT INTO users (id, org_id, email, display_name) VALUES ($1, $2, $3, $4)`,
      [userB, orgB, 'beta@corp.com', 'Beta User'],
    );

    // Insert a session into Org B directly via adminPool
    const sessionBId = '55555555-5555-5555-5555-555555555555';
    await adminPool.query(
      `INSERT INTO attendance_sessions (
        id, org_id, user_id, device_id, work_date, clock_in_at, clock_in_source, last_heartbeat_at, ip_in, status, current_state
      ) VALUES ($1, $2, $3, 'dev-b', '2026-10-13', CURRENT_TIMESTAMP, 'AUTO_HEARTBEAT', CURRENT_TIMESTAMP, '127.0.0.1', 'OPEN', 'ACTIVE')`,
      [sessionBId, orgB, userB],
    );

    // Querying as Org A cannot SELECT Org B's session
    const selectRes = await repository.queryWithRls(
      orgId,
      `SELECT * FROM attendance_sessions WHERE id = $1`,
      [sessionBId],
    );
    assert.equal(selectRes.rows.length, 0, 'Org A must see 0 rows for Org B session');

    // Org A cannot UPDATE Org B's session
    const updateRes = await repository.queryWithRls(
      orgId,
      `UPDATE attendance_sessions SET active_seconds = 9999 WHERE id = $1`,
      [sessionBId],
    );
    assert.equal(updateRes.rowCount, 0, 'Org A cannot update Org B rows');

    // Org A cannot DELETE Org B's session
    const deleteRes = await repository.queryWithRls(
      orgId,
      `DELETE FROM attendance_sessions WHERE id = $1`,
      [sessionBId],
    );
    assert.equal(deleteRes.rowCount, 0, 'Org A cannot delete Org B rows');

    // Querying as Org B CAN see Org B's session
    const orgBSelect = await repository.queryWithRls(
      orgB,
      `SELECT * FROM attendance_sessions WHERE id = $1`,
      [sessionBId],
    );
    assert.equal(orgBSelect.rows.length, 1, 'Org B can see its own session');
    await repository.clearAll(orgB);
  });

  // 15. RLS Hardening: Missing app.org_id returns zero rows; foreign org INSERT is rejected by WITH CHECK
  it('RLS Hardening: Missing app.org_id returns zero rows; foreign org INSERT is rejected by WITH CHECK', async () => {
    const client = await repository.getPool().connect();
    try {
      // Query as hrvo_app without setting app.org_id
      const selectNoOrg = await client.query('SELECT * FROM attendance_sessions');
      assert.equal(selectNoOrg.rows.length, 0, 'Missing app.org_id must return zero rows');

      // INSERT without app.org_id must be rejected
      await assert.rejects(
        async () => {
          await client.query(
            `INSERT INTO users (org_id, email, display_name) VALUES ($1, 'fail@acme.com', 'Fail')`,
            [orgId],
          );
        },
        /violates row-level security policy/,
      );

      // In Org A transaction, INSERT with foreign org B ID must be rejected by WITH CHECK
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
      const foreignOrg = '99999999-9999-9999-9999-999999999999';
      await assert.rejects(
        async () => {
          await client.query(
            `INSERT INTO users (org_id, email, display_name) VALUES ($1, 'foreign@org.com', 'Foreign')`,
            [foreignOrg],
          );
        },
        /violates row-level security policy/,
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  // 16. Repository enforcement: Rejects queries without org context and enforces set_config in transaction
  it('Repository enforcement: Rejects queries without org context and enforces set_config in transaction', async () => {
    // Calling queryWithRls without orgId throws
    await assert.rejects(
      async () => {
        await repository.queryWithRls('', 'SELECT 1');
      },
      /Tenant context missing: orgId must be provided/,
    );

    await assert.rejects(
      async () => {
        await (repository as any).queryWithRls(null, 'SELECT 1');
      },
      /Tenant context missing: orgId must be provided/,
    );

    // Calling repository query methods with empty orgId fails
    await assert.rejects(
      async () => {
        await repository.findAllOpenSessions('');
      },
      /Tenant context missing/,
    );
  });

  // 17. Cleanup Jobs: Nonces (> 5m) & Stale Device Sequences
  it('Cleanup Jobs: Deletes nonces older than 5 minutes and stale device sequences', async () => {
    const clock = new MockClock(new Date('2026-10-13T10:00:00.000Z'));
    const service = new AttendanceService({}, clock, repository, orgId);

    // Insert nonces: one expired (6 mins ago = 360s), one fresh (1 min ago = 60s)
    const expiredTime = new Date('2026-10-13T09:54:00.000Z');
    const freshTime = new Date('2026-10-13T09:59:00.000Z');
    await repository.recordNonce(orgId, userId, 'nonce-expired-360s', expiredTime);
    await repository.recordNonce(orgId, userId, 'nonce-fresh-60s', freshTime);

    assert.equal(await repository.hasNonce(orgId, userId, 'nonce-expired-360s'), true);
    assert.equal(await repository.hasNonce(orgId, userId, 'nonce-fresh-60s'), true);

    // Run 5-minute cleanup job (default 300s)
    const cleanedNonces = await service.cleanupExpiredNonces(clock.now(), 300);
    assert.equal(cleanedNonces, 1, 'Exactly 1 expired nonce must be cleaned');
    assert.equal(await repository.hasNonce(orgId, userId, 'nonce-expired-360s'), false);
    assert.equal(await repository.hasNonce(orgId, userId, 'nonce-fresh-60s'), true);

    // Insert device sequences: one stale (40 days ago), one active (5 days ago)
    const staleDate = new Date('2026-09-03T10:00:00.000Z'); // 40 days ago
    const activeDate = new Date('2026-10-08T10:00:00.000Z'); // 5 days ago
    await repository.setDeviceSequence(orgId, userId, 'dev-stale', 10);
    await repository.setDeviceSequence(orgId, userId, 'dev-active', 20);

    // Backdate the updated_at column directly via admin pool for dev-stale and dev-active
    const adminPool = repository.getAdminPool();
    await adminPool.query(
      `UPDATE device_sequences SET updated_at = $1 WHERE device_id = 'dev-stale'`,
      [staleDate],
    );
    await adminPool.query(
      `UPDATE device_sequences SET updated_at = $1 WHERE device_id = 'dev-active'`,
      [activeDate],
    );

    // Clean up stale device sequences older than 30 days
    const cleanedDevices = await service.cleanupStaleDeviceSequences(clock.now(), 30);
    assert.equal(cleanedDevices, 1, 'Exactly 1 stale device sequence must be deleted');
    assert.equal(await repository.getLastDeviceSequence(orgId, userId, 'dev-stale'), 0);
    assert.equal(await repository.getLastDeviceSequence(orgId, userId, 'dev-active'), 20);
  });
});
