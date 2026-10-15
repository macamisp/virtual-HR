/**
 * Timesheet rules, written before the implementation (AGENTS.md: money is crypto-grade
 * sensitive, so tests first):
 *  - decimal-safe money (no floats anywhere) and the FR-TS-009 payable amount;
 *  - FR-TS-002 timesheet periods (weekly / bi-weekly / monthly);
 *  - FR-TS-005 reconciliation variance;
 *  - FR-TS-006/011 who may see, approve and reopen.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computePayable, formatMoney, parseMoney, parseMultiplier } from '../src/timesheets/money.ts';
import type { PayableEntry } from '../src/timesheets/money.ts';
import { periodFor } from '../src/timesheets/periods.ts';
import { reconcileDay } from '../src/timesheets/reconcile.ts';
import { timesheetPermissions } from '../src/timesheets/timesheet-policy.ts';

let seq = 0;
function e(workDate: string, minutes: number, projectId: string | null = null, startedAt?: string): PayableEntry {
  seq += 1;
  return { id: `e${String(seq).padStart(4, '0')}`, workDate, minutes, projectId, startedAt: startedAt ? new Date(startedAt) : null };
}

const WEEK = { periodStart: '2026-10-12', periodEnd: '2026-10-18' };
const base = { rateType: 'HOURLY' as const, rate: '25.50', overtimeMultiplier: '1.50', weeklyCapMinutes: 40 * 60, projectRates: new Map<string, string>() };

describe('Money parsing and formatting (no floats)', () => {
  it('parses decimal strings exactly into minor units', () => {
    assert.equal(parseMoney('0'), 0n);
    assert.equal(parseMoney('0.01'), 1n);
    assert.equal(parseMoney('25.5'), 2550n);
    assert.equal(parseMoney('9999999999.99'), 999999999999n);
    assert.equal(parseMultiplier('1.5'), 150n);
    assert.equal(parseMultiplier('1.25'), 125n);
  });

  it('rejects anything that is not a plain non-negative decimal', () => {
    for (const bad of ['', ' 1', '1e3', '-1', '1.234', '1,00', 'NaN', 'Infinity', '0x10', '.5', '10000000000.00']) {
      assert.throws(() => parseMoney(bad), /amount/i, bad);
    }
    assert.throws(() => parseMultiplier('0.99'), /multiplier/i);
    assert.throws(() => parseMultiplier('10.00'), /multiplier/i);
  });

  it('formats minor units with two decimals', () => {
    assert.equal(formatMoney(0n), '0.00');
    assert.equal(formatMoney(5n), '0.05');
    assert.equal(formatMoney(121125n), '1211.25');
  });
});

describe('Payable amount (FR-TS-009)', () => {
  it('HOURLY: hours x rate, exact', () => {
    const entries = [e('2026-10-12', 8 * 60), e('2026-10-13', 8 * 60), e('2026-10-14', 8 * 60), e('2026-10-15', 8 * 60), e('2026-10-16', 8 * 60)];
    const r = computePayable({ ...base, ...WEEK, entries });
    assert.equal(r.amount, '1020.00');
    assert.equal(r.regularMinutes, 2400);
    assert.equal(r.overtimeMinutes, 0);
  });

  it('HOURLY: minutes above the weekly cap are overtime x multiplier', () => {
    const entries = [e('2026-10-12', 9 * 60), e('2026-10-13', 9 * 60), e('2026-10-14', 9 * 60), e('2026-10-15', 9 * 60), e('2026-10-16', 9 * 60)];
    const r = computePayable({ ...base, ...WEEK, entries });
    // 40 h x 25.50 = 1020.00; 5 h x 25.50 x 1.5 = 191.25
    assert.equal(r.amount, '1211.25');
    assert.equal(r.overtimeMinutes, 300);
  });

  it('no float drift: 3 x 20 min at 0.10/h is exactly 0.10', () => {
    const r = computePayable({ ...base, rate: '0.10', ...WEEK, entries: [e('2026-10-12', 20), e('2026-10-12', 20), e('2026-10-12', 20)] });
    assert.equal(r.amount, '0.10');
  });

  it('rounds half up to cents once per line', () => {
    assert.equal(computePayable({ ...base, rate: '0.01', ...WEEK, entries: [e('2026-10-12', 1)] }).amount, '0.00');
    assert.equal(computePayable({ ...base, rate: '0.01', ...WEEK, entries: [e('2026-10-12', 30)] }).amount, '0.01'); // 0.005
    assert.equal(computePayable({ ...base, rate: '10.00', ...WEEK, entries: [e('2026-10-12', 20)] }).amount, '3.33');
    assert.equal(computePayable({ ...base, rate: '10.00', ...WEEK, entries: [e('2026-10-12', 40)] }).amount, '6.67');
  });

  it('project override applies to that project only, and lines add up to the total', () => {
    const projectRates = new Map([['P1', '30.00']]);
    const r = computePayable({ ...base, rate: '20.00', projectRates, ...WEEK, entries: [e('2026-10-12', 600, 'P1'), e('2026-10-13', 1800, 'P2')] });
    assert.equal(r.amount, '900.00'); // 10 h x 30 + 30 h x 20
    const p1 = r.lines.find((l) => l.projectId === 'P1');
    const p2 = r.lines.find((l) => l.projectId === 'P2');
    assert.equal(p1?.amount, '300.00');
    assert.equal(p2?.amount, '600.00');
    assert.equal(p1?.rate, '30.00');
  });

  it('overtime falls on the chronologically last minutes of the week, at that project rate', () => {
    const projectRates = new Map([['P1', '30.00']]);
    const entries = [e('2026-10-12', 40 * 60, 'P2'), e('2026-10-16', 120, 'P1')];
    const r = computePayable({ ...base, rate: '20.00', projectRates, ...WEEK, entries });
    // 40 h x 20 = 800; 2 h x 30 x 1.5 = 90
    assert.equal(r.amount, '890.00');
    assert.equal(r.lines.find((l) => l.projectId === 'P1')?.overtimeMinutes, 120);
  });

  it('within a day, timed entries are ordered by start time to find the overtime minutes', () => {
    const projectRates = new Map([['P1', '30.00']]);
    const entries = [
      e('2026-10-12', 39 * 60, null),
      e('2026-10-13', 60, 'P1', '2026-10-13T10:00:00Z'), // later in the day
      e('2026-10-13', 60, 'P2', '2026-10-13T04:00:00Z'),
    ];
    const r = computePayable({ ...base, rate: '20.00', projectRates, ...WEEK, entries });
    assert.equal(r.lines.find((l) => l.projectId === 'P1')?.overtimeMinutes, 60);
    assert.equal(r.lines.find((l) => l.projectId === 'P2')?.overtimeMinutes, 0);
  });

  it('a monthly period that starts mid-week counts the earlier days towards the cap but does not pay them', () => {
    const entries = [
      e('2026-09-28', 20 * 60), e('2026-09-29', 20 * 60), // Mon, Tue: September period
      e('2026-10-01', 5 * 60), // Thu: this period, all overtime
      e('2026-10-05', 60), // next ISO week, regular
    ];
    const r = computePayable({ ...base, rate: '10.00', periodStart: '2026-10-01', periodEnd: '2026-10-31', entries });
    assert.equal(r.overtimeMinutes, 300);
    assert.equal(r.regularMinutes, 60);
    assert.equal(r.amount, '85.00'); // 5 h x 10 x 1.5 + 1 h x 10
  });

  it('DAILY: each day with time pays the day rate; beyond 8 h/day is overtime at rate/8 x multiplier', () => {
    const r = computePayable({ ...base, rateType: 'DAILY', rate: '200.00', ...WEEK, entries: [e('2026-10-12', 480), e('2026-10-13', 600)] });
    // 200 + 200 + 2 h x 25 x 1.5
    assert.equal(r.amount, '475.00');
    assert.equal(r.days, 2);
  });

  it('DAILY with a project override weights the day rate by minutes', () => {
    const projectRates = new Map([['P1', '300.00']]);
    const r = computePayable({ ...base, rateType: 'DAILY', rate: '200.00', projectRates, ...WEEK, entries: [e('2026-10-12', 240, 'P1'), e('2026-10-12', 240, 'P2')] });
    assert.equal(r.amount, '250.00');
  });

  it('FIXED: the rate per period, no overtime, overrides ignored', () => {
    const r = computePayable({ ...base, rateType: 'FIXED', rate: '1500.00', projectRates: new Map([['P1', '1.00']]), ...WEEK, entries: [e('2026-10-12', 60 * 60, 'P1')] });
    assert.equal(r.amount, '1500.00');
    assert.equal(r.overtimeMinutes, 0);
  });

  it('zero rate, multiplier 1.00, and no entries', () => {
    assert.equal(computePayable({ ...base, rate: '0.00', ...WEEK, entries: [e('2026-10-12', 600)] }).amount, '0.00');
    assert.equal(computePayable({ ...base, overtimeMultiplier: '1.00', ...WEEK, entries: [e('2026-10-12', 50 * 60)] }).amount, '1275.00');
    assert.equal(computePayable({ ...base, ...WEEK, entries: [] }).amount, '0.00');
  });

  it('entries outside the period are never paid', () => {
    const r = computePayable({ ...base, ...WEEK, entries: [e('2026-10-11', 600), e('2026-10-19', 600), e('2026-10-12', 60)] });
    assert.equal(r.amount, '25.50');
  });

  it('refuses amounts that do not fit numeric(14,2)', () => {
    assert.throws(
      () => computePayable({ ...base, rate: '9999999999.99', ...WEEK, entries: [e('2026-10-12', 24 * 60), e('2026-10-13', 24 * 60), e('2026-10-14', 24 * 60), e('2026-10-15', 24 * 60), e('2026-10-16', 24 * 60)] }),
      /too large/i,
    );
  });

  it('a non-positive cap falls back to 40 h', () => {
    const r = computePayable({ ...base, weeklyCapMinutes: 0, ...WEEK, entries: [e('2026-10-12', 40 * 60)] });
    assert.equal(r.overtimeMinutes, 0);
  });
});

describe('Timesheet periods (FR-TS-002)', () => {
  it('weekly: ISO week Monday to Sunday', () => {
    assert.deepEqual(periodFor('2026-10-15', 'WEEKLY', '2026-01-05'), { start: '2026-10-12', end: '2026-10-18' });
    assert.deepEqual(periodFor('2027-01-01', 'WEEKLY', '2026-01-05'), { start: '2026-12-28', end: '2027-01-03' });
  });

  it('bi-weekly: 14-day blocks from the anchor Monday, also before the anchor', () => {
    assert.deepEqual(periodFor('2026-01-05', 'BIWEEKLY', '2026-01-05'), { start: '2026-01-05', end: '2026-01-18' });
    assert.deepEqual(periodFor('2026-01-18', 'BIWEEKLY', '2026-01-05'), { start: '2026-01-05', end: '2026-01-18' });
    assert.deepEqual(periodFor('2026-01-19', 'BIWEEKLY', '2026-01-05'), { start: '2026-01-19', end: '2026-02-01' });
    assert.deepEqual(periodFor('2026-01-04', 'BIWEEKLY', '2026-01-05'), { start: '2025-12-22', end: '2026-01-04' });
    assert.deepEqual(periodFor('2026-10-15', 'BIWEEKLY', '2026-01-05'), { start: '2026-10-12', end: '2026-10-25' });
  });

  it('monthly: calendar month, leap years included', () => {
    assert.deepEqual(periodFor('2026-10-15', 'MONTHLY', '2026-01-05'), { start: '2026-10-01', end: '2026-10-31' });
    assert.deepEqual(periodFor('2028-02-10', 'MONTHLY', '2026-01-05'), { start: '2028-02-01', end: '2028-02-29' });
    assert.deepEqual(periodFor('2026-12-31', 'MONTHLY', '2026-01-05'), { start: '2026-12-01', end: '2026-12-31' });
  });
});

describe('Reconciliation (FR-TS-005)', () => {
  it('within the threshold is not flagged', () => {
    const r = reconcileDay({ attendanceMinutes: 480, loggedMinutes: 420, manualMinutes: 0, manualLimitMinutes: 120, variancePct: 15 });
    assert.equal(r.varianceMinutes, -60);
    assert.equal(r.variancePct, 13);
    assert.deepEqual(r.flags, []);
  });

  it('over the threshold, either direction, is flagged', () => {
    assert.deepEqual(reconcileDay({ attendanceMinutes: 480, loggedMinutes: 300, manualMinutes: 0, manualLimitMinutes: 120, variancePct: 15 }).flags, ['VARIANCE']);
    assert.deepEqual(reconcileDay({ attendanceMinutes: 400, loggedMinutes: 480, manualMinutes: 0, manualLimitMinutes: 120, variancePct: 15 }).flags, ['VARIANCE']);
  });

  it('the boundary itself is not flagged (strictly greater than)', () => {
    assert.deepEqual(reconcileDay({ attendanceMinutes: 400, loggedMinutes: 340, manualMinutes: 0, manualLimitMinutes: 120, variancePct: 15 }).flags, []);
    assert.deepEqual(reconcileDay({ attendanceMinutes: 400, loggedMinutes: 339, manualMinutes: 0, manualLimitMinutes: 120, variancePct: 15 }).flags, ['VARIANCE']);
  });

  it('time logged without attendance and manual time over the limit are flagged', () => {
    assert.deepEqual(reconcileDay({ attendanceMinutes: 0, loggedMinutes: 60, manualMinutes: 60, manualLimitMinutes: 120, variancePct: 15 }).flags, ['NO_ATTENDANCE']);
    assert.deepEqual(reconcileDay({ attendanceMinutes: 480, loggedMinutes: 480, manualMinutes: 150, manualLimitMinutes: 120, variancePct: 15 }).flags, ['MANUAL_LIMIT']);
  });

  it('an empty day is not flagged', () => {
    assert.deepEqual(reconcileDay({ attendanceMinutes: 0, loggedMinutes: 0, manualMinutes: 0, manualLimitMinutes: 120, variancePct: 15 }).flags, []);
  });
});

describe('Timesheet permissions (FR-TS-006, 011)', () => {
  const owner = { id: 'u1', role: 'SUBCONTRACTOR', teamId: 't1' };
  const facts = (status: string, over: Partial<{ ownerManagerId: string | null; ownerTeamId: string | null }> = {}) => ({
    ownerId: 'u1', ownerManagerId: 'lead', ownerTeamId: 't1', status: status as never, ...over,
  });

  it('the owner sees, edits and submits a draft, but never approves it', () => {
    const p = timesheetPermissions(owner, facts('DRAFT'));
    assert.deepEqual(p, { canView: true, canEdit: true, canSubmit: true, canApprove: false, canReopen: false });
    assert.equal(timesheetPermissions(owner, facts('SUBMITTED')).canApprove, false);
    assert.equal(timesheetPermissions(owner, facts('REJECTED')).canSubmit, true);
  });

  it('a team lead approves reports or own-team timesheets, not other teams', () => {
    const lead = { id: 'lead', role: 'TEAM_LEAD', teamId: 't9' };
    assert.equal(timesheetPermissions(lead, facts('SUBMITTED')).canApprove, true);
    const peer = { id: 'peer', role: 'TEAM_LEAD', teamId: 't1' };
    assert.equal(timesheetPermissions(peer, facts('SUBMITTED', { ownerManagerId: null })).canApprove, true);
    const other = { id: 'x', role: 'TEAM_LEAD', teamId: 't2' };
    assert.equal(timesheetPermissions(other, facts('SUBMITTED', { ownerManagerId: null })).canView, false);
  });

  it('a lead cannot approve their own timesheet even as HR', () => {
    const hr = { id: 'u1', role: 'HR', teamId: null };
    assert.equal(timesheetPermissions(hr, facts('SUBMITTED')).canApprove, false);
  });

  it('approved timesheets are locked; only timesheet.reopen reopens', () => {
    const lead = { id: 'lead', role: 'TEAM_LEAD', teamId: 't1' };
    assert.deepEqual(timesheetPermissions(lead, facts('APPROVED')), { canView: true, canEdit: false, canSubmit: false, canApprove: false, canReopen: false });
    assert.equal(timesheetPermissions(owner, facts('APPROVED')).canEdit, false);
    assert.equal(timesheetPermissions({ id: 'hr', role: 'HR', teamId: null }, facts('APPROVED')).canReopen, false);
    assert.equal(timesheetPermissions({ id: 'hrm', role: 'HR_MANAGER', teamId: null }, facts('APPROVED')).canReopen, true);
  });

  it('the auditor (Finance/Auditor) reads everything and changes nothing', () => {
    const p = timesheetPermissions({ id: 'aud', role: 'AUDITOR', teamId: null }, facts('SUBMITTED'));
    assert.deepEqual(p, { canView: true, canEdit: false, canSubmit: false, canApprove: false, canReopen: false });
  });

  it('a subcontractor never sees another person\'s timesheet', () => {
    const p = timesheetPermissions({ id: 'u2', role: 'SUBCONTRACTOR', teamId: 't1' }, facts('SUBMITTED'));
    assert.equal(p.canView, false);
  });
});

describe('Timers across midnight (FR-TS-003)', () => {
  it('splits a timer at each org-local midnight', async () => {
    const { splitAtMidnight } = await import('../src/timesheets/time-entries.service.ts');
    // 22:30 to 01:30 in Colombo (UTC+5:30)
    const pieces = splitAtMidnight(new Date('2026-10-14T17:00:00Z'), new Date('2026-10-14T20:00:00Z'), 'Asia/Colombo');
    assert.deepEqual(pieces.map((p) => [p.date, p.start.toISOString(), p.end.toISOString()]), [
      ['2026-10-14', '2026-10-14T17:00:00.000Z', '2026-10-14T18:30:00.000Z'],
      ['2026-10-15', '2026-10-14T18:30:00.000Z', '2026-10-14T20:00:00.000Z'],
    ]);
    assert.equal(splitAtMidnight(new Date('2026-10-14T04:00:00Z'), new Date('2026-10-14T05:00:00Z'), 'Asia/Colombo').length, 1);
  });
});
