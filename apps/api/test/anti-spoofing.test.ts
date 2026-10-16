/**
 * Anti-spoofing heuristics and network policy (FR-ATT-017, FR-ATT-018; ADR 019). Written before the
 * implementation. Every check only produces a reason for human review; nothing here changes time.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  countryKm, impossibleTravel, ipAllowed, ipInCidr, mechanicalPatterns, networkViolations, parseCidr,
} from '../src/attendance/anti-spoofing.ts';
import type { IntervalSample } from '../src/attendance/anti-spoofing.ts';

describe('CIDR matching', () => {
  it('IPv4 ranges, single hosts and the IPv4-mapped IPv6 form', () => {
    assert.equal(ipInCidr('10.1.2.3', '10.0.0.0/8'), true);
    assert.equal(ipInCidr('11.1.2.3', '10.0.0.0/8'), false);
    assert.equal(ipInCidr('192.168.1.10', '192.168.1.10/32'), true);
    assert.equal(ipInCidr('192.168.1.11', '192.168.1.10'), false);
    assert.equal(ipInCidr('::ffff:10.1.2.3', '10.0.0.0/8'), true, 'Node reports IPv4 clients this way');
    assert.equal(ipInCidr('0.0.0.0', '0.0.0.0/0'), true);
  });
  it('IPv6 ranges, including compressed forms', () => {
    assert.equal(ipInCidr('2001:db8::1', '2001:db8::/32'), true);
    assert.equal(ipInCidr('2001:db9::1', '2001:db8::/32'), false);
    assert.equal(ipInCidr('2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1/128'), true);
    assert.equal(ipInCidr('10.0.0.1', '2001:db8::/32'), false, 'families never match');
  });
  it('rejects malformed input instead of matching it', () => {
    assert.equal(parseCidr('10.0.0.0/33'), null);
    assert.equal(parseCidr('300.1.1.1/8'), null);
    assert.equal(parseCidr('abc'), null);
    assert.equal(ipInCidr('not-an-ip', '10.0.0.0/8'), false);
  });
  it('an empty allow-list allows everything', () => {
    assert.equal(ipAllowed('8.8.8.8', []), true);
    assert.equal(ipAllowed('8.8.8.8', ['10.0.0.0/8', '8.8.8.0/24']), true);
    assert.equal(ipAllowed('9.9.9.9', ['10.0.0.0/8']), false);
  });
});

describe('network policy (FR-ATT-018)', () => {
  const policy = { allowedCidrs: ['203.0.113.0/24'], allowedCountries: ['LK', 'SG'] };
  it('no violation inside both lists', () => {
    assert.deepEqual(networkViolations({ ip: '203.0.113.9', country: 'LK' }, policy), []);
  });
  it('flags an IP outside the ranges and a country outside the list', () => {
    assert.deepEqual(networkViolations({ ip: '198.51.100.1', country: 'US' }, policy).sort(), ['COUNTRY_NOT_ALLOWED', 'IP_NOT_ALLOWED']);
  });
  it('an unknown country is not a violation of the country list (no evidence), but Tor is flagged', () => {
    assert.deepEqual(networkViolations({ ip: '203.0.113.9', country: null }, policy), []);
    assert.deepEqual(networkViolations({ ip: '203.0.113.9', country: 'T1' }, { allowedCidrs: [], allowedCountries: [] }), ['ANONYMIZER']);
  });
  it('empty lists mean the policy is off', () => {
    assert.deepEqual(networkViolations({ ip: '198.51.100.1', country: 'US' }, { allowedCidrs: [], allowedCountries: [] }), []);
  });
});

describe('impossible travel (country level)', () => {
  const t = (h: number) => new Date(Date.UTC(2026, 9, 13, 0, 0) + h * 3600_000);
  it('distances between country reference points are plausible', () => {
    const km = countryKm('LK', 'SG')!;
    assert.ok(km > 2500 && km < 3100, `LK-SG ${km}`);
    assert.equal(countryKm('LK', 'LK'), 0);
    assert.equal(countryKm('LK', 'ZZ'), null);
  });
  it('Colombo then London one hour later is impossible; ten hours later is possible', () => {
    assert.ok(impossibleTravel({ country: 'LK', at: t(0) }, { country: 'GB', at: t(1) }));
    assert.equal(impossibleTravel({ country: 'LK', at: t(0) }, { country: 'GB', at: t(10) }), null);
  });
  it('neighbours, the same country and unknown countries never flag', () => {
    assert.equal(impossibleTravel({ country: 'SG', at: t(0) }, { country: 'MY', at: t(0.01) }), null, 'under 500 km apart is noise (VPN exits, roaming)');
    // Large neighbours: the distance allows for both countries' size, so a short hop is not "travel".
    assert.equal(impossibleTravel({ country: 'LK', at: t(0) }, { country: 'IN', at: t(1) }), null);
    assert.equal(impossibleTravel({ country: 'LK', at: t(0) }, { country: 'LK', at: t(0) }), null);
    assert.equal(impossibleTravel({ country: null, at: t(0) }, { country: 'GB', at: t(0) }), null);
  });
  it('reports the distance and the implied speed for the reviewer', () => {
    const r = impossibleTravel({ country: 'LK', at: t(0) }, { country: 'GB', at: t(2) })!;
    assert.ok(r.km > 8000 && r.km < 9500);
    assert.ok(r.kmh > 4000);
  });
});

describe('mechanical input patterns', () => {
  const full = (n: number): IntervalSample[] => Array.from({ length: n }, () => ({ activeSeconds: 30, idleSeconds: 0, tabVisible: true, windowFocused: true, source: 'WEB' as const }));
  const human = (n: number): IntervalSample[] => Array.from({ length: n }, (_, i) => ({ activeSeconds: [30, 22, 30, 5, 0, 30, 17, 30, 0, 26][i % 10]!, idleSeconds: 0, tabVisible: true, windowFocused: true, source: 'WEB' as const })).map((s) => ({ ...s, idleSeconds: 30 - s.activeSeconds }));

  it('normal varied activity raises nothing', () => {
    assert.deepEqual(mechanicalPatterns(human(600)), []);
  });
  it('three hours of input in every single second is flagged (UNBROKEN_FULL_ACTIVITY)', () => {
    assert.deepEqual(mechanicalPatterns(full(360)), ['UNBROKEN_FULL_ACTIVITY']);
    assert.deepEqual(mechanicalPatterns(full(359)), []);
  });
  it('identical short bursts at a perfectly regular interval are flagged (PERIODIC_ACTIVITY)', () => {
    // A mouse jiggler: 2 s of input every 4 minutes, otherwise idle, for 2 hours.
    const s: IntervalSample[] = Array.from({ length: 240 }, (_, i) => (i % 8 === 0
      ? { activeSeconds: 2, idleSeconds: 28, tabVisible: true, windowFocused: true, source: 'AGENT' as const }
      : { activeSeconds: 0, idleSeconds: 30, tabVisible: true, windowFocused: true, source: 'AGENT' as const }));
    assert.deepEqual(mechanicalPatterns(s), ['PERIODIC_ACTIVITY']);
  });
  it('a browser cannot see input while neither focused nor visible (ACTIVITY_WITHOUT_FOCUS); the agent can', () => {
    const blind = Array.from({ length: 20 }, () => ({ activeSeconds: 30, idleSeconds: 0, tabVisible: false, windowFocused: false, source: 'WEB' as const }));
    assert.deepEqual(mechanicalPatterns(blind), ['ACTIVITY_WITHOUT_FOCUS']);
    assert.deepEqual(mechanicalPatterns(blind.map((b) => ({ ...b, source: 'AGENT' as const }))), []);
  });
});
