'use client';

import { useState } from 'react';
import { FlagCard } from '@/components/flags/flag-card';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Button } from '@/components/ui/button';
import { useFlags } from '@/lib/flag-queries';
import { Permission, useCan } from '@/lib/permissions';

/**
 * FR-ATT-017/018 (ADR 019): items automatic checks raised for a human look. Managers and team
 * leads see their people; HR and admins see everyone. Resolving needs a note and changes nothing
 * in the recorded time.
 */
export default function AttendanceReviewPage() {
  const canReview = useCan(Permission.ATTENDANCE_CORRECTIONS_REVIEW);
  const canSeeAll = useCan(Permission.ATTENDANCE_READ_ALL);
  const [status, setStatus] = useState<'OPEN' | 'RESOLVED'>('OPEN');
  const flags = useFlags('review', status, canReview || canSeeAll);
  if (!canReview && !canSeeAll) return <AccessDenied what="Attendance review" />;
  return (
    <div className="max-w-4xl space-y-4">
      <h1 className="text-2xl font-semibold">Attendance review</h1>
      <p className="text-sm text-muted-foreground">
        Automatic checks (signal checks, network policy, devices, offline time) raise these for a person to look at. They are often harmless, such as a VPN or a second tab.
        No time is ever changed or deducted because of a flag; use a correction if the record itself is wrong.
      </p>
      <div role="tablist" aria-label="Status" className="flex gap-1">
        {(['OPEN', 'RESOLVED'] as const).map((s) => <Button key={s} role="tab" size="sm" aria-selected={status === s} variant={status === s ? 'default' : 'outline'} onClick={() => setStatus(s)}>{s === 'OPEN' ? 'To review' : 'Resolved'}</Button>)}
      </div>
      <div role="tabpanel">
        {flags.isPending ? <LoadingState label="Loading items" rows={3} /> : null}
        {flags.isError ? <ErrorState error={flags.error} onRetry={() => void flags.refetch()} /> : null}
        {flags.data && !flags.data.items.length ? <EmptyState title={status === 'OPEN' ? 'Nothing to review' : 'Nothing resolved yet'} /> : null}
        {flags.data?.items.length ? <ul className="space-y-2" data-testid="review-flags">{flags.data.items.map((f) => <FlagCard key={f.id} flag={f} />)}</ul> : null}
      </div>
    </div>
  );
}
