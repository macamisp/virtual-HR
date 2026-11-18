/**
 * ADR 059 (FR-REP-009): interval arithmetic for the attendance analytics. Pure functions, no I/O.
 *
 * Office connection intervals (and meeting connections) are merged first, so overlapping or
 * duplicate intervals (several tabs, a reconnect, a lost write) count once. They are then cut at
 * organisation-local midnights, computed with the IANA timezone, so a day is 23, 24 or 25 hours
 * long across a daylight-saving change and nothing is lost or counted twice at midnight.
 */
import { fromZonedTime } from 'date-fns-tz';

export interface Interval { start: number; end: number }

/** The union of the intervals, sorted. Empty and inverted intervals are dropped. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

export const totalSeconds = (list: Interval[]): number => Math.floor(mergeIntervals(list).reduce((s, i) => s + (i.end - i.start), 0) / 1000);

/** Every YYYY-MM-DD from `from` to `to`, inclusive. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

const nextDate = (date: string): string => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

/** The instant a local calendar day starts and the next one starts, in the timezone. */
export function localDayBounds(date: string, timezone: string): Interval {
  return { start: fromZonedTime(`${date}T00:00:00`, timezone).getTime(), end: fromZonedTime(`${nextDate(date)}T00:00:00`, timezone).getTime() };
}

/**
 * Seconds of the merged intervals that fall on each local day from `from` to `to`. Days without
 * any are left out of the map.
 */
export function secondsByLocalDay(list: Interval[], from: string, to: string, timezone: string): Map<string, number> {
  const merged = mergeIntervals(list);
  const out = new Map<string, number>();
  if (!merged.length) return out;
  for (const date of datesBetween(from, to)) {
    const day = localDayBounds(date, timezone);
    let ms = 0;
    for (const i of merged) {
      if (i.end <= day.start) continue;
      if (i.start >= day.end) break;
      ms += Math.min(i.end, day.end) - Math.max(i.start, day.start);
    }
    if (ms > 0) out.set(date, Math.floor(ms / 1000));
  }
  return out;
}

/**
 * Where an office interval ends for counting. A closed one at its end. An open one at the last
 * time the server saw the person (refreshed about once a minute), never later: after a crash
 * nothing beyond the last reliable observation is counted. Never before it started.
 */
export function officeIntervalEnd(r: { startedAt: Date; endedAt: Date | null; lastSeenAt: Date }, now: number): number {
  const end = r.endedAt ? r.endedAt.getTime() : Math.min(r.lastSeenAt.getTime(), now);
  return Math.max(r.startedAt.getTime(), end);
}
