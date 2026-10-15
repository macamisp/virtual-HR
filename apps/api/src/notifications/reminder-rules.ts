/**
 * Pure timing rules for scheduled task notifications.
 *
 * `tasks.due_date` is a calendar date without a time, so a task is "due" at
 * TASK_DUE_TIME (default 17:00) in the organisation's timezone on that date. "Due soon"
 * reminders fire 24 h and 1 h before that instant (FR-TASK-011); overdue fires at it.
 */
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { addDaysIso, dayOfWeek, weekStartOf } from '../planning/planning-rules.ts';

export type ReminderStage = 'NONE' | 'DUE_24H' | 'DUE_1H' | 'OVERDUE';

const HOUR = 3_600_000;

export function dueInstant(dueDate: string, timezone: string, dueTime = '17:00'): Date {
  return fromZonedTime(`${dueDate}T${dueTime}:00`, timezone);
}

export function localDate(now: Date, timezone: string): string {
  return formatInTimeZone(now, timezone, 'yyyy-MM-dd');
}

export function reminderStage(now: Date, dueAt: Date): ReminderStage {
  const remaining = dueAt.getTime() - now.getTime();
  if (remaining <= 0) return 'OVERDUE';
  if (remaining <= HOUR) return 'DUE_1H';
  if (remaining <= 24 * HOUR) return 'DUE_24H';
  return 'NONE';
}

export function escalationDue(now: Date, requestedAt: Date, hours: number): boolean {
  return now.getTime() - requestedAt.getTime() >= hours * HOUR;
}

/**
 * Week start (Monday) whose summary is due at `now`, or null. The window opens on
 * `day` (ISO, 5 = Friday) at `time` local and closes when the week ends.
 */
export function weeklySummaryDue(now: Date, timezone: string, day = 5, time = '17:00'): string | null {
  const today = localDate(now, timezone);
  const weekStart = weekStartOf(today);
  const opensAt = fromZonedTime(`${addDaysIso(weekStart, day - 1)}T${time}:00`, timezone);
  if (dayOfWeek(today) < day || now.getTime() < opensAt.getTime()) return null;
  return weekStart;
}
