'use client';

import { useState } from 'react';
import type { RequestStatus } from '@hrvo/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { ActivityNote, WorkTimeNav } from '@/components/work-time/work-time-nav';
import { DecisionPanel, OnsiteRow, OvertimeRow } from '@/components/work-time/request-rows';
import { Permission, useCan } from '@/lib/permissions';
import { useOnsiteRequests, useOvertimeRequests } from '@/lib/work-request-queries';

/** ADR 049 §2, §7 (FR-WT-008, FR-WT-009): requests from the people I approve for, and their history. */
export default function ReviewRequestsPage() {
  const team = useCan(Permission.TIMESHEETS_APPROVE_TEAM);
  const all = useCan(Permission.TIMESHEETS_APPROVE_ALL);
  const allowed = team || all;
  const [status, setStatus] = useState<RequestStatus | ''>('PENDING');
  const ot = useOvertimeRequests('team', status || undefined, allowed);
  const os = useOnsiteRequests('team', status || undefined, allowed);
  if (!allowed) return <AccessDenied what="Request review" />;
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Review requests</h1>
        <WorkTimeNav />
        <ActivityNote />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="rv-status">Show</Label>
          <NativeSelect id="rv-status" className="w-56" value={status} onChange={(e) => setStatus(e.target.value as RequestStatus | '')}>
            <option value="PENDING">Waiting for a decision</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
            <option value="CANCELLED">Cancelled</option>
            <option value="">All (history)</option>
          </NativeSelect>
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Overtime requests</CardTitle>
            <CardDescription>Compare what was requested with the overtime worked beyond the schedule. Approving fewer minutes is allowed.</CardDescription>
          </CardHeader>
          <CardContent>
            {ot.isPending ? <LoadingState label="Loading" rows={2} /> : null}
            {ot.isError ? <ErrorState error={ot.error} onRetry={() => void ot.refetch()} /> : null}
            {ot.data && ot.data.items.length === 0 ? <EmptyState title="Nothing here" description="Requests from people you approve for appear here." /> : null}
            {ot.data && ot.data.items.length > 0 ? (
              <ul className="divide-y rounded-md border" data-testid="review-overtime">
                {ot.data.items.map((r) => (
                  <OvertimeRow key={r.id} r={r} showPerson>
                    {r.canDecide ? <DecisionPanel kind="overtime" r={r} /> : null}
                  </OvertimeRow>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Onsite work</CardTitle>
            <CardDescription>Approved work is added to the person&apos;s timesheet as onsite time. It does not change their attendance.</CardDescription>
          </CardHeader>
          <CardContent>
            {os.isPending ? <LoadingState label="Loading" rows={2} /> : null}
            {os.isError ? <ErrorState error={os.error} onRetry={() => void os.refetch()} /> : null}
            {os.data && os.data.items.length === 0 ? <EmptyState title="Nothing here" /> : null}
            {os.data && os.data.items.length > 0 ? (
              <ul className="divide-y rounded-md border" data-testid="review-onsite">
                {os.data.items.map((r) => (
                  <OnsiteRow key={r.id} r={r} showPerson>
                    {r.canDecide ? <DecisionPanel kind="onsite" r={r} /> : null}
                  </OnsiteRow>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
