/**
 * Offline buffering and sync (FR-ATT-012; ADR 018). Written before the implementation.
 *
 * The agent never sends wall-clock times. Each heartbeat acknowledgement carries a server-signed
 * anchor (server time + HMAC). Offline, the agent records intervals as monotonic offsets from that
 * anchor. On sync the server rebuilds every time from its own anchor, accepts only what falls in
 * its own heartbeat gap, caps the window at 12 hours and flags the result OFFLINE_SYNCED.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planOfflineSync, signAnchor, verifyAnchor } from '../src/agent/offline-sync.ts';
import type { AnchorContext, OfflineInterval } from '../src/agent/offline-sync.ts';

const KEY = Buffer.alloc(32, 7);
const ctx: AnchorContext = { orgId: 'org-1', userId: 'user-1', deviceId: 'agent-A' };
const anchorMs = Date.parse('2026-10-13T04:00:00.000Z'); // 09:30 in Asia/Colombo
const nowMs = anchorMs + 3 * 3600_000; // syncing three hours later
const ivs = (n: number, startOffsetS = 30, o: Partial<OfflineInterval> = {}): OfflineInterval[] =>
  Array.from({ length: n }, (_, i) => ({ offsetMs: (startOffsetS + i * 30) * 1000, activeSeconds: 30, idleSeconds: 0, ...o }));
const plan = (intervals: OfflineInterval[], over: Partial<Parameters<typeof planOfflineSync>[0]> = {}) =>
  planOfflineSync({ anchorServerMs: anchorMs, intervals, nowMs, covered: [], maxWindowSeconds: 12 * 3600, timeZone: 'Asia/Colombo', ...over });

describe('Anchor signatures', () => {
  it('a signed anchor verifies for the same user and device', () => {
    const sig = signAnchor(KEY, ctx, anchorMs);
    assert.equal(verifyAnchor(KEY, ctx, anchorMs, sig), true);
  });
  it('a changed time, device, user or key is rejected', () => {
    const sig = signAnchor(KEY, ctx, anchorMs);
    assert.equal(verifyAnchor(KEY, ctx, anchorMs - 3600_000, sig), false);
    assert.equal(verifyAnchor(KEY, { ...ctx, deviceId: 'agent-B' }, anchorMs, sig), false);
    assert.equal(verifyAnchor(KEY, { ...ctx, userId: 'user-2' }, anchorMs, sig), false);
    assert.equal(verifyAnchor(Buffer.alloc(32, 8), ctx, anchorMs, sig), false);
    assert.equal(verifyAnchor(KEY, ctx, anchorMs, 'not-hex'), false);
  });
});

describe('planOfflineSync', () => {
  it('rebuilds times from the server anchor plus monotonic offsets', () => {
    const p = plan(ivs(4));
    assert.equal(p.accepted, 4);
    assert.equal(p.sessions.length, 1);
    const s = p.sessions[0]!;
    assert.equal(s.start.toISOString(), new Date(anchorMs + 30_000).toISOString());
    assert.equal(s.end.toISOString(), new Date(anchorMs + 150_000).toISOString());
    assert.equal(s.activeSeconds, 120);
    assert.equal(s.workDate, '2026-10-13');
  });

  it('drops intervals the server already covered with heartbeats (fills gaps only)', () => {
    const covered = [{ start: new Date(anchorMs + 60_000), end: new Date(anchorMs + 120_000) }];
    const p = plan(ivs(4), { covered });
    assert.equal(p.accepted, 2);
    assert.equal(p.rejected.OVERLAP, 2);
  });

  it('rejects intervals that end after the server time of the sync (future)', () => {
    const p = plan(ivs(2), { nowMs: anchorMs + 60_000 });
    assert.equal(p.accepted, 1);
    assert.equal(p.rejected.FUTURE, 1);
  });

  it('rejects intervals more than 12 hours after the anchor, and stale anchors entirely', () => {
    const p = plan([...ivs(1), { offsetMs: 13 * 3600_000, activeSeconds: 30, idleSeconds: 0 }], { nowMs: anchorMs + 14 * 3600_000 });
    assert.equal(p.accepted, 1);
    assert.equal(p.rejected.TOO_OLD, 1);
    const stale = plan(ivs(1), { nowMs: anchorMs + 40 * 3600_000 });
    assert.equal(stale.accepted, 0);
    assert.equal(stale.rejected.STALE_ANCHOR, 1);
  });

  it('rejects malformed intervals: out of order, overlapping, or more than 30 s of counters', () => {
    const p = plan([
      { offsetMs: 60_000, activeSeconds: 30, idleSeconds: 0 },
      { offsetMs: 40_000, activeSeconds: 30, idleSeconds: 0 }, // goes back in time
      { offsetMs: 90_000, activeSeconds: 20, idleSeconds: 20 }, // 40 s in a 30 s interval
      { offsetMs: 120_000, activeSeconds: 30, idleSeconds: 0 },
    ]);
    assert.equal(p.accepted, 2);
    assert.equal(p.rejected.INVALID, 2);
  });

  it('builds ACTIVE and IDLE segments and leaves idle out of active time', () => {
    const p = plan([...ivs(2), ...ivs(2, 90, { activeSeconds: 0, idleSeconds: 30 }), ...ivs(1, 150)]);
    const s = p.sessions[0]!;
    assert.deepEqual(s.segments.map((g) => g.state), ['ACTIVE', 'IDLE', 'ACTIVE']);
    assert.equal(s.activeSeconds, 90);
    assert.equal(s.idleSeconds, 60);
  });

  it('a gap of more than 90 s between intervals starts a new session', () => {
    const p = plan([...ivs(2), ...ivs(2, 600)]);
    assert.equal(p.sessions.length, 2);
  });

  it('splits at midnight in the organisation time zone (FR-ATT-008)', () => {
    const lateAnchor = Date.parse('2026-10-13T18:25:00.000Z'); // 23:55 in Colombo
    const p = plan(ivs(20, 30), { anchorServerMs: lateAnchor, nowMs: lateAnchor + 3600_000 });
    assert.deepEqual(p.sessions.map((s) => s.workDate), ['2026-10-13', '2026-10-14']);
    assert.equal(p.sessions.reduce((a, s) => a + s.activeSeconds, 0), 600);
  });

  it('accepts at most 12 hours of intervals in one batch', () => {
    const p = plan(ivs(1441), { nowMs: anchorMs + 13 * 3600_000 });
    assert.ok(p.accepted <= 1440);
  });
});
