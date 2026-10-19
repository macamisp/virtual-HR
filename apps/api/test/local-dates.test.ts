/**
 * Business dates are the organisation's local calendar dates, never the UTC date: late in the UTC
 * evening it is already tomorrow in Colombo (UTC+5:30). Reports ("overdue", "expired") and the
 * once-a-week alerts depend on it; CI runs in UTC, so a UTC date made them fail for hours a day.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { orgToday } from '../src/reports/report-scope.ts';

const db = (timezone: string | null) => ({ query: async () => ({ rows: (timezone ? [{ timezone }] : []) as never[] }) });

describe('Organisation-local dates for reports', () => {
  it('Sunday 23:10 UTC is Monday in Colombo', async () => {
    const lateSunday = new Date('2026-10-18T23:10:00Z');
    assert.equal(await orgToday(db('Asia/Colombo'), 'org', lateSunday), '2026-10-19');
    assert.equal(await orgToday(db('UTC'), 'org', lateSunday), '2026-10-18');
    assert.equal(await orgToday(db('America/New_York'), 'org', new Date('2026-10-19T02:00:00Z')), '2026-10-18');
  });
  it('an organisation without a timezone falls back to UTC', async () => {
    assert.equal(await orgToday(db(null), 'org', new Date('2026-10-18T23:10:00Z')), '2026-10-18');
  });
});
