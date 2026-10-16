/**
 * Desktop agent core (FR-ATT-011, FR-ATT-012; ADR 018), written before the implementation:
 * activity per 30-second interval from OS idle time, and the offline buffer that measures time
 * only as monotonic offsets from a server-signed anchor.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { measureInterval, OfflineBuffer } from '../src/tracker.ts';

const anchor = (t: number) => ({ serverTimeMs: t, signature: 'a'.repeat(64) });

describe('measureInterval (OS idle time)', () => {
  it('input within the last 30 s counts as activity; the rest is idle', () => {
    assert.deepEqual(measureInterval(0, false), { activeSeconds: 30, idleSeconds: 0 });
    assert.deepEqual(measureInterval(12, false), { activeSeconds: 18, idleSeconds: 12 });
    assert.deepEqual(measureInterval(400, false), { activeSeconds: 0, idleSeconds: 30 });
  });
  it('a locked screen is idle whatever the idle counter says', () => {
    assert.deepEqual(measureInterval(0, true), { activeSeconds: 0, idleSeconds: 30 });
  });
  it('never reports more than the interval or negative values', () => {
    assert.deepEqual(measureInterval(-5, false), { activeSeconds: 30, idleSeconds: 0 });
    assert.deepEqual(measureInterval(Number.NaN, false), { activeSeconds: 0, idleSeconds: 30 });
  });
});

describe('OfflineBuffer', () => {
  it('without an anchor nothing can be recorded', () => {
    const b = new OfflineBuffer();
    assert.equal(b.record(60_000, { activeSeconds: 30, idleSeconds: 0 }), 'NO_ANCHOR');
    assert.equal(b.size, 0);
  });

  it('records intervals as offsets of their start from the anchor on the monotonic clock', () => {
    const b = new OfflineBuffer();
    b.setAnchor(anchor(1_000_000), 10_000);
    assert.equal(b.record(70_000, { activeSeconds: 30, idleSeconds: 0 }), 'BUFFERED'); // covers 40..70 s
    assert.equal(b.record(100_000, { activeSeconds: 10, idleSeconds: 20 }), 'BUFFERED');
    const [batch] = b.pending();
    assert.equal(batch!.anchor.serverTimeMs, 1_000_000);
    assert.deepEqual(batch!.intervals.map((i) => i.offsetMs), [30_000, 60_000]);
    assert.match(batch!.batchId, /^[0-9a-f-]{36}$/);
  });

  it('an interval that starts before the anchor or overlaps the previous one is moved after it', () => {
    const b = new OfflineBuffer();
    b.setAnchor(anchor(1), 50_000);
    b.record(60_000, { activeSeconds: 30, idleSeconds: 0 }); // would start at -20 s
    b.record(70_000, { activeSeconds: 30, idleSeconds: 0 }); // only 10 s later
    assert.deepEqual(b.pending()[0]!.intervals.map((i) => i.offsetMs), [0, 30_000]);
  });

  it('a new anchor starts a new batch; the batch id stays stable for retries', () => {
    const b = new OfflineBuffer();
    b.setAnchor(anchor(1), 0);
    b.record(30_000, { activeSeconds: 30, idleSeconds: 0 });
    const id = b.pending()[0]!.batchId;
    b.setAnchor(anchor(2), 100_000);
    b.record(130_000, { activeSeconds: 30, idleSeconds: 0 });
    const p = b.pending();
    assert.equal(p.length, 2);
    assert.equal(p[0]!.batchId, id);
    b.acknowledge(id);
    assert.equal(b.pending().length, 1);
    assert.equal(b.size, 1);
  });

  it('stops after 12 hours of intervals per anchor', () => {
    const b = new OfflineBuffer();
    b.setAnchor(anchor(1), 0);
    for (let i = 1; i <= 1440; i += 1) assert.equal(b.record(i * 30_000, { activeSeconds: 30, idleSeconds: 0 }), 'BUFFERED');
    assert.equal(b.record(1441 * 30_000, { activeSeconds: 30, idleSeconds: 0 }), 'FULL');
  });

  it('after a restart buffered batches survive, but the old anchor cannot be extended', () => {
    const b = new OfflineBuffer();
    b.setAnchor(anchor(1), 0);
    b.record(30_000, { activeSeconds: 30, idleSeconds: 0 });
    const restored = OfflineBuffer.fromJSON(JSON.parse(JSON.stringify(b.toJSON())));
    assert.equal(restored.size, 1);
    assert.equal(restored.record(60_000, { activeSeconds: 30, idleSeconds: 0 }), 'NO_ANCHOR');
    assert.equal(restored.pending()[0]!.batchId, b.pending()[0]!.batchId);
  });

  it('ignores corrupt or foreign saved data', () => {
    assert.equal(OfflineBuffer.fromJSON({ batches: [{ nope: 1 }] }).size, 0);
    assert.equal(OfflineBuffer.fromJSON('garbage').size, 0);
  });
});
