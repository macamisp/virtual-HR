/**
 * ADR 049 §1b (FR-WT-001, FR-WT-002): meeting time needs someone else in the call, as the server
 * sees it. The browser's inCall alone is never enough.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCallEvidence, PARTICIPANTS_TTL_MS, PARTICIPANTS_GRACE_MS, type CallEvidenceDeps, type OfficeView } from '../src/media/call-evidence.service.ts';
import { AttendanceService } from '../src/attendance/attendance.service.ts';
import { AttendanceState, type Clock, type HeartbeatPayload } from '../../../packages/shared/src/attendance/types.ts';

const ORG = 'org-1';
const MEETING = '11111111-2222-4333-8444-555555555555';

function world(avatars: Record<string, string | null>, groups: Record<string, { id: string; members: string[] }> = {}): OfficeView {
  return {
    avatars: new Map(Object.entries(avatars).map(([u, roomId]) => [u, { roomId }])),
    rooms: [{ id: 'meet-room', type: 'MEETING' }, { id: 'open-area', type: 'OPEN' }],
    groupByUser: new Map(Object.entries(groups)),
  };
}

function deps(over: Partial<CallEvidenceDeps> & { clock?: { t: number } } = {}): CallEvidenceDeps & { calls: number } {
  const clock = over.clock ?? { t: 1_000_000 };
  const d = {
    calls: 0,
    world: over.world ?? (() => null),
    meetingRoom: over.meetingRoom ?? (async (_o: string, id: string) => (id === MEETING ? 'org-1_meeting_x' : null)),
    participants: async (room: string) => { d.calls += 1; return (over.participants ?? (async () => []))(room); },
    now: () => clock.t,
  };
  return d;
}

describe('ADR 049: server call evidence', () => {
  it('an avatar alone in a closed meeting room is not in a call', async () => {
    const ev = new ServerCallEvidence(deps({ world: () => world({ alice: 'meet-room' }) }));
    assert.equal(await ev.verify({ orgId: ORG, userId: 'alice', meetingId: null }), null);
  });

  it('two avatars in the same closed room are a ROOM call', async () => {
    const ev = new ServerCallEvidence(deps({ world: () => world({ alice: 'meet-room', bob: 'meet-room', carol: null }) }));
    assert.equal(await ev.verify({ orgId: ORG, userId: 'alice', meetingId: null }), 'ROOM');
  });

  it('someone in the open area next to nobody is not in a call; a proximity group of two is', async () => {
    const alone = new ServerCallEvidence(deps({ world: () => world({ alice: 'open-area' }, { alice: { id: 'g1', members: ['alice'] } }) }));
    assert.equal(await alone.verify({ orgId: ORG, userId: 'alice', meetingId: null }), null);
    const pair = new ServerCallEvidence(deps({ world: () => world({ alice: 'open-area', bob: 'open-area' }, { alice: { id: 'g1', members: ['alice', 'bob'] } }) }));
    assert.equal(await pair.verify({ orgId: ORG, userId: 'alice', meetingId: null }), 'PROXIMITY');
  });

  it('not in the office at all: no call', async () => {
    const ev = new ServerCallEvidence(deps({ world: () => world({ bob: 'meet-room' }) }));
    assert.equal(await ev.verify({ orgId: ORG, userId: 'alice', meetingId: null }), null);
  });

  it('a meeting counts only when LiveKit shows this person and someone else connected', async () => {
    const solo = new ServerCallEvidence(deps({ participants: async () => ['alice'] }));
    assert.equal(await solo.verify({ orgId: ORG, userId: 'alice', meetingId: MEETING }), null);
    const pair = new ServerCallEvidence(deps({ participants: async () => ['alice', 'bob'] }));
    assert.equal(await pair.verify({ orgId: ORG, userId: 'alice', meetingId: MEETING }), 'MEETING');
    const notMe = new ServerCallEvidence(deps({ participants: async () => ['bob', 'carol'] }));
    assert.equal(await notMe.verify({ orgId: ORG, userId: 'alice', meetingId: MEETING }), null, 'claiming someone else\'s meeting');
  });

  it('an unknown, ended or malformed meeting id is never a call', async () => {
    const ev = new ServerCallEvidence(deps({ participants: async () => ['alice', 'bob'] }));
    assert.equal(await ev.verify({ orgId: ORG, userId: 'alice', meetingId: '99999999-2222-4333-8444-555555555555' }), null);
    assert.equal(await ev.verify({ orgId: ORG, userId: 'alice', meetingId: 'not-a-uuid' }), null);
  });

  it('asks LiveKit at most once per room per 30 s, however many heartbeats arrive', async () => {
    const clock = { t: 1_000_000 };
    const d = deps({ clock, participants: async () => ['alice', 'bob'] });
    const ev = new ServerCallEvidence(d);
    await Promise.all([ev.verify({ orgId: ORG, userId: 'alice', meetingId: MEETING }), ev.verify({ orgId: ORG, userId: 'bob', meetingId: MEETING })]);
    await ev.verify({ orgId: ORG, userId: 'alice', meetingId: MEETING });
    assert.equal(d.calls, 1);
    clock.t += PARTICIPANTS_TTL_MS;
    await ev.verify({ orgId: ORG, userId: 'alice', meetingId: MEETING });
    assert.equal(d.calls, 2);
  });

  it('LiveKit unreachable: the last answer stands for 90 s, then the call is not counted', async () => {
    const clock = { t: 1_000_000 };
    let up = true;
    const ev = new ServerCallEvidence(deps({ clock, participants: async () => { if (!up) throw new Error('down'); return ['alice', 'bob']; } }));
    assert.equal(await ev.verify({ orgId: ORG, userId: 'alice', meetingId: MEETING }), 'MEETING');
    up = false;
    clock.t += PARTICIPANTS_TTL_MS + 1;
    assert.equal(await ev.verify({ orgId: ORG, userId: 'alice', meetingId: MEETING }), 'MEETING', 'within the grace period');
    clock.t = 1_000_000 + PARTICIPANTS_GRACE_MS;
    assert.equal(await ev.verify({ orgId: ORG, userId: 'alice', meetingId: MEETING }), null, 'fails closed');
  });
});

describe('ADR 049: AttendanceService only credits verified calls', () => {
  class FixedClock implements Clock {
    constructor(public t: Date) {}
    now(): Date { return new Date(this.t.getTime()); }
  }

  async function run(verdict: 'ROOM' | null) {
    const clock = new FixedClock(new Date('2026-10-13T09:00:00.000Z'));
    const service = new AttendanceService({}, clock);
    service.setCallEvidence({ verify: async () => verdict });
    const secret = service.generateSessionSecret();
    await service.registerSessionSecret('s-1', secret);
    await service.recordMonitoringConsent({ orgId: ORG, userId: 'alice', noticeVersion: 'v1.0.0' });
    let seq = 0;
    const send = async (over: Partial<HeartbeatPayload>) => {
      seq += 1;
      const unsigned: Omit<HeartbeatPayload, 'signature'> = { orgId: ORG, userId: 'alice', deviceId: 'd1', sessionId: 's-1', sequenceNumber: seq, nonce: `n-${seq}`,
        activeSeconds: 30, idleSeconds: 0, tabVisible: true, windowFocused: true, inCall: false, ...over };
      return service.ingestHeartbeat({ ...unsigned, signature: service.getValidator().signHeartbeat(unsigned, secret) });
    };
    await send({});
    clock.t = new Date(clock.t.getTime() + 30_000);
    // A forged callKind in the body is ignored: the server decides it.
    return send({ inCall: true, activeSeconds: 0, idleSeconds: 30, callKind: 'MEETING' });
  }

  it('a verified call opens an IN_MEETING segment with the verified kind', async () => {
    const r = await run('ROOM');
    assert.equal(r.currentState, AttendanceState.IN_MEETING);
    assert.equal(r.session.segments.at(-1)?.callKind, 'ROOM');
  });

  it('an unverified call (alone in a room) is ordinary, input-based time', async () => {
    const r = await run(null);
    assert.equal(r.currentState, AttendanceState.ACTIVE);
    assert.equal(r.session.meetingSeconds, 0);
    assert.ok(!r.session.segments.some((s) => s.state === AttendanceState.IN_MEETING));
  });
});
