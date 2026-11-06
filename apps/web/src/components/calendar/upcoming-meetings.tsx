'use client';

import Link from 'next/link';
import { CalendarClock, ExternalLink } from 'lucide-react';
import { CALENDAR_PROVIDER_LABEL } from '@hrvo/shared';
import type { UpcomingItem } from '@hrvo/shared';
import { EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import type { BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useUpcomingCalendar } from '@/lib/calendar-queries';
import { cn } from '@/lib/utils';
import { Permission, useCan } from '@/lib/permissions';

const RESPONSE: Record<NonNullable<UpcomingItem['response']>, { label: string; variant: BadgeProps['variant'] }> = {
  ACCEPTED: { label: 'Accepted', variant: 'success' },
  DECLINED: { label: 'Declined', variant: 'destructive' },
  TENTATIVE: { label: 'Maybe', variant: 'warning' },
  NEEDS_ACTION: { label: 'Not answered', variant: 'outline' },
};

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** "Thu 6 Nov · 10:00–11:00", or "Thu 6 Nov · All day" (all-day dates are calendar dates, shown as such). */
function when(i: UpcomingItem): string {
  const day = new Date(i.start).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', ...(i.allDay ? { timeZone: 'UTC' } : {}) });
  return `${day} · ${i.allDay ? 'All day' : `${clock(i.start)}–${clock(i.end)}`}`;
}

function OpenLink({ item }: { item: UpcomingItem }) {
  if (item.hrvoMeetingId) {
    return <Button asChild size="sm" variant="outline"><Link href={`/meetings/${item.hrvoMeetingId}`}>Open</Link></Button>;
  }
  if (!item.openUrl || !item.openUrl.startsWith('https://')) return null;
  return (
    <Button asChild size="sm" variant="outline">
      <a href={item.openUrl} target="_blank" rel="noopener noreferrer">Open <ExternalLink aria-hidden="true" /><span className="sr-only">(opens in a new tab)</span></a>
    </Button>
  );
}

/**
 * FR-WT-022 (ADR 049 §6): the person's next meetings from their connected Google or Outlook
 * calendar. Read only; scheduled events never count as worked time (only joining the call does).
 */
export function UpcomingMeetings({ days = 7, className }: { days?: number; className?: string }) {
  const allowed = useCan(Permission.MEETINGS_USE);
  const q = useUpcomingCalendar(days, allowed);
  if (!allowed) return null;
  const broken = q.data?.providers.filter((p) => p.status === 'ERROR') ?? [];
  const notes = q.data?.providers.filter((p) => p.status !== 'ERROR' && p.lastError) ?? [];
  return (
    <Card className={cn('min-w-0', className)} data-testid="upcoming-meetings">
      <CardHeader className="p-4 sm:p-6">
        <CardTitle className="flex items-center gap-2 text-base"><CalendarClock className="h-4 w-4" aria-hidden="true" /> Upcoming meetings</CardTitle>
        <CardDescription>Next {days} days from your connected calendar.</CardDescription>
        <p className="text-xs text-muted-foreground" data-testid="upcoming-worktime-note">Scheduled events do not count as worked time; joining the call does.</p>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0 sm:p-6 sm:pt-0">
        {q.isPending ? <LoadingState label="Loading upcoming meetings" rows={3} /> : null}
        {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
        {q.data && !q.data.connected ? (
          <div className="rounded-lg border border-dashed p-4 text-sm" data-testid="upcoming-not-connected">
            <p>No calendar is connected.</p>
            <Button asChild size="sm" className="mt-2"><Link href="/account/calendar">Connect a calendar</Link></Button>
          </div>
        ) : null}
        {broken.map((p) => (
          <p key={p.provider} role="alert" className="text-sm text-destructive" data-testid={`upcoming-error-${p.provider}`}>
            {CALENDAR_PROVIDER_LABEL[p.provider]} needs attention. {p.lastError ?? ''}{' '}
            <Link href="/account/calendar" className="font-medium underline underline-offset-4">Connect again</Link>
          </p>
        ))}
        {notes.map((p) => (
          <p key={p.provider} className="text-sm text-muted-foreground" data-testid={`upcoming-note-${p.provider}`}>{CALENDAR_PROVIDER_LABEL[p.provider]}: {p.lastError}</p>
        ))}
        {q.data?.connected && q.data.items.length === 0 ? <EmptyState title="No upcoming meetings" description={`Nothing in your calendar for the next ${days} days.`} /> : null}
        {q.data && q.data.items.length > 0 ? (
          <ul className="divide-y rounded-lg border" data-testid="upcoming-list">
            {q.data.items.map((i) => (
              <li key={`${i.provider}-${i.id}`} className="flex flex-wrap items-start justify-between gap-2 p-3">
                <div className="min-w-0 flex-1 basis-48">
                  <p className="break-words font-medium">{i.title}</p>
                  <p className="text-sm tabular-nums text-muted-foreground">{when(i)}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span>{i.source}</span>
                    {i.hrvoMeetingId ? <Badge variant="secondary">Virtual-HR meeting</Badge> : null}
                    {i.response ? <Badge variant={RESPONSE[i.response].variant}>{RESPONSE[i.response].label}</Badge> : null}
                  </div>
                </div>
                <OpenLink item={i} />
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
