/**
 * Presence challenge (FR-ATT-023; ADR 019), written before the implementation. With the org option
 * on, reaching the pause threshold asks "Are you still working?" instead of pausing at once; a reply
 * within 60 seconds (server clock) resumes ACTIVE, otherwise the session pauses from the moment the
 * question was asked. The idle time itself is never turned into active time.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AttendanceState } from '../../../packages/shared/src/attendance/types.ts';
import type { AttendanceSession, HeartbeatPayload } from '../../../packages/shared/src/attendance/types.ts';
import { AttendanceStateMachine, InvalidTransitionError } from '../src/attendance/attendance-state-machine.ts';

const base = {
  heartbeatIntervalSeconds: 30, missedHeartbeatTimeoutSeconds: 90, disconnectGraceWindowSeconds: 120,
  idleThresholdSeconds: 300, pauseThresholdSeconds: 900, maxSessionLengthSeconds: 14 * 3600, orgTimezone: 'Asia/Colombo',
};
const t0 = new Date('2026-10-13T04:00:00.000Z');
const at = (s: number) => new Date(t0.getTime() + s * 1000);
let seq = 0;
const hb = (o: Partial<HeartbeatPayload> = {}): HeartbeatPayload => {
  seq += 1;
  return { orgId: 'o', userId: 'u', deviceId: 'd', sessionId: 's', sequenceNumber: seq, nonce: `n${seq}`, activeSeconds: 0, idleSeconds: 30, tabVisible: true, windowFocused: true, inCall: false, signature: 'x', ...o };
};

/** Clock in, then idle heartbeats every 30 s up to (and including) `untilS`. */
function idleUntil(sm: AttendanceStateMachine, untilS: number): { s: AttendanceSession; last: ReturnType<AttendanceStateMachine['handleHeartbeat']> } {
  let r = sm.handleHeartbeat(null, hb({ activeSeconds: 30, idleSeconds: 0 }), t0, '1.1.1.1');
  for (let x = 30; x <= untilS; x += 30) r = sm.handleHeartbeat(r.session, hb(), at(x), '1.1.1.1');
  return { s: r.session, last: r };
}

describe('Presence challenge (FR-ATT-023)', () => {
  it('off (default): the session pauses at the threshold as before', () => {
    const { s } = idleUntil(new AttendanceStateMachine(base), 900);
    assert.equal(s.currentState, AttendanceState.PAUSED);
    assert.equal(s.challengeId ?? null, null);
  });

  const sm = new AttendanceStateMachine({ ...base, presenceChallengeEnabled: true, presenceChallengeSeconds: 60 });

  it('on: reaching the threshold issues a challenge and keeps the session IDLE', () => {
    const { s, last } = idleUntil(sm, 900);
    assert.equal(s.currentState, AttendanceState.IDLE);
    assert.ok(s.challengeId);
    assert.equal(s.challengeIssuedAt?.toISOString(), at(900).toISOString());
    assert.deepEqual(last.challenge, { id: s.challengeId, expiresAt: at(960) });
  });

  it('idle heartbeats inside the window neither pause nor issue a second challenge', () => {
    const { s } = idleUntil(sm, 900);
    const r = sm.handleHeartbeat(s, hb(), at(930), '1.1.1.1');
    assert.equal(r.session.currentState, AttendanceState.IDLE);
    assert.equal(r.session.challengeId, s.challengeId);
    assert.equal(r.challenge, undefined);
  });

  it('a reply within 60 seconds resumes ACTIVE without a long-idle flag; idle time stays idle', () => {
    const { s } = idleUntil(sm, 900);
    const idleBefore = s.idleSeconds;
    const r = sm.handleChallengeResponse(s, s.challengeId!, at(945));
    assert.equal(r.session.currentState, AttendanceState.ACTIVE);
    assert.equal(r.session.challengeId, null);
    assert.equal(r.session.consecutiveIdleSeconds, 0);
    assert.ok(!r.session.flags.includes('LONG_IDLE'));
    assert.equal(r.session.idleSeconds, idleBefore);
    assert.equal(r.session.activeSeconds, s.activeSeconds, 'answering does not add active time');
  });

  it('no reply: the next heartbeat after 60 s pauses the session from the moment it was asked', () => {
    const { s } = idleUntil(sm, 900);
    const r = sm.handleHeartbeat(s, hb(), at(990), '1.1.1.1');
    assert.equal(r.session.currentState, AttendanceState.PAUSED);
    assert.equal(r.session.challengeId, null);
    const paused = r.session.segments[r.session.segments.length - 1]!;
    assert.equal(paused.state, AttendanceState.PAUSED);
    assert.equal(paused.startedAt.toISOString(), at(900).toISOString());
  });

  it('the reconciler expires an unanswered challenge even without heartbeats', () => {
    const { s } = idleUntil(sm, 900);
    assert.equal(sm.handleChallengeExpiry(s, at(950)), null, 'not yet');
    const r = sm.handleChallengeExpiry(s, at(961))!;
    assert.equal(r.session.currentState, AttendanceState.PAUSED);
  });

  it('late or wrong replies are refused (server clock decides)', () => {
    const { s } = idleUntil(sm, 900);
    assert.throws(() => sm.handleChallengeResponse(s, s.challengeId!, at(961)), InvalidTransitionError);
    assert.throws(() => sm.handleChallengeResponse(s, '00000000-0000-4000-8000-000000000000', at(930)), InvalidTransitionError);
  });

  it('real input during the window clears the challenge like a reply', () => {
    const { s } = idleUntil(sm, 900);
    const r = sm.handleHeartbeat(s, hb({ activeSeconds: 12, idleSeconds: 18 }), at(930), '1.1.1.1');
    assert.equal(r.session.currentState, AttendanceState.ACTIVE);
    assert.equal(r.session.challengeId, null);
  });

  it('an open challenge carries over the midnight split and still expires', () => {
    const lateSm = new AttendanceStateMachine({ ...base, presenceChallengeEnabled: true });
    // Asia/Colombo midnight is 18:30 UTC; start 15.5 minutes before so the threshold is reached at 23:59:30.
    const start = new Date('2026-10-13T18:14:00.000Z');
    let r = lateSm.handleHeartbeat(null, hb({ activeSeconds: 30, idleSeconds: 0 }), start, '1.1.1.1');
    for (let x = 30; x <= 900; x += 30) r = lateSm.handleHeartbeat(r.session, hb(), new Date(start.getTime() + x * 1000), '1.1.1.1');
    assert.ok(r.session.challengeId, 'issued before midnight');
    const split = lateSm.handleMidnightCheck(r.session, new Date('2026-10-13T18:30:05.000Z'));
    assert.ok(split.splitSession);
    assert.equal(split.session.challengeId ?? null, null, 'the closed day keeps no open question');
    assert.equal(split.splitSession!.challengeId, r.session.challengeId);
    const expired = lateSm.handleChallengeExpiry(split.splitSession!, new Date('2026-10-13T18:31:00.000Z'))!;
    assert.equal(expired.session.currentState, AttendanceState.PAUSED);
  });
});
