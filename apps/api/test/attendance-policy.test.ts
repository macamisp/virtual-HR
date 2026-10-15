/**
 * FR-ADM-001: attendance policy per organisation (SRS 6.4). The state machine is unchanged; it
 * is built from each org's own thresholds. Written before the implementation (AGENTS.md:
 * attendance state machine changes start with failing tests).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AttendanceService } from '../src/attendance/attendance.service.ts';
import { AttendanceState, SessionStatus } from '../../../packages/shared/src/attendance/types.ts';
import type { AttendanceConfig, Clock, HeartbeatPayload } from '../../../packages/shared/src/attendance/types.ts';
import { validateAttendancePolicy } from '../src/admin/policy-rules.ts';

class MockClock implements Clock {
  constructor(private t: Date) {}
  now(): Date {
    return new Date(this.t.getTime());
  }
  advance(seconds: number): void {
    this.t = new Date(this.t.getTime() + seconds * 1000);
  }
}

const STRICT = 'org-strict';
const NORMAL = 'org-normal';
const strictPolicy: Partial<AttendanceConfig> = {
  idleThresholdSeconds: 120,
  pauseThresholdSeconds: 300,
  missedHeartbeatTimeoutSeconds: 60,
  maxSessionLengthSeconds: 8 * 3600,
};

async function setup(clock: MockClock) {
  const service = new AttendanceService({}, clock);
  let calls = 0;
  service.setPolicyProvider(async (orgId) => {
    calls += 1;
    return orgId === STRICT ? strictPolicy : null;
  });
  const secrets = new Map<string, string>();
  const seq = new Map<string, number>();
  for (const org of [STRICT, NORMAL]) {
    const secret = service.generateSessionSecret();
    secrets.set(org, secret);
    await service.registerSessionSecret(`sess-${org}`, secret, org);
    await service.recordMonitoringConsent({ orgId: org, userId: `user-${org}`, noticeVersion: 'v1.0.0' });
  }
  const beat = async (org: string, active: boolean) => {
    const n = (seq.get(org) ?? 0) + 1;
    seq.set(org, n);
    const unsigned: Omit<HeartbeatPayload, 'signature'> = {
      orgId: org, userId: `user-${org}`, deviceId: 'dev-1', sessionId: `sess-${org}`, sequenceNumber: n, nonce: `${org}-${n}`,
      activeSeconds: active ? 30 : 0, idleSeconds: active ? 0 : 30, tabVisible: true, windowFocused: true, inCall: false,
    };
    return await service.ingestHeartbeat({ ...unsigned, signature: service.getValidator().signHeartbeat(unsigned, secrets.get(org)!) });
  };
  return { service, beat, calls: () => calls };
}

describe('Attendance policy per organisation (FR-ADM-001)', () => {
  it('the idle threshold comes from the organisation', async () => {
    const clock = new MockClock(new Date('2026-10-13T04:00:00Z'));
    const { beat } = await setup(clock);
    await beat(STRICT, true);
    await beat(NORMAL, true);
    let strict = null;
    let normal = null;
    for (let i = 0; i < 5; i += 1) {
      clock.advance(30);
      strict = await beat(STRICT, false);
      normal = await beat(NORMAL, false);
    }
    // 150 s idle: past the strict 120 s threshold, below the default 300 s.
    assert.equal(strict!.currentState, AttendanceState.IDLE);
    assert.equal(normal!.currentState, AttendanceState.ACTIVE);
  });

  it('the missed-heartbeat timeout and maximum session length come from the organisation', async () => {
    const clock = new MockClock(new Date('2026-10-13T04:00:00Z'));
    const { service, beat } = await setup(clock);
    await beat(STRICT, true);
    await beat(NORMAL, true);
    clock.advance(70); // silent for 70 s: past the strict 60 s, below the default 90 s
    await service.runReconciliation(clock.now(), STRICT);
    await service.runReconciliation(clock.now(), NORMAL);
    assert.equal(await service.getSession(`user-${STRICT}`, STRICT), null, 'strict org closed the session');
    assert.equal((await service.getSession(`user-${NORMAL}`, NORMAL))?.status, SessionStatus.OPEN);
  });

  it('the policy is cached and can be invalidated after an admin change', async () => {
    const clock = new MockClock(new Date('2026-10-13T04:00:00Z'));
    const { service, beat, calls } = await setup(clock);
    await beat(STRICT, true);
    await beat(STRICT, true);
    assert.equal(calls() >= 1 && calls() <= 2, true, 'not one lookup per heartbeat');
    const before = calls();
    service.invalidatePolicy(STRICT);
    await beat(STRICT, true);
    assert.equal(calls(), before + 1);
  });

  it('policy values are validated against the SRS 6.4 ranges', () => {
    assert.deepEqual(validateAttendancePolicy({ idleThresholdSeconds: 300, pauseThresholdSeconds: 900 }), []);
    assert.match(validateAttendancePolicy({ idleThresholdSeconds: 60 }).join(), /idle/i, 'idle below 2 min');
    assert.match(validateAttendancePolicy({ idleThresholdSeconds: 600, pauseThresholdSeconds: 300 }).join(), /pause/i, 'pause must exceed idle');
    assert.match(validateAttendancePolicy({ maxSessionLengthSeconds: 20 * 3600 }).join(), /session/i);
    assert.match(validateAttendancePolicy({ missedHeartbeatTimeoutSeconds: 30 }).join(), /heartbeat/i);
    assert.match(validateAttendancePolicy({ disconnectGraceWindowSeconds: 600 }).join(), /grace/i);
  });
});
