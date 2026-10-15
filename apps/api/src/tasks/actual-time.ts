/**
 * FR-TASK-008 estimate vs actual. Actual minutes come from timers and time entries, which
 * arrive with the Timesheets slice; until then the provider reports nothing and the UI shows
 * "no time logged yet". The overrun rule itself is final.
 */
export const ACTUAL_TIME_PROVIDER = Symbol('ACTUAL_TIME_PROVIDER');

export interface ActualTimeProvider {
  /** Logged minutes per task id; tasks without entries are absent from the map. */
  actualMinutes(orgId: string, taskIds: string[]): Promise<Map<string, number>>;
}

/** Placeholder until time_entries exists (Timesheets slice). */
export class NoTimeEntriesYet implements ActualTimeProvider {
  async actualMinutes(): Promise<Map<string, number>> {
    return new Map();
  }
}

export function isOverrun(estimateMinutes: number | null, actualMinutes: number | null): boolean {
  return estimateMinutes !== null && actualMinutes !== null && actualMinutes > estimateMinutes;
}
