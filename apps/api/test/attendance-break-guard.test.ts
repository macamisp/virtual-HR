/**
 * FR-ATT-007 / Section 6.2 rows 8-9: break transitions are only valid from the right states.
 * Written before the fix (AGENTS.md: state-machine changes are test-first).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AttendanceService } from '../src/attendance/attendance.service.ts';
import { InvalidTransitionError } from '../src/attendance/attendance-state-machine.ts';
import { AttendanceState } from '../../../packages/shared/src/attendance/types.ts';
import type { Clock, HeartbeatPayload } from '../../../packages/shared/src/attendance/types.ts';

class MockClock implements Clock {
  private t: number;
  constructor(iso: string) {
    this.t = new Date(iso).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  advanceSeconds(s: number): void {
    this.t += s * 1000;
  }
}

const orgId = 'org-break-guard';
const userId = 'user-break-guard';
const sessionId = 'session-break-guard';
const secret = 'break-guard-secret';

async function startedService(): Promise<{ service: AttendanceService; clock: MockClock }> {
  const clock = new MockClock('2026-10-13T04:00:00.000Z');
  const service = new AttendanceService({}, clock);
  await service.registerSessionSecret(sessionId, secret);
  await service.recordMonitoringConsent({ orgId, userId, noticeVersion: 'v1.0.0' });
  const hb: Omit<HeartbeatPayload, 'signature'> = {
    orgId,
    userId,
    deviceId: 'dev-1',
    sessionId,
    sequenceNumber: 1,
    nonce: 'n-1',
    activeSeconds: 30,
    idleSeconds: 0,
    tabVisible: true,
    windowFocused: true,
    inCall: false,
  };
  await service.ingestHeartbeat({ ...hb, signature: service.getValidator().signHeartbeat(hb, secret) });
  return { service, clock };
}

describe('Break transition guards (FR-ATT-007, Section 6.2 rows 8-9)', () => {
  it('ending a break while not on break is rejected and does not add break time', async () => {
    const { service, clock } = await startedService();
    clock.advanceSeconds(600);
    await assert.rejects(service.endBreak(userId), InvalidTransitionError);
    const s = await service.getSession(userId);
    assert.equal(s?.currentState, AttendanceState.ACTIVE);
    assert.equal(s?.breakSeconds, 0);
  });

  it('starting a break while already on break is rejected and keeps a single break segment', async () => {
    const { service, clock } = await startedService();
    clock.advanceSeconds(60);
    await service.startBreak(userId);
    clock.advanceSeconds(60);
    await assert.rejects(service.startBreak(userId), InvalidTransitionError);
    const s = await service.getSession(userId);
    assert.equal(s?.currentState, AttendanceState.ON_BREAK);
    assert.equal(s?.segments.filter((seg) => seg.state === AttendanceState.ON_BREAK).length, 1);
  });

  it('a break cannot start while the socket is disconnected', async () => {
    const { service, clock } = await startedService();
    clock.advanceSeconds(30);
    await service.onSocketDisconnect(userId);
    await assert.rejects(service.startBreak(userId), InvalidTransitionError);
  });

  it('a normal start/end cycle still records break seconds exactly', async () => {
    const { service, clock } = await startedService();
    clock.advanceSeconds(60);
    await service.startBreak(userId);
    clock.advanceSeconds(900);
    const res = await service.endBreak(userId);
    assert.equal(res?.currentState, AttendanceState.ACTIVE);
    assert.equal(res?.session.breakSeconds, 900);
  });
});
