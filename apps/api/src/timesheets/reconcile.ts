/**
 * FR-TS-005 reconciliation: net attendance time vs logged task time for one day.
 * Integer arithmetic only; "over the threshold" means strictly greater than.
 */
export type DayFlag = 'VARIANCE' | 'NO_ATTENDANCE' | 'MANUAL_LIMIT';

export interface DayInput {
  attendanceMinutes: number;
  loggedMinutes: number;
  manualMinutes: number;
  manualLimitMinutes: number;
  /** Org threshold in whole percent (default 15). */
  variancePct: number;
}

export interface DayResult {
  /** logged - attendance: negative = less logged than attended. */
  varianceMinutes: number;
  /** |variance| / attendance, whole percent rounded half up; null without attendance. */
  variancePct: number | null;
  flags: DayFlag[];
}

export function reconcileDay(i: DayInput): DayResult {
  const varianceMinutes = i.loggedMinutes - i.attendanceMinutes;
  const abs = Math.abs(varianceMinutes);
  const flags: DayFlag[] = [];
  let variancePct: number | null = null;
  if (i.attendanceMinutes > 0) {
    variancePct = Math.floor((abs * 200 + i.attendanceMinutes) / (2 * i.attendanceMinutes));
    if (abs * 100 > i.variancePct * i.attendanceMinutes) flags.push('VARIANCE');
  } else if (i.loggedMinutes > 0) {
    flags.push('NO_ATTENDANCE');
  }
  if (i.manualMinutes > i.manualLimitMinutes) flags.push('MANUAL_LIMIT');
  return { varianceMinutes, variancePct, flags };
}
