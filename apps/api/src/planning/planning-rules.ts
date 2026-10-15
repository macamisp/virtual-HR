/**
 * Pure planning rules (FR-TASK-003, 004). Dates are org-local calendar dates as YYYY-MM-DD
 * strings, so no timezone or DST arithmetic happens here.
 */

export type TodayReason = 'IN_PLAN' | 'PLANNED' | 'DUE_TODAY' | 'OVERDUE' | 'CARRIED_OVER';

interface ScheduleDay {
  expectedHours: number;
}

const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];
const DEFAULT_CAPACITY_MINUTES = 40 * 60;

function toUtc(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDaysIso(date: string, days: number): string {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

/** ISO day of week: 1 = Monday … 7 = Sunday. */
export function dayOfWeek(date: string): number {
  const dow = toUtc(date).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** Monday of the ISO week containing `date`. */
export function weekStartOf(date: string): string {
  return addDaysIso(date, 1 - dayOfWeek(date));
}

/** Next date after `date` that is a working day (falls back to the next calendar day). */
export function nextWorkDay(date: string, workingDays: Set<number>): string {
  if (workingDays.size === 0) return addDaysIso(date, 1);
  let d = addDaysIso(date, 1);
  for (let i = 0; i < 7 && !workingDays.has(dayOfWeek(d)); i++) d = addDaysIso(d, 1);
  return d;
}

export function workingDaysFromSchedule(days: Record<string, ScheduleDay> | null | undefined): Set<number> {
  if (!days || Object.keys(days).length === 0) return new Set(DEFAULT_WORKING_DAYS);
  return new Set(
    Object.entries(days)
      .filter(([, d]) => d && d.expectedHours > 0)
      .map(([k]) => Number(k))
      .filter((n) => n >= 1 && n <= 7),
  );
}

/** Weekly capacity in minutes from the work schedule (FR-TASK-004), else 40 h. */
export function capacityFromSchedule(days: Record<string, ScheduleDay> | null | undefined): number {
  if (!days || Object.keys(days).length === 0) return DEFAULT_CAPACITY_MINUTES;
  const hours = Object.values(days).reduce((sum, d) => sum + (d?.expectedHours ?? 0), 0);
  return Math.round(hours * 60);
}

/**
 * Why an open task assigned to the user belongs on the Today list for `day` (FR-TASK-003).
 * Empty = not on Today. Done tasks never carry over.
 */
export function todayReasons(
  task: { plannedDate: string | null; dueDate: string | null; status: string },
  day: string,
  inPlan: boolean,
): TodayReason[] {
  if (task.status === 'DONE') return inPlan ? ['IN_PLAN'] : [];
  const reasons: TodayReason[] = [];
  if (inPlan) reasons.push('IN_PLAN');
  if (task.plannedDate === day) reasons.push('PLANNED');
  if (task.dueDate === day) reasons.push('DUE_TODAY');
  if (task.dueDate !== null && task.dueDate < day) reasons.push('OVERDUE');
  if (task.plannedDate !== null && task.plannedDate < day && !reasons.includes('OVERDUE')) reasons.push('CARRIED_OVER');
  return reasons;
}
