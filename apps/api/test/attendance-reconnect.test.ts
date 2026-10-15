/**
 * Section 6.2 row "DISCONNECTED -> reconnect within 120 s -> previous state" (FR-ATT-002).
 * A valid heartbeat proves the client is connected again, so it must resume the session
 * instead of leaving it DISCONNECTED until the grace window closes it.
 * Written before the fix (AGENTS.md: state-machine changes are test-first).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AttendanceService } from '../src/attendance/attendance.service.ts';
import { AttendanceState, SessionStatus } from '../../../packages/shared/src/attendance/types.ts';
import type { Clock, HeartbeatPayload } from '../../../packages/shared/src/attendance/types.ts';

class MockClock implements Clock {
  private t = new Date('2026-10-13T04:00:00.000Z').getTime();
  now(): Date {
    return new Date(this.t);
  }
  advanceSeconds(s: number): void {
    this.t += s * 1000;
  }
}

const orgId = 'org-reconnect';
const userId = 'user-reconnect';
const sessionId = 'session-reconnect';
const secret = 'reconnect-secret';

async function setup() {
  const clock = new MockClock();
  const service = new AttendanceService({}, clock);
  await service.registerSessionSecret(sessionId, secret);
  await service.recordMonitoringConsent({ orgId, userId, noticeVersion: 'v1.0.0' });
  let seq = 0;
  const beat = async (activeSeconds = 30) => {
    seq += 1;
    const hb: Omit<HeartbeatPayload, 'signature'> = {
      orgId, userId, deviceId: 'dev-1', sessionId, sequenceNumber: seq, nonce: `n-${seq}`,
      activeSeconds, idleSeconds: 30 - activeSeconds, tabVisible: true, windowFocused: true, inCall: false,
    };
    return await service.ingestHeartbeat({ ...hb, signature: service.getValidator().signHeartbeat(hb, secret) });
  };
  return { clock, service, beat };
}

describe('Reconnect within the grace window resumes the session (Section 6.2)', () => {
  it('a heartbeat while DISCONNECTED restores ACTIVE and cancels the grace timer', async () => {
    const { clock, service, beat } = await setup();
    await beat();
    clock.advanceSeconds(30);
    await service.onSocketDisconnect(userId, undefined, orgId);
    assert.equal((await service.getSession(userId))?.currentState, AttendanceState.DISCONNECTED);

    clock.advanceSeconds(20);
    const res = await beat();
    assert.equal(res.currentState, AttendanceState.ACTIVE);
    const s = await service.getSession(userId);
    assert.equal(s?.currentState, AttendanceState.ACTIVE);
    assert.equal(s?.status, SessionStatus.OPEN);
    assert.equal(s?.graceTimerExpiresAt ?? null, null);
  });

  it('restores the state from before the disconnect (on break stays on break)', async () => {
    const { clock, service, beat } = await setup();
    await beat();
    clock.advanceSeconds(10);
    await service.startBreak(userId, undefined, orgId);
    clock.advanceSeconds(10);
    await service.onSocketDisconnect(userId, undefined, orgId);
    clock.advanceSeconds(10);
    const res = await beat();
    assert.equal(res.currentState, AttendanceState.ON_BREAK);
  });

  it('the same session continues (no second clock-in)', async () => {
    const { clock, service, beat } = await setup();
    const first = await beat();
    clock.advanceSeconds(30);
    await service.onSocketDisconnect(userId, undefined, orgId);
    clock.advanceSeconds(30);
    const after = await beat();
    assert.equal(after.session.id, first.session.id);
    assert.equal(after.session.clockInAt.getTime(), first.session.clockInAt.getTime());
  });

  it('a disconnect that started earlier cannot overwrite a newer heartbeat (no lost update)', async () => {
    const { clock, service, beat } = await setup();
    await beat();
    clock.advanceSeconds(30);

    // Make the disconnect's read slow so the next heartbeat completes in between.
    const realGetSession = service.getSession.bind(service);
    let slowOnce = true;
    service.getSession = async (u: string, o?: string) => {
      const s = await realGetSession(u, o);
      if (slowOnce) {
        slowOnce = false;
        await new Promise((r) => setTimeout(r, 50));
      }
      return s;
    };

    const disconnect = service.onSocketDisconnect(userId, undefined, orgId);
    await new Promise((r) => setTimeout(r, 5));
    const hb = beat();
    await Promise.all([disconnect, hb]);
    service.getSession = realGetSession;

    const s = await service.getSession(userId);
    assert.equal(s?.activeSeconds, 60, 'both heartbeats counted');
    assert.equal(s?.currentState, AttendanceState.ACTIVE, 'heartbeat after the disconnect resumed the session');
  });
});
