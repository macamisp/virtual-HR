'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, use, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { PersonAnalyticsView, RangeControl } from '@/components/attendance-analytics/person-view';
import { presetRange } from '@/components/attendance-analytics/shared';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ApiError } from '@/lib/api';
import { Permission, useCan } from '@/lib/permissions';
import { usePersonAnalytics } from '@/lib/report-queries';

/** FR-REP-009 (ADR 059): one employee's attendance detail, for HR and for managers within their scope. */
function PersonPage({ userId }: { userId: string }) {
  const params = useSearchParams();
  const team = useCan(Permission.REPORTS_TEAM);
  const all = useCan(Permission.REPORTS_ALL);
  const [range, setRange] = useState(() => {
    const from = params.get('from');
    const to = params.get('to');
    return from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) ? { from, to } : presetRange('this-week');
  });
  const r = usePersonAnalytics(userId, range, team || all);
  if (!team && !all) return <AccessDenied what="Attendance analytics" />;
  const notFound = r.error instanceof ApiError && r.error.status === 404;
  return (
    <div className="space-y-4">
      <Link href="/reports" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft aria-hidden="true" className="h-4 w-4" /> Reports</Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{r.data ? (r.data.user.displayName ?? r.data.user.email) : 'Attendance detail'}</h1>
          {r.data ? <p className="text-sm text-muted-foreground">{r.data.user.teamName ?? 'No team'} · attendance analytics</p> : null}
        </div>
        <RangeControl range={range} onChange={setRange} />
      </div>
      {range.from > range.to ? <Alert variant="destructive"><AlertDescription>“From” must not be after “To”.</AlertDescription></Alert> : null}
      {r.isPending && range.from <= range.to ? <LoadingState label="Loading attendance detail" rows={6} /> : null}
      {notFound ? <EmptyState title="Person not found" description="Nobody by this link is in your reporting scope." /> : null}
      {r.isError && !notFound ? <ErrorState error={r.error} onRetry={() => void r.refetch()} /> : null}
      {r.data ? <PersonAnalyticsView data={r.data} /> : null}
    </div>
  );
}

export default function PersonAnalyticsPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = use(params);
  return <Suspense><PersonPage userId={userId} /></Suspense>;
}
