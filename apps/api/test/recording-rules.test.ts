/**
 * Meeting recording rules (FR-MEET-007, ADR 024), written before the implementation: recording
 * starts only when every required participant has said yes, one "no" stops it, a consent window
 * expires, and only people who were recorded (or host / co-hosts) may watch.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canWatchRecording, consentOutcome, CONSENT_WINDOW_SECONDS, recordingExpiry } from '../src/meetings/recording-rules.ts';

const A = 'a';
const B = 'b';
const C = 'c';
const at = (s: string) => new Date(`2026-10-17T${s}Z`);

describe('consentOutcome', () => {
  const deadline = at('10:02:00');
  it('waits while someone has not answered', () => {
    assert.equal(consentOutcome([A, B], [{ userId: A, granted: true }], deadline, at('10:01:00')), 'PENDING');
  });
  it('starts when every required person said yes', () => {
    assert.equal(consentOutcome([A, B], [{ userId: B, granted: true }, { userId: A, granted: true }], deadline, at('10:01:00')), 'START');
  });
  it('one refusal cancels, even if others agreed', () => {
    assert.equal(consentOutcome([A, B, C], [{ userId: A, granted: true }, { userId: C, granted: false }], deadline, at('10:01:00')), 'REFUSED');
  });
  it('the latest answer of a person counts', () => {
    assert.equal(consentOutcome([A], [{ userId: A, granted: false }, { userId: A, granted: true }], deadline, at('10:01:00')), 'START');
    assert.equal(consentOutcome([A], [{ userId: A, granted: true }, { userId: A, granted: false }], deadline, at('10:01:00')), 'REFUSED');
  });
  it('answers from people who are not required do not count', () => {
    assert.equal(consentOutcome([A], [{ userId: B, granted: true }], deadline, at('10:01:00')), 'PENDING');
    assert.equal(consentOutcome([A], [{ userId: A, granted: true }, { userId: B, granted: false }], deadline, at('10:01:00')), 'START');
  });
  it('expires at the deadline when someone is still silent', () => {
    assert.equal(consentOutcome([A, B], [{ userId: A, granted: true }], deadline, deadline), 'EXPIRED');
    assert.equal(consentOutcome([A, B], [{ userId: A, granted: true }, { userId: B, granted: true }], deadline, at('10:05:00')), 'START', 'complete answers still start');
  });
  it('nobody required is never a reason to record', () => {
    assert.equal(consentOutcome([], [], deadline, at('10:01:00')), 'PENDING');
  });
  it('the consent window is two minutes', () => {
    assert.equal(CONSENT_WINDOW_SECONDS, 120);
  });
});

describe('canWatchRecording', () => {
  it('host and co-hosts may watch', () => {
    assert.equal(canWatchRecording({ role: 'HOST', consented: false }), true);
    assert.equal(canWatchRecording({ role: 'COHOST', consented: false }), true);
  });
  it('a participant who was recorded may watch; an invitee who was not there may not', () => {
    assert.equal(canWatchRecording({ role: 'ATTENDEE', consented: true }), true);
    assert.equal(canWatchRecording({ role: 'ATTENDEE', consented: false }), false);
    assert.equal(canWatchRecording({ role: 'NONE', consented: false }), false);
  });
});

describe('recordingExpiry', () => {
  it('counts the retention days from when the recording ended', () => {
    assert.equal(recordingExpiry(at('10:00:00'), 90).toISOString(), '2027-01-15T10:00:00.000Z');
  });
  it('refuses nonsense retention', () => {
    assert.throws(() => recordingExpiry(at('10:00:00'), 0));
  });
});
