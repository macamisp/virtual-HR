/** Pure meeting rules (ADR 016): RFC 5545 output, recurrence, LiveKit tokens and webhook signatures. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { buildIcs, escapeText, fold, nextOccurrence, rruleOf } from '../src/meetings/ics.ts';
import { accessToken, orgOfRoomName, roomNames, signWebhook, verifyWebhook } from '../src/media/livekit.ts';
import type { LiveKitConfig } from '../src/media/livekit.ts';

const cfg: LiveKitConfig = { url: 'ws://lk', httpUrl: 'http://lk', apiKey: 'k1', apiSecret: 's'.repeat(40) };

describe('.ics invites (FR-MEET-003)', () => {
  it('escapes text, folds at 75 octets without splitting UTF-8, and lists attendees', () => {
    assert.equal(escapeText('a,b;c\\d\nline'), 'a\\,b\\;c\\\\d\\nline');
    const long = `DESCRIPTION:${'é'.repeat(60)}`;
    const folded = fold(long);
    assert.ok(folded.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
    assert.equal(folded.replace(/\r\n /g, ''), long, 'unfolds to the original');
    const ics = buildIcs({
      uid: 'm1@hrvo', sequence: 2, method: 'REQUEST', title: 'Plan, Q4', description: 'Agenda', start: new Date('2026-11-02T09:00:00Z'), end: new Date('2026-11-02T10:00:00Z'),
      organizer: { name: 'Hana "H" Host', email: 'h@x.test' }, attendees: [{ name: 'Ben', email: 'b@x.test' }], url: 'https://app/meetings/m1', rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=4',
      now: new Date('2026-10-16T00:00:00Z'),
    });
    const lines = ics.replace(/\r\n /g, '').split('\r\n');
    for (const l of ['METHOD:REQUEST', 'UID:m1@hrvo', 'SEQUENCE:2', 'DTSTART:20261102T090000Z', 'DTEND:20261102T100000Z', 'SUMMARY:Plan\\, Q4', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4', 'STATUS:CONFIRMED', 'DTSTAMP:20261016T000000Z']) {
      assert.ok(lines.includes(l), l);
    }
    assert.ok(lines.includes('ORGANIZER;CN="Hana H Host":mailto:h@x.test'), 'quotes stripped from parameters');
    assert.ok(lines.some((l) => l.startsWith('ATTENDEE;') && l.endsWith('mailto:b@x.test')));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  });

  it('recurrence: the RRULE subset and the next occurrence', () => {
    assert.equal(rruleOf({ freq: 'DAILY', interval: 2, count: 5 }), 'FREQ=DAILY;INTERVAL=2;COUNT=5');
    assert.equal(rruleOf({ freq: 'WEEKLY', byDay: ['MO', 'WE'], until: '2026-12-31' }), 'FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T235959Z');
    assert.equal(rruleOf(null), null);
    const s = new Date('2026-11-02T09:00:00Z'); // a Monday
    const e = new Date('2026-11-02T10:00:00Z');
    assert.equal(nextOccurrence(s, e, 'FREQ=WEEKLY;BYDAY=MO,WE', new Date('2026-11-03T00:00:00Z'))?.start.toISOString(), '2026-11-04T09:00:00.000Z');
    assert.equal(nextOccurrence(s, e, 'FREQ=DAILY;COUNT=3', new Date('2026-11-10T00:00:00Z')), null, 'after the last of three');
    assert.equal(nextOccurrence(s, e, 'FREQ=MONTHLY', new Date('2026-11-05T00:00:00Z'))?.start.toISOString(), '2026-12-02T09:00:00.000Z');
    assert.equal(nextOccurrence(s, e, null, new Date('2026-11-02T09:30:00Z'))?.start.toISOString(), s.toISOString(), 'still running');
  });
});

describe('LiveKit tokens and webhooks (ADR 016)', () => {
  it('a token names one room, the user as identity, and expires', () => {
    const { token, expiresAt } = accessToken(cfg, 'user-1', 'Anna', { room: 'meet-x', roomJoin: true, canPublish: true });
    const c = jwt.verify(token, cfg.apiSecret, { issuer: 'k1' }) as { video: { room: string }; sub: string; exp: number };
    assert.equal(c.video.room, 'meet-x');
    assert.equal(c.sub, 'user-1');
    assert.ok(Math.abs(c.exp * 1000 - expiresAt.getTime()) < 1000);
    assert.ok(expiresAt.getTime() - Date.now() <= 600_000);
  });

  it('webhook signatures cover the exact body; another secret or body fails', () => {
    const body = JSON.stringify({ event: 'participant_joined', room: { name: 'r' } });
    const auth = signWebhook(cfg, body);
    assert.equal(verifyWebhook(cfg, auth, Buffer.from(body)), true);
    assert.equal(verifyWebhook(cfg, auth, Buffer.from(`${body} `)), false);
    assert.equal(verifyWebhook({ ...cfg, apiSecret: 't'.repeat(40) }, auth, Buffer.from(body)), false);
    assert.equal(verifyWebhook(cfg, undefined, Buffer.from(body)), false);
  });

  it('room names carry the organisation, and only well-formed names are attributed', () => {
    const org = '0f0f0000-0000-4000-8000-000000000001';
    assert.deepEqual(orgOfRoomName(roomNames.meeting(org, 'abc')), { kind: 'meeting', orgId: org });
    assert.deepEqual(orgOfRoomName(roomNames.proximity(org, 'u1;drop')), { kind: 'proximity', orgId: org });
    assert.equal(roomNames.proximity(org, 'u1;drop').endsWith('u1drop'), true, 'sanitised');
    assert.deepEqual(orgOfRoomName(`hrvo-${org}-ground-3`), { kind: 'office', orgId: org });
    assert.equal(orgOfRoomName('meet-not-a-uuid-x'), null);
  });
});
