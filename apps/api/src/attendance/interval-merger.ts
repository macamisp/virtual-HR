/**
 * Interval Union Utility for Anti-Double-Counting Multi-Device Merging
 * Ref: docs/SRS.md FR-ATT-010 & NFR-ACC-003
 */

export interface TimeInterval {
  start: Date;
  end: Date;
}

/**
 * Computes total wall-clock duration of the union of intervals.
 * Guarantees zero double-counted time across concurrent devices.
 */
export function computeIntervalUnionDurationSeconds(intervals: TimeInterval[]): number {
  if (intervals.length === 0) return 0;

  // Filter out invalid intervals where end < start
  const valid = intervals.filter((i) => i.end.getTime() >= i.start.getTime());
  if (valid.length === 0) return 0;

  // Sort by start time
  const sorted = [...valid].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: TimeInterval[] = [{ start: new Date(sorted[0]!.start.getTime()), end: new Date(sorted[0]!.end.getTime()) }];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const prev = merged[merged.length - 1]!;

    if (current.start.getTime() <= prev.end.getTime()) {
      // Overlapping or contiguous interval: extend end to max
      prev.end = new Date(Math.max(prev.end.getTime(), current.end.getTime()));
    } else {
      merged.push({ start: new Date(current.start.getTime()), end: new Date(current.end.getTime()) });
    }
  }

  return merged.reduce((total, interval) => {
    return total + Math.max(0, Math.round((interval.end.getTime() - interval.start.getTime()) / 1000));
  }, 0);
}
