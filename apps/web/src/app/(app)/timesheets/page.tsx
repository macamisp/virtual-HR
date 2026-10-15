'use client';

import Link from 'next/link';
import { AccessDenied, ErrorState, LoadingState } from '@/components/state-views';
import { TimesheetView, TimesheetStatusBadge, periodLabel } from '@/components/timesheets/timesheet-view';
import { minutesLabel } from '@/components/tasks/badges';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Permission, useCan } from '@/lib/permissions';
import { useCurrentTimesheet, useTimesheets } from '@/lib/timesheet-queries';

/** FR-TS-001/002: my timesheet for the current period, plus earlier periods. */
export default function MyTimesheetPage() {
  const canUse = useCan(Permission.TIMESHEETS_USE);
  const canReadAll = useCan(Permission.TIMESHEETS_READ_ALL);
  const current = useCurrentTimesheet(canUse);
  const history = useTimesheets({ scope: 'mine' }, canUse);

  if (!canUse) {
    return canReadAll ? (
      <p className="text-sm">Your role reads timesheets without keeping one. Open <Link className="text-primary underline" href="/timesheets/review">Review timesheets</Link>.</p>
    ) : (
      <AccessDenied what="Timesheets" />
    );
  }
  if (current.isPending) return <LoadingState label="Loading your timesheet" rows={6} />;
  if (current.isError) return <ErrorState error={current.error} onRetry={() => void current.refetch()} />;
  const earlier = (history.data?.items ?? []).filter((s) => s.id !== current.data.id);

  return (
    <div className="space-y-6">
      <TimesheetView sheet={current.data} heading="My timesheet" />
      <Card>
        <CardHeader><CardTitle className="text-base">Other periods</CardTitle></CardHeader>
        <CardContent>
          {history.isPending ? <LoadingState label="Loading earlier timesheets" rows={2} /> : null}
          {history.isError ? <ErrorState error={history.error} onRetry={() => void history.refetch()} /> : null}
          {history.data && earlier.length === 0 ? <p className="text-sm text-muted-foreground">No other timesheets yet.</p> : null}
          <ul className="divide-y" data-testid="my-timesheets">
            {earlier.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Link href={`/timesheets/${s.id}`} className="text-primary underline-offset-4 hover:underline">{periodLabel(s.periodStart, s.periodEnd)}</Link>
                <span className="text-sm text-muted-foreground">{minutesLabel(s.loggedMinutes)} logged</span>
                <TimesheetStatusBadge status={s.status} />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
