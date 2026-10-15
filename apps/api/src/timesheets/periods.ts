/**
 * FR-TS-002 timesheet periods. Dates are org-local calendar dates (YYYY-MM-DD).
 *  - WEEKLY: ISO week, Monday to Sunday.
 *  - BIWEEKLY: 14-day blocks counted from the org's anchor Monday (in both directions).
 *  - MONTHLY: calendar month.
 */
import { addDaysIso, weekStartOf } from '../planning/planning-rules.ts';

export type PeriodKind = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';

export interface Period {
  start: string;
  end: string;
}

function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!) / 86_400_000;
}

export function periodFor(date: string, kind: PeriodKind, anchor: string): Period {
  if (kind === 'MONTHLY') {
    const [y, m] = date.split('-').map(Number);
    const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
    const mm = String(m).padStart(2, '0');
    return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, '0')}` };
  }
  if (kind === 'BIWEEKLY') {
    const offset = dayNumber(date) - dayNumber(weekStartOf(anchor));
    const block = Math.floor(offset / 14);
    const start = addDaysIso(weekStartOf(anchor), block * 14);
    return { start, end: addDaysIso(start, 13) };
  }
  const start = weekStartOf(date);
  return { start, end: addDaysIso(start, 6) };
}

/** Every date from start to end inclusive. */
export function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDaysIso(d, 1)) out.push(d);
  return out;
}
