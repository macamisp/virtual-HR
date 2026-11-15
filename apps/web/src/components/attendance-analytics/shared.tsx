'use client';

import { Info } from 'lucide-react';
import { ANALYTICS_STATUS_LABEL } from '@hrvo/shared';
import type { AnalyticsRow, AnalyticsStatus } from '@hrvo/shared';
import { Badge } from '@/components/ui/badge';
import { addDays, formatDuration, startOfWeek, toWorkDate } from '@/lib/format';

/**
 * FR-REP-009 (ADR 059): pieces shared by the HR dashboard, the person page and one's own view.
 * Times are shown in the organisation's timezone (the one the reporting days are cut in).
 */

/** The three measures, said plainly wherever they are shown. */
export function AnalyticsDefinitions({ retentionDays }: { retentionDays?: number }) {
  return (
    <details className="rounded-md border bg-muted/30 p-3 text-sm" data-testid="analytics-definitions" open>
      <summary className="flex cursor-pointer items-center gap-2 font-medium"><Info aria-hidden="true" className="h-4 w-4" /> What these numbers mean</summary>
      <dl className="mt-2 grid gap-2 sm:grid-cols-3">
        <div><dt className="font-medium">Work attendance</dt><dd className="text-muted-foreground">Verified attendance from the attendance engine: the time that counts as work.</dd></div>
        <div><dt className="font-medium">Office connected time</dt><dd className="text-muted-foreground">Time connected to the virtual office. It is not proof of work and is never added to work time. Where people were or what they did there is not recorded.</dd></div>
        <div><dt className="font-medium">Meeting time</dt><dd className="text-muted-foreground">Participation the server confirmed (a real call with someone else). It is part of work attendance.</dd></div>
      </dl>
      {retentionDays !== undefined ? <p className="mt-2 text-xs text-muted-foreground">Office connection times are kept for {retentionDays} days. All times are server-recorded.</p> : null}
    </details>
  );
}

const STATUS_VARIANT: Record<AnalyticsStatus, 'success' | 'warning' | 'destructive' | 'secondary' | 'default' | 'outline'> = {
  PRESENT: 'success', LATE: 'warning', EARLY_LEAVE: 'warning', HALF_DAY: 'warning', ABSENT: 'destructive', LEAVE: 'secondary', HOLIDAY: 'secondary', REST_DAY: 'secondary',
  IN_PROGRESS: 'default', NOT_SUMMARISED: 'outline',
};

export function StatusCell({ row }: { row: AnalyticsRow }) {
  if (row.status) return <Badge variant={STATUS_VARIANT[row.status]}>{ANALYTICS_STATUS_LABEL[row.status]}</Badge>;
  const counts = Object.entries(row.statusCounts);
  if (!counts.length) return <span className="text-muted-foreground">No attendance</span>;
  return <span className="text-xs">{counts.map(([k, n]) => `${ANALYTICS_STATUS_LABEL[k as AnalyticsStatus] ?? k} ${n}`).join(' · ')}</span>;
}

export const dur = (s: number): string => (s > 0 ? formatDuration(s) : '—');

export function clock(iso: string | null, timezone: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat([], { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

export function dateTime(iso: string | null, timezone: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat([], { timeZone: timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

/** A day (YYYY-MM-DD), a week (its Monday) or a month (YYYY-MM), readable. */
export function periodLabel(period: string, groupBy: 'day' | 'week' | 'month' | 'total'): string {
  if (groupBy === 'month') {
    const [y, m] = period.split('-').map(Number);
    return new Date(y!, m! - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
  }
  if (groupBy === 'total') return 'Whole range';
  const [y, m, d] = period.split('-').map(Number);
  const s = new Date(y!, m! - 1, d!).toLocaleDateString([], { weekday: groupBy === 'day' ? 'short' : undefined, day: 'numeric', month: 'short', year: 'numeric' });
  return groupBy === 'week' ? `Week of ${s}` : s;
}

export const PRESETS = ['today', 'this-week', 'last-week', 'this-month', 'last-month', 'custom'] as const;
export type Preset = (typeof PRESETS)[number];
export const PRESET_LABEL: Record<Preset, string> = { today: 'Today', 'this-week': 'This week', 'last-week': 'Last week', 'this-month': 'This month', 'last-month': 'Last month', custom: 'Custom range' };

export function presetRange(p: Exclude<Preset, 'custom'>, now = new Date()): { from: string; to: string } {
  const monday = startOfWeek(now);
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  switch (p) {
    case 'today': return { from: toWorkDate(now), to: toWorkDate(now) };
    case 'this-week': return { from: toWorkDate(monday), to: toWorkDate(addDays(monday, 6)) };
    case 'last-week': return { from: toWorkDate(addDays(monday, -7)), to: toWorkDate(addDays(monday, -1)) };
    case 'this-month': return { from: toWorkDate(first), to: toWorkDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
    case 'last-month': return { from: toWorkDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: toWorkDate(new Date(now.getFullYear(), now.getMonth(), 0)) };
  }
}

/** A summary figure. */
export function Stat({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId?: string }) {
  return (
    <div className="rounded-md border bg-background p-3" data-testid={testId}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
