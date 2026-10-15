/**
 * Reminder timing (FR-TASK-011), acceptance escalation (FR-TASK-007) and weekly summary
 * window (FR-TASK-016). Written before the implementation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  dueInstant,
  escalationDue,
  localDate,
  reminderStage,
  weeklySummaryDue,
} from '../src/notifications/reminder-rules.ts';

const TZ = 'Asia/Colombo'; // UTC+05:30

describe('Due instant', () => {
  it('is the configured local time on the due date in the org timezone', () => {
    assert.equal(dueInstant('2026-10-20', TZ).toISOString(), '2026-10-20T11:30:00.000Z'); // 17:00 local
    assert.equal(dueInstant('2026-10-20', TZ, '09:30').toISOString(), '2026-10-20T04:00:00.000Z');
    assert.equal(dueInstant('2026-03-29', 'Europe/London', '17:00').toISOString(), '2026-03-29T16:00:00.000Z'); // after BST starts
  });

  it('localDate gives the org calendar day', () => {
    assert.equal(localDate(new Date('2026-10-20T19:00:00Z'), TZ), '2026-10-21'); // 00:30 next day local
  });
});

describe('Reminder stage (FR-TASK-011)', () => {
  const due = dueInstant('2026-10-20', TZ);
  const at = (h: number) => new Date(due.getTime() + h * 3_600_000);
  it('nothing more than 24 h before', () => assert.equal(reminderStage(at(-30), due), 'NONE'));
  it('24 h window', () => {
    assert.equal(reminderStage(at(-24), due), 'DUE_24H');
    assert.equal(reminderStage(at(-2), due), 'DUE_24H');
  });
  it('1 h window', () => {
    assert.equal(reminderStage(at(-1), due), 'DUE_1H');
    assert.equal(reminderStage(at(-0.1), due), 'DUE_1H');
  });
  it('overdue at and after the due instant', () => {
    assert.equal(reminderStage(due, due), 'OVERDUE');
    assert.equal(reminderStage(at(48), due), 'OVERDUE');
  });
});

describe('Acceptance escalation (FR-TASK-007)', () => {
  const requested = new Date('2026-10-20T08:00:00Z');
  it('escalates once the configured hours have passed', () => {
    assert.equal(escalationDue(new Date('2026-10-21T07:59:00Z'), requested, 24), false);
    assert.equal(escalationDue(new Date('2026-10-21T08:00:00Z'), requested, 24), true);
    assert.equal(escalationDue(new Date('2026-10-20T10:00:00Z'), requested, 2), true);
  });
});

describe('Weekly summary window (FR-TASK-016)', () => {
  it('opens Friday 17:00 local and stays open until the week ends', () => {
    // Friday 2026-10-16 in Colombo
    assert.equal(weeklySummaryDue(new Date('2026-10-16T11:29:00Z'), TZ), null); // 16:59 local
    assert.equal(weeklySummaryDue(new Date('2026-10-16T11:30:00Z'), TZ), '2026-10-12'); // 17:00 local
    assert.equal(weeklySummaryDue(new Date('2026-10-18T18:00:00Z'), TZ), '2026-10-12'); // Sunday 23:30 local
    assert.equal(weeklySummaryDue(new Date('2026-10-18T18:31:00Z'), TZ), null); // Monday 00:01 local
    assert.equal(weeklySummaryDue(new Date('2026-10-14T12:00:00Z'), TZ), null); // Wednesday
  });
});
