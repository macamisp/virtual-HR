/**
 * Attendance analytics arithmetic (FR-REP-009, ADR 059), pure: merging intervals (several tabs,
 * reconnects, duplicates), cutting them at organisation-local midnights (Asia/Colombo, and
 * daylight-saving days in Europe/London and America/New_York), open intervals ending at their last
 * observation, grouping into days, weeks and months, the summary, and query validation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { datesBetween, localDayBounds, mergeIntervals, officeIntervalEnd, secondsByLocalDay, totalSeconds } from '../src/reports/presence-days.ts';
import { groupDays, summarise } from '../src/reports/attendance-analytics.service.ts';
import { ensureRange } from '../src/reports/report-scope.ts';
import { AttendanceAnalyticsQuerySchema, PersonAnalyticsQuerySchema } from '../../../packages/shared/src/reports/attendance-analytics.ts';

const t = (s: string) => Date.parse(s);
const H = 3600;

describe('Attendance analytics: intervals', () => {
  it('merges overlapping, touching, nested and duplicate intervals once; drops empty and inverted ones', () => {
    const merged = mergeIntervals([
      { start: t('2026-11-10T09:00:00Z'), end: t('2026-11-10T12:00:00Z') },
      { start: t('2026-11-10T11:00:00Z'), end: t('2026-11-10T13:00:00Z') }, // a second tab
      { start: t('2026-11-10T09:30:00Z'), end: t('2026-11-10T10:00:00Z') }, // nested
      { start: t('2026-11-10T09:00:00Z'), end: t('2026-11-10T12:00:00Z') }, // duplicate (a lost write)
      { start: t('2026-11-10T13:00:00Z'), end: t('2026-11-10T14:00:00Z') }, // touching: one connection
      { start: t('2026-11-10T15:00:00Z'), end: t('2026-11-10T15:00:00Z') }, // empty
      { start: t('2026-11-10T17:00:00Z'), end: t('2026-11-10T16:00:00Z') }, // inverted
    ]);
    assert.deepEqual(merged, [{ start: t('2026-11-10T09:00:00Z'), end: t('2026-11-10T14:00:00Z') }]);
    assert.equal(totalSeconds([{ start: t('2026-11-10T09:00:00Z'), end: t('2026-11-10T12:00:00Z') }, { start: t('2026-11-10T11:00:00Z'), end: t('2026-11-10T13:00:00Z') }]), 4 * H);
    assert.deepEqual(mergeIntervals([]), []);
    assert.equal(totalSeconds([]), 0);
  });

  it('Asia/Colombo (UTC+05:30): a connection over local midnight is split between the two days, nothing lost', () => {
    // 23:00 on the 10th to 01:30 on the 11th, local time.
    const i = { start: t('2026-11-10T17:30:00Z'), end: t('2026-11-10T20:00:00Z') };
    const days = secondsByLocalDay([i], '2026-11-09', '2026-11-12', 'Asia/Colombo');
    assert.deepEqual([...days], [['2026-11-10', 1 * H], ['2026-11-11', 1.5 * H]]);
    assert.equal([...days.values()].reduce((a, b) => a + b, 0), totalSeconds([i]));
    // Only days inside the range are reported.
    assert.deepEqual([...secondsByLocalDay([i], '2026-11-11', '2026-11-11', 'Asia/Colombo')], [['2026-11-11', 1.5 * H]]);
    assert.equal(localDayBounds('2026-11-10', 'Asia/Colombo').start, t('2026-11-09T18:30:00Z'));
  });

  it('daylight saving: the local day is 23 h (spring) or 25 h (autumn) long and a whole-day connection counts exactly that', () => {
    const day = (d: string, tz: string) => { const b = localDayBounds(d, tz); return (b.end - b.start) / 1000; };
    assert.equal(day('2026-03-29', 'Europe/London'), 23 * H);
    assert.equal(day('2026-10-25', 'Europe/London'), 25 * H);
    assert.equal(day('2026-03-08', 'America/New_York'), 23 * H);
    assert.equal(day('2026-11-01', 'America/New_York'), 25 * H);
    // Connected from the 24th 12:00 to the 26th 12:00 London time, across the autumn change.
    const i = { start: t('2026-10-24T11:00:00Z'), end: t('2026-10-26T12:00:00Z') };
    assert.deepEqual([...secondsByLocalDay([i], '2026-10-24', '2026-10-26', 'Europe/London')], [['2026-10-24', 12 * H], ['2026-10-25', 25 * H], ['2026-10-26', 12 * H]]);
    // 01:00 to 03:00 on the spring day: the clock skips 01:00-02:00, so it is one real hour.
    const spring = { start: t('2026-03-29T01:00:00Z'), end: t('2026-03-29T02:00:00Z') };
    assert.deepEqual([...secondsByLocalDay([spring], '2026-03-29', '2026-03-29', 'Europe/London')], [['2026-03-29', 1 * H]]);
  });

  it('an open interval ends at its last observation (never the present moment after a crash); a closed one at its end', () => {
    const now = t('2026-11-10T12:00:00Z');
    assert.equal(officeIntervalEnd({ startedAt: new Date('2026-11-10T09:00:00Z'), endedAt: null, lastSeenAt: new Date('2026-11-10T10:00:00Z') }, now), t('2026-11-10T10:00:00Z'));
    assert.equal(officeIntervalEnd({ startedAt: new Date('2026-11-10T09:00:00Z'), endedAt: new Date('2026-11-10T09:30:00Z'), lastSeenAt: new Date('2026-11-10T09:29:00Z') }, now), t('2026-11-10T09:30:00Z'));
    // A clock skew never makes it end before it started, nor after now.
    assert.equal(officeIntervalEnd({ startedAt: new Date('2026-11-10T09:00:00Z'), endedAt: null, lastSeenAt: new Date('2026-11-10T08:00:00Z') }, now), t('2026-11-10T09:00:00Z'));
    assert.equal(officeIntervalEnd({ startedAt: new Date('2026-11-10T09:00:00Z'), endedAt: null, lastSeenAt: new Date('2026-11-10T13:00:00Z') }, now), now);
  });

  it('date lists and the 366-day range rule', () => {
    assert.deepEqual(datesBetween('2026-02-27', '2026-03-02'), ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    assert.deepEqual(datesBetween('2026-03-02', '2026-03-01'), []);
    assert.doesNotThrow(() => ensureRange('2026-01-01', '2027-01-02', 366));
    assert.throws(() => ensureRange('2026-01-01', '2027-01-03', 366), /At most 366 days/);
    assert.throws(() => ensureRange('2026-01-02', '2026-01-01', 366), /before/);
  });
});

describe('Attendance analytics: grouping and validation', () => {
  const person = { id: 'u1', displayName: 'Ana', email: 'ana@x.test', teamName: 'Ops' };
  const day = (date: string, over: Partial<Parameters<typeof groupDays>[1][number]> = {}) => ({
    userId: 'u1', date, hasAttendance: true, firstIn: new Date(`${date}T03:30:00Z`), lastOut: new Date(`${date}T12:00:00Z`),
    work: 8 * H, active: 7 * H, brk: 1800, meeting: H, office: 9 * H, late: 0, early: 0, status: 'PRESENT' as const, task: 1800, done: 1, ...over,
  });
  const days = [
    day('2026-11-09'), day('2026-11-10', { late: 15, status: 'LATE' }), day('2026-11-11', { lastOut: null, status: 'IN_PROGRESS' }),
    day('2026-11-16', { hasAttendance: false, firstIn: null, lastOut: null, work: 0, active: 0, brk: 0, meeting: 0, office: 0, status: 'LEAVE' }),
    day('2026-12-01', { hasAttendance: false, firstIn: null, lastOut: null, work: 0, active: 0, brk: 0, meeting: 0, office: 2 * H, status: null }),
  ];

  it('day rows keep the day status; weeks and months sum and count statuses; the three measures stay apart', () => {
    const d = groupDays(person, days, 'day');
    assert.equal(d.length, 5);
    assert.equal(d.find((r) => r.period === '2026-11-10')!.status, 'LATE');
    assert.equal(d.find((r) => r.period === '2026-11-11')!.lastOut, null, 'still in');
    assert.equal(d.find((r) => r.period === '2026-12-01')!.status, null, 'office time without attendance has no attendance status');
    const w = groupDays(person, days, 'week');
    const week = w.find((r) => r.period === '2026-11-09')!;
    assert.deepEqual({ daysWorked: week.daysWorked, work: week.workSeconds, meeting: week.meetingSeconds, office: week.officeSeconds, late: week.lateMinutes, status: week.status },
      { daysWorked: 3, work: 24 * H, meeting: 3 * H, office: 27 * H, late: 15, status: null });
    // FR-REP-010: recorded task time and completed tasks are a fourth measure, never added to work.
    assert.deepEqual({ task: week.taskSeconds, done: week.tasksDone, work: week.workSeconds }, { task: 3 * 1800, done: 3, work: 24 * H });
    assert.deepEqual(week.statusCounts, { PRESENT: 1, LATE: 1, IN_PROGRESS: 1 });
    assert.equal(week.firstIn, '2026-11-09T03:30:00.000Z');
    assert.equal(week.lastOut, '2026-11-10T12:00:00.000Z', 'the latest check-out recorded');
    const m = groupDays(person, days, 'month');
    assert.deepEqual(m.map((r) => [r.period, r.daysWorked, r.workSeconds, r.officeSeconds]), [['2026-11', 3, 24 * H, 27 * H], ['2026-12', 0, 0, 2 * H]]);
    const s = summarise(2, days);
    assert.deepEqual({ ...s }, { people: 2, peoplePresent: 1, daysWorked: 3, workSeconds: 24 * H, averageWorkSeconds: 8 * H, meetingSeconds: 3 * H, meetingSharePct: 13, officeSeconds: 29 * H, taskSeconds: 5 * 1800, tasksDone: 5, statusCounts: { PRESENT: 1, LATE: 1, IN_PROGRESS: 1, LEAVE: 1 } });
    assert.deepEqual(summarise(0, []), { people: 0, peoplePresent: 0, daysWorked: 0, workSeconds: 0, averageWorkSeconds: 0, meetingSeconds: 0, meetingSharePct: 0, officeSeconds: 0, taskSeconds: 0, tasksDone: 0, statusCounts: {} });
  });

  it('queries are strict: dates, groups, sorts, page sizes and nothing else', () => {
    const ok = AttendanceAnalyticsQuerySchema.parse({ from: '2026-11-01', to: '2026-11-30' });
    assert.deepEqual(ok, { from: '2026-11-01', to: '2026-11-30', groupBy: 'day', sort: 'date', dir: 'desc', page: 1, pageSize: 50, format: 'json' });
    assert.equal(AttendanceAnalyticsQuerySchema.parse({ from: '2026-11-01', to: '2026-11-30', page: '3', pageSize: '200' }).pageSize, 200);
    for (const bad of [
      { from: '2026-11-1', to: '2026-11-30' }, { from: '2026-11-01', to: '2026-11-30', groupBy: 'team' }, { from: '2026-11-01', to: '2026-11-30', pageSize: '201' },
      { from: '2026-11-01', to: '2026-11-30', page: '0' }, { from: '2026-11-01', to: '2026-11-30', orgId: 'x' }, { from: '2026-11-01', to: '2026-11-30', userId: 'me' },
      { from: '2026-11-01', to: '2026-11-30', format: 'docx' }, { from: '2026-11-01', to: '2026-11-30', sort: 'salary' },
    ]) assert.equal(AttendanceAnalyticsQuerySchema.safeParse(bad).success, false, JSON.stringify(bad));
    assert.equal(PersonAnalyticsQuerySchema.safeParse({ from: '2026-11-01', to: '2026-11-30', userId: 'x' }).success, false);
  });
});
