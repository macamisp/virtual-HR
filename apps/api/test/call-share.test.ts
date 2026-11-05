/** ADR 049 §1d (FR-WT-003): the heartbeat leader reports a call owned by another tab of the browser. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveCall, CALL_SHARE_STALE_MS } from '../../../packages/shared/src/attendance/call-share.ts';

describe('ADR 049: call state shared between tabs', () => {
  const now = 10_000_000;
  it('the leader\'s own call wins', () => {
    assert.deepEqual(effectiveCall({ inCall: true, meetingId: 'm1' }, [{ inCall: true, meetingId: 'm2', at: now }], now), { inCall: true, meetingId: 'm1' });
  });
  it('another tab\'s fresh call is reported with its meeting', () => {
    assert.deepEqual(effectiveCall({ inCall: false, meetingId: null }, [{ inCall: false, meetingId: null, at: now }, { inCall: true, meetingId: 'm2', at: now - 1000 }], now), { inCall: true, meetingId: 'm2' });
  });
  it('a tab that stopped broadcasting (closed, frozen) no longer counts', () => {
    assert.deepEqual(effectiveCall({ inCall: false, meetingId: null }, [{ inCall: true, meetingId: null, at: now - CALL_SHARE_STALE_MS - 1 }], now), { inCall: false, meetingId: null });
  });
  it('two tabs never add up: one call is reported once', () => {
    const r = effectiveCall({ inCall: false, meetingId: null }, [{ inCall: true, meetingId: null, at: now - 10 }, { inCall: true, meetingId: 'm3', at: now - 5 }], now);
    assert.deepEqual(r, { inCall: true, meetingId: 'm3' });
  });
});
