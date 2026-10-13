/**
 * Integration Test Suite for AttendanceService & HeartbeatValidator
 * Ref: docs/SRS.md FR-ATT-001..005 & Section 6.3 Reconciler
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AttendanceService } from '../src/attendance/attendance.service.ts';
import {
  AttendanceState,
  ClockOutSource,
  SessionStatus,
} from '../../../packages/shared/src/attendance/types.ts';
import type { HeartbeatPayload } from '../../../packages/shared/src/attendance/types.ts';

describe('AttendanceService & Heartbeat Cryptographic Ingestion', () => {
  const secretKey = 'super-secret-session-key-01';
  const userId = 'user-emp-101';
  const orgId = 'org-456';
  const deviceId = 'device-laptop-01';

  function createSignedPayload(
    service: AttendanceService,
    overrides: Partial<HeartbeatPayload> = {},
  ): HeartbeatPayload {
    const unsigned: Omit<HeartbeatPayload, 'signature'> = {
      orgId,
      userId,
      deviceId,
      sequenceNumber: 1,
      nonce: 'nonce-uuid-1',
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

  it('FR-ATT-001 & FR-ATT-004: Ingests valid signed heartbeat and establishes session', () => {
    const service = new AttendanceService();
    service.registerUserSecret(userId, secretKey);

    const hb = createSignedPayload(service, { sequenceNumber: 1, nonce: 'nonce-1' });
    const now = new Date('2026-10-13T10:00:00.000Z');

    const res = service.ingestHeartbeat(hb, now, '192.168.1.50');

    assert.equal(res.currentState, AttendanceState.ACTIVE);
    assert.equal(res.session.status, SessionStatus.OPEN);
    assert.equal(res.session.userId, userId);
    assert.equal(res.session.clockInAt.toISOString(), now.toISOString());
    assert.equal(service.getSession(userId)?.id, res.session.id);
  });

  it('FR-ATT-004: Rejects tampered signature', () => {
    const service = new AttendanceService();
    service.registerUserSecret(userId, secretKey);

    const hb = createSignedPayload(service, { sequenceNumber: 1, nonce: 'nonce-tamper' });
    hb.signature = 'deadbeef0000111122223333444455556666777788889999aaaabbbbccccdddd';

    assert.throws(
      () => service.ingestHeartbeat(hb, new Date()),
      /Invalid HMAC signature/,
    );
  });

  it('FR-ATT-017 / Anti-spoofing: Rejects replayed nonce', () => {
    const service = new AttendanceService();
    service.registerUserSecret(userId, secretKey);

    const hb1 = createSignedPayload(service, { sequenceNumber: 1, nonce: 'replayed-nonce' });
    service.ingestHeartbeat(hb1, new Date('2026-10-13T10:00:00.000Z'));

    // Attempt second heartbeat reusing the same nonce
    const hb2 = createSignedPayload(service, { sequenceNumber: 2, nonce: 'replayed-nonce' });
    assert.throws(
      () => service.ingestHeartbeat(hb2, new Date('2026-10-13T10:00:30.000Z')),
      /Replay attack detected/,
    );
  });

  it('FR-ATT-017 / Anti-spoofing: Rejects non-monotonic sequence numbers', () => {
    const service = new AttendanceService();
    service.registerUserSecret(userId, secretKey);

    const hb1 = createSignedPayload(service, { sequenceNumber: 5, nonce: 'nonce-seq-5' });
    service.ingestHeartbeat(hb1, new Date('2026-10-13T10:00:00.000Z'));

    // Send sequence 4 (less than 5)
    const hbOld = createSignedPayload(service, { sequenceNumber: 4, nonce: 'nonce-seq-4' });
    assert.throws(
      () => service.ingestHeartbeat(hbOld, new Date('2026-10-13T10:00:30.000Z')),
      /Sequence violation/,
    );
  });

  it('FR-ATT-004: Privacy guardrail rejects forbidden content payloads', () => {
    const service = new AttendanceService();
    service.registerUserSecret(userId, secretKey);

    const hb = createSignedPayload(service, { sequenceNumber: 1, nonce: 'nonce-priv' });
    (hb as any).keystrokes = 'user typed sensitive bank password';

    assert.throws(
      () => service.ingestHeartbeat(hb, new Date()),
      /Privacy violation/,
    );
  });
});

describe('AttendanceService Section 6.3 60-Second Reconciliation Worker', () => {
  const secretKey = 'reconcile-secret';
  const userId = 'user-rec-202';
  const orgId = 'org-456';
  const deviceId = 'dev-rec-01';

  it('FR-ATT-002: Reconciler closes sessions when heartbeats are missing for > 90s', () => {
    const service = new AttendanceService({ missedHeartbeatTimeoutSeconds: 90 });
    service.registerUserSecret(userId, secretKey);

    const start = new Date('2026-10-13T09:00:00.000Z');
    const unsigned = {
      orgId,
      userId,
      deviceId,
      sequenceNumber: 1,
      nonce: 'nonce-rec-1',
      activeSeconds: 30,
      idleSeconds: 0,
      tabVisible: true,
      windowFocused: true,
      inCall: false,
    };
    const signature = service.getValidator().signHeartbeat(unsigned, secretKey);
    service.ingestHeartbeat({ ...unsigned, signature }, start);

    assert.equal(service.getSession(userId)?.status, SessionStatus.OPEN);

    // Reconciler runs after 95 seconds without new heartbeats
    const checkTime = new Date(start.getTime() + 95000);
    const summary = service.runReconciliation(checkTime);

    assert.equal(summary.closedCount, 1);
    assert.equal(service.getSession(userId), null);
    const closed = service.getAllOpenSessions();
    assert.equal(closed.length, 0);
  });

  it('FR-ATT-002: Reconciler closes disconnected sessions when 120s grace expires', () => {
    const service = new AttendanceService({ disconnectGraceWindowSeconds: 120 });
    service.registerUserSecret(userId, secretKey);

    const start = new Date('2026-10-13T09:00:00.000Z');
    const unsigned = {
      orgId,
      userId,
      deviceId,
      sequenceNumber: 1,
      nonce: 'nonce-grace-1',
      activeSeconds: 30,
      idleSeconds: 0,
      tabVisible: true,
      windowFocused: true,
      inCall: false,
    };
    const signature = service.getValidator().signHeartbeat(unsigned, secretKey);
    service.ingestHeartbeat({ ...unsigned, signature }, start);

    // Socket disconnect occurs at 09:00:10
    const dcTime = new Date(start.getTime() + 10000);
    service.onSocketDisconnect(userId, dcTime);
    assert.equal(service.getSession(userId)?.currentState, AttendanceState.DISCONNECTED);

    // Reconciler runs at 09:00:50 (40s after disconnect, grace still active)
    service.runReconciliation(new Date(start.getTime() + 50000));
    assert.equal(service.getSession(userId)?.status, SessionStatus.OPEN);

    // Reconciler runs at 09:02:15 (125s after disconnect, grace expired)
    const summary = service.runReconciliation(new Date(dcTime.getTime() + 125000));
    assert.equal(summary.closedCount, 1);
    assert.equal(service.getSession(userId), null);
  });

  it('FR-ATT-008 & Section 6.2 Row 15: Reconciler automatically splits session crossing midnight', () => {
    const service = new AttendanceService({ orgTimezone: 'Asia/Colombo' });
    service.registerUserSecret(userId, secretKey);

    // 23:50:00 Asia/Colombo = 18:20:00 UTC
    const preMidnight = new Date('2026-10-13T18:20:00.000Z');
    const unsigned = {
      orgId,
      userId,
      deviceId,
      sequenceNumber: 1,
      nonce: 'nonce-mid-1',
      activeSeconds: 30,
      idleSeconds: 0,
      tabVisible: true,
      windowFocused: true,
      inCall: false,
    };
    const signature = service.getValidator().signHeartbeat(unsigned, secretKey);
    const initialRes = service.ingestHeartbeat({ ...unsigned, signature }, preMidnight);

    // Reconciler runs at 00:05:00 next day (Colombo) = 18:35:00 UTC
    const postMidnight = new Date('2026-10-13T18:35:00.000Z');
    const summary = service.runReconciliation(postMidnight);

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
});
