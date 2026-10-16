/**
 * FR-NOTIF-002 / 004 rules: quiet hours in the user's timezone, channel resolution and the
 * unsubscribe token. Pure.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isValidTimezone, quietUntil, resolveChannels, signUnsubscribeToken, verifyUnsubscribeToken } from '../src/notifications/notification-rules.ts';

const COLOMBO = 'Asia/Colombo'; // UTC+5:30, no DST
const at = (iso: string) => new Date(iso);

describe('Quiet hours (FR-NOTIF-004)', () => {
  it('a same-day window: inside returns its end in the user zone, outside returns null', () => {
    const quiet = { start: '12:00', end: '14:00' };
    // 13:00 Colombo = 07:30Z
    assert.equal(quietUntil(at('2026-10-16T07:30:00Z'), COLOMBO, quiet)?.toISOString(), '2026-10-16T08:30:00.000Z');
    assert.equal(quietUntil(at('2026-10-16T08:30:00Z'), COLOMBO, quiet), null, 'the end minute is outside');
    assert.equal(quietUntil(at('2026-10-16T06:29:00Z'), COLOMBO, quiet), null);
  });

  it('a window across midnight (22:00–07:00) ends tomorrow before midnight and today after it', () => {
    const quiet = { start: '22:00', end: '07:00' };
    // 23:00 Colombo on the 16th = 17:30Z; ends 07:00 Colombo on the 17th = 01:30Z
    assert.equal(quietUntil(at('2026-10-16T17:30:00Z'), COLOMBO, quiet)?.toISOString(), '2026-10-17T01:30:00.000Z');
    // 02:00 Colombo on the 17th = 20:30Z on the 16th; still ends 01:30Z on the 17th
    assert.equal(quietUntil(at('2026-10-16T20:30:00Z'), COLOMBO, quiet)?.toISOString(), '2026-10-17T01:30:00.000Z');
    // 12:00 Colombo: outside
    assert.equal(quietUntil(at('2026-10-16T06:30:00Z'), COLOMBO, quiet), null);
  });

  it('the same instant is quiet in one zone and not in another', () => {
    const quiet = { start: '22:00', end: '07:00' };
    const t = at('2026-10-16T17:30:00Z'); // 23:00 Colombo, 17:30 London
    assert.ok(quietUntil(t, COLOMBO, quiet));
    assert.equal(quietUntil(t, 'Europe/London', quiet), null);
    assert.equal(quietUntil(t, COLOMBO, null), null);
  });

  it('validates IANA zones', () => {
    assert.equal(isValidTimezone('Europe/Berlin'), true);
    assert.equal(isValidTimezone('UTC'), true);
    assert.equal(isValidTimezone('Mars/Olympus'), false);
  });
});

describe('Channel resolution', () => {
  const quiet = { start: '00:00', end: '23:59' };
  it('preferences only switch channels off; quiet hours defer the email', () => {
    const r = resolveChannels('TASK_ASSIGNED', true, undefined, at('2026-10-16T07:30:00Z'), COLOMBO, null);
    assert.deepEqual(r, { inApp: true, email: true, emailAfter: null });
    const off = resolveChannels('TASK_ASSIGNED', true, { inApp: false, email: false }, at('2026-10-16T07:30:00Z'), COLOMBO, null);
    assert.deepEqual(off, { inApp: false, email: false, emailAfter: null });
    const notRequested = resolveChannels('TASK_STATUS', false, { inApp: true, email: true }, at('2026-10-16T07:30:00Z'), COLOMBO, null);
    assert.equal(notRequested.email, false, 'a preference cannot add email the feature did not ask for');
    const deferred = resolveChannels('TASK_ASSIGNED', true, undefined, at('2026-10-16T07:30:00Z'), COLOMBO, quiet);
    assert.ok(deferred.emailAfter && deferred.emailAfter.getTime() > Date.parse('2026-10-16T07:30:00Z'));
  });

  it('critical types ignore preferences and quiet hours', () => {
    const r = resolveChannels('DOCUMENT_INFECTED', true, { inApp: false, email: false }, at('2026-10-16T07:30:00Z'), COLOMBO, quiet);
    assert.deepEqual(r, { inApp: true, email: true, emailAfter: null });
  });
});

describe('Unsubscribe token (FR-NOTIF-002)', () => {
  const secret = 'a'.repeat(40);
  it('round-trips and rejects tampering, another secret and junk', () => {
    const t = signUnsubscribeToken(secret, 'org-1', 'user-1', 'TASK_ASSIGNED');
    assert.deepEqual(verifyUnsubscribeToken(secret, t), { orgId: 'org-1', userId: 'user-1', type: 'TASK_ASSIGNED' });
    const [v, payload, mac] = t.split('.');
    const otherPayload = Buffer.from('org-1.user-2.TASK_ASSIGNED').toString('base64url');
    assert.equal(verifyUnsubscribeToken(secret, `${v}.${otherPayload}.${mac}`), null, 'payload swapped');
    assert.equal(verifyUnsubscribeToken(secret, `${v}.${payload}.${mac!.slice(0, -2)}xx`), null, 'mac changed');
    assert.equal(verifyUnsubscribeToken('b'.repeat(40), t), null, 'other secret');
    assert.equal(verifyUnsubscribeToken(secret, 'not.a.token.at.all'), null);
    assert.equal(verifyUnsubscribeToken(secret, ''), null);
  });
});
