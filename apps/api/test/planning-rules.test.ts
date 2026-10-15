/**
 * Planning rules (FR-TASK-003, 004): week boundaries, working days, carry-over target,
 * why a task appears on Today, capacity. Written before the implementation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDaysIso,
  capacityFromSchedule,
  dayOfWeek,
  nextWorkDay,
  todayReasons,
  weekStartOf,
  workingDaysFromSchedule,
} from '../src/planning/planning-rules.ts';

describe('Dates', () => {
  it('weekStartOf returns the Monday of the ISO week', () => {
    assert.equal(weekStartOf('2026-10-15'), '2026-10-12'); // Thursday
    assert.equal(weekStartOf('2026-10-12'), '2026-10-12'); // Monday
    assert.equal(weekStartOf('2026-10-18'), '2026-10-12'); // Sunday belongs to the same ISO week
    assert.equal(weekStartOf('2027-01-01'), '2026-12-28'); // across a year boundary
  });

  it('addDaysIso and dayOfWeek are calendar-safe (DST-free, string dates)', () => {
    assert.equal(addDaysIso('2026-02-28', 1), '2026-03-01');
    assert.equal(addDaysIso('2028-02-28', 1), '2028-02-29');
    assert.equal(addDaysIso('2026-10-12', -1), '2026-10-11');
    assert.equal(dayOfWeek('2026-10-12'), 1);
    assert.equal(dayOfWeek('2026-10-18'), 7);
  });

  it('nextWorkDay skips non-working days', () => {
    const monFri = new Set([1, 2, 3, 4, 5]);
    assert.equal(nextWorkDay('2026-10-15', monFri), '2026-10-16'); // Thu -> Fri
    assert.equal(nextWorkDay('2026-10-16', monFri), '2026-10-19'); // Fri -> Mon
    assert.equal(nextWorkDay('2026-10-17', monFri), '2026-10-19'); // Sat -> Mon
    assert.equal(nextWorkDay('2026-10-15', new Set([1, 3])), '2026-10-19'); // Thu -> Mon
    assert.equal(nextWorkDay('2026-10-15', new Set()), '2026-10-16', 'no schedule falls back to the next calendar day');
  });
});

describe('Why a task is on Today', () => {
  const day = '2026-10-15';
  it('planned today, due today, overdue and carried over are distinguished', () => {
    assert.deepEqual(todayReasons({ plannedDate: day, dueDate: null, status: 'TODO' }, day, false), ['PLANNED']);
    assert.deepEqual(todayReasons({ plannedDate: null, dueDate: day, status: 'TODO' }, day, false), ['DUE_TODAY']);
    assert.deepEqual(todayReasons({ plannedDate: null, dueDate: '2026-10-10', status: 'IN_PROGRESS' }, day, false), ['OVERDUE']);
    assert.deepEqual(todayReasons({ plannedDate: '2026-10-14', dueDate: null, status: 'TODO' }, day, false), ['CARRIED_OVER']);
    assert.deepEqual(todayReasons({ plannedDate: day, dueDate: day, status: 'TODO' }, day, true), ['IN_PLAN', 'PLANNED', 'DUE_TODAY']);
  });

  it('done tasks and future work are not on Today', () => {
    assert.deepEqual(todayReasons({ plannedDate: '2026-10-14', dueDate: '2026-10-10', status: 'DONE' }, day, false), []);
    assert.deepEqual(todayReasons({ plannedDate: '2026-10-16', dueDate: '2026-10-20', status: 'TODO' }, day, false), []);
    assert.deepEqual(todayReasons({ plannedDate: null, dueDate: null, status: 'TODO' }, day, false), []);
  });
});

describe('Capacity (FR-TASK-004)', () => {
  it('sums expected hours of the schedule, else 40 h; working days follow the schedule', () => {
    const days = { '1': { start: '09:00', end: '17:00', expectedHours: 8 }, '3': { start: '09:00', end: '13:00', expectedHours: 4 } };
    assert.equal(capacityFromSchedule(days), 12 * 60);
    assert.equal(capacityFromSchedule(null), 40 * 60);
    assert.deepEqual([...workingDaysFromSchedule(days)].sort(), [1, 3]);
    assert.deepEqual([...workingDaysFromSchedule(null)].sort(), [1, 2, 3, 4, 5]);
  });
});
