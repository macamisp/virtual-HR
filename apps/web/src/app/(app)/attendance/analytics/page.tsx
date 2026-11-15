'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { PersonAnalyticsView, RangeControl } from '@/components/attendance-analytics/person-view';
import { presetRange } from '@/components/attendance-analytics/shared';
import { AccessDenied, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Permission, useCan } from '@/lib/permissions';
import { usePersonAnalytics } from '@/lib/report-queries';

/**
 * FR-REP-009 (ADR 059): your own attendance, office connection and meeting time, the same view HR
 * and your manager have of you (they do not see your meeting titles). Your records can be
 * downloaded from My data (/account/privacy).
 */
export default function MyAnalyticsPage() {
  const allowed = useCan(Permission.ATTENDANCE_READ_OWN);
  const [range, setRange] = useState(() => presetRange('this-month'));
  const r = usePersonAnalytics(null, range, allowed);
  if (!allowed) return <AccessDenied what="Your attendance analytics" />;
  return (
    <div className="space-y-4">
      <Link href="/attendance" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft aria-hidden="true" className="h-4 w-4" /> My attendance</Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">My attendance analytics</h1>
          <p className="text-sm text-muted-foreground">What HR and your manager can see about your time. You can download your records from <Link className="underline" href="/account/privacy">My data</Link>.</p>
        </div>
        <RangeControl range={range} onChange={setRange} />
      </div>
      {range.from > range.to ? <Alert variant="destructive"><AlertDescription>“From” must not be after “To”.</AlertDescription></Alert> : null}
      {r.isPending && range.from <= range.to ? <LoadingState label="Loading your attendance analytics" rows={6} /> : null}
      {r.isError ? <ErrorState error={r.error} onRetry={() => void r.refetch()} /> : null}
      {r.data ? <PersonAnalyticsView data={r.data} /> : null}
    </div>
  );
}
