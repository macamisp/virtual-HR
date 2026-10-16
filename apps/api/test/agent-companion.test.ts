/**
 * Desktop agent alongside the browser (FR-ATT-011, FR-ATT-010; ADR 018).
 * The agent reads OS-level idle time, which already covers input in the browser, so while an
 * agent is live its counters are the only ones that count; browser heartbeats keep the session
 * alive and carry the in-call flag. Agent + browser is not "multi-device"; two agents are.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AttendanceState, ClockInSource } from '../../../packages/shared/src/attendance/types.ts';
import type { AttendanceSession, HeartbeatPayload } from '../../../packages/shared/src/attendance/types.ts';
import { AttendanceStateMachine } from '../src/attendance/attendance-state-machine.ts';

const sm = new AttendanceStateMachine({
  heartbeatIntervalSeconds: 30,
  missedHeartbeatTimeoutSeconds: 90,
  disconnectGraceWindowSeconds: 120,
  idleThresholdSeconds: 300,
  pauseThresholdSeconds: 900,
  maxSessionLengthSeconds: 14 * 3600,
  orgTimezone: 'Asia/Colombo',
});

const t0 = new Date('2026-10-13T04:00:00.000Z');
const at = (s: number) => new Date(t0.getTime() + s * 1000);
let seq = 0;
function hb(deviceId: string, o: Partial<HeartbeatPayload> = {}): HeartbeatPayload {
  seq += 1;
  return {
    orgId: 'org-1', userId: 'user-1', deviceId, sessionId: 'auth-1', sequenceNumber: seq, nonce: `n-${seq}`,
    activeSeconds: 30, idleSeconds: 0, tabVisible: true, windowFocused: true, inCall: false, signature: 'x', ...o,
  };
}

describe('Desktop agent as the authoritative activity source', () => {
  it('the first agent heartbeat clocks in with source AGENT', () => {
    const r = sm.handleHeartbeat(null, hb('agent-A'), t0, '10.0.0.1', 'AGENT');
    assert.equal(r.session.clockInSource, ClockInSource.AGENT);
    assert.equal(r.session.agentDeviceId, 'agent-A');
    assert.equal(r.session.agentLastSeenAt?.toISOString(), t0.toISOString());
  });

  it('agent and browser interleaved for 10 minutes: no double count and no MULTI_DEVICE flag', () => {
    let s: AttendanceSession = sm.handleHeartbeat(null, hb('web-1'), t0, '10.0.0.1', 'WEB').session;
    for (let i = 1; i <= 20; i += 1) {
      s = sm.handleHeartbeat(s, hb('agent-A'), at(i * 30 - 15), '10.0.0.1', 'AGENT').session;
      s = sm.handleHeartbeat(s, hb('web-1'), at(i * 30), '10.0.0.1', 'WEB').session;
    }
    // 30 s from the first browser heartbeat (before any agent) + 20 agent heartbeats of 30 s.
    assert.equal(s.activeSeconds, 30 + 20 * 30);
    assert.ok(!s.flags.includes('MULTI_DEVICE'), `flags: ${s.flags.join(',')}`);
  });

  it('browser counters count again once the agent has been silent beyond the heartbeat timeout', () => {
    let s = sm.handleHeartbeat(null, hb('agent-A'), t0, '10.0.0.1', 'AGENT').session;
    s = sm.handleHeartbeat(s, hb('web-1'), at(30), '10.0.0.1', 'WEB').session; // agent live: ignored
    assert.equal(s.activeSeconds, 30);
    s = sm.handleHeartbeat(s, hb('web-1'), at(150), '10.0.0.1', 'WEB').session; // agent silent 150 s
    assert.equal(s.activeSeconds, 60);
  });

  it('a second agent device is flagged MULTI_DEVICE', () => {
    let s = sm.handleHeartbeat(null, hb('agent-A'), t0, '10.0.0.1', 'AGENT').session;
    s = sm.handleHeartbeat(s, hb('agent-B'), at(10), '10.0.0.2', 'AGENT').session;
    assert.ok(s.flags.includes('MULTI_DEVICE'));
  });

  it('two browsers without an agent are still flagged MULTI_DEVICE (FR-ATT-010 unchanged)', () => {
    let s = sm.handleHeartbeat(null, hb('web-1'), t0, '10.0.0.1', 'WEB').session;
    s = sm.handleHeartbeat(s, hb('web-2'), at(10), '10.0.0.1', 'WEB').session;
    assert.ok(s.flags.includes('MULTI_DEVICE'));
  });

  it('a call in the browser keeps the session ACTIVE while the agent sees no input (FR-ATT-006)', () => {
    let s = sm.handleHeartbeat(null, hb('agent-A'), t0, '10.0.0.1', 'AGENT').session;
    for (let i = 1; i <= 20; i += 1) { // 10 minutes, twice the idle threshold
      s = sm.handleHeartbeat(s, hb('web-1', { activeSeconds: 0, idleSeconds: 30, inCall: true }), at(i * 30 - 15), '10.0.0.1', 'WEB').session;
      s = sm.handleHeartbeat(s, hb('agent-A', { activeSeconds: 0, idleSeconds: 30 }), at(i * 30), '10.0.0.1', 'AGENT').session;
    }
    assert.equal(s.currentState, AttendanceState.ACTIVE);
  });

  it('without a call, agent-reported idle time still moves the session to IDLE', () => {
    let s = sm.handleHeartbeat(null, hb('agent-A'), t0, '10.0.0.1', 'AGENT').session;
    for (let i = 1; i <= 11; i += 1) s = sm.handleHeartbeat(s, hb('agent-A', { activeSeconds: 0, idleSeconds: 30 }), at(i * 30), '10.0.0.1', 'AGENT').session;
    assert.equal(s.currentState, AttendanceState.IDLE);
  });

  it('the agent keeps leading after the midnight split (and the country carries over)', () => {
    const s = sm.handleHeartbeat(null, hb('agent-A'), new Date('2026-10-13T18:29:30.000Z'), '10.0.0.1', 'AGENT').session;
    s.countryIn = 'LK';
    s.countryOut = 'LK';
    const split = sm.handleMidnightCheck(s, new Date('2026-10-13T18:30:05.000Z')).splitSession!;
    assert.equal(split.agentDeviceId, 'agent-A');
    assert.equal(split.countryIn, 'LK');
    const after = sm.handleHeartbeat(split, hb('web-1'), new Date('2026-10-13T18:30:20.000Z'), '10.0.0.1', 'WEB').session;
    assert.equal(after.activeSeconds, 0, 'browser counters still ignored while the agent is live');
    assert.ok(!after.flags.includes('MULTI_DEVICE'));
  });
});
