'use client';

import Link from 'next/link';
import { useState } from 'react';
import { TIMESHEET_STATUSES } from '@hrvo/shared';
import type { TimesheetSummary } from '@hrvo/shared';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { STATUS_LABEL, TimesheetStatusBadge, periodLabel } from '@/components/timesheets/timesheet-view';
import { minutesLabel } from '@/components/tasks/badges';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Permission, useCan } from '@/lib/permissions';
import { useTimesheets } from '@/lib/timesheet-queries';

function SheetTable({ items, testId }: { items: TimesheetSummary[]; testId: string }) {
  return (
    <div className="overflow-x-auto">
      <Table data-testid={testId}>
        <TableHeader>
          <TableRow>
            <TableHead>Person</TableHead>
            <TableHead>Period</TableHead>
            <TableHead className="text-right">Attendance</TableHead>
            <TableHead className="text-right">Logged</TableHead>
            <TableHead className="text-right">Flagged days</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((s) => (
            <TableRow key={s.id}>
              <TableCell>
                <Link href={`/timesheets/${s.id}`} className="text-primary underline-offset-4 hover:underline">{s.user.displayName ?? s.user.email}</Link>
              </TableCell>
              <TableCell>{periodLabel(s.periodStart, s.periodEnd)}</TableCell>
              <TableCell className="text-right tabular-nums">{minutesLabel(s.attendanceMinutes)}</TableCell>
              <TableCell className="text-right tabular-nums">{minutesLabel(s.loggedMinutes)}</TableCell>
              <TableCell className="text-right tabular-nums">{s.flaggedDays}</TableCell>
              <TableCell className="text-right tabular-nums">{s.amount ? `${s.currency} ${s.amount}` : '—'}</TableCell>
              <TableCell><TimesheetStatusBadge status={s.status} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** FR-TS-006: approvers see submitted timesheets in scope; HR and Finance/Auditor browse all. */
export default function ReviewTimesheetsPage() {
  const approveTeam = useCan(Permission.TIMESHEETS_APPROVE_TEAM);
  const approveAll = useCan(Permission.TIMESHEETS_APPROVE_ALL);
  const readAll = useCan(Permission.TIMESHEETS_READ_ALL);
  const canApprove = approveTeam || approveAll;
  const scope = approveAll || readAll ? 'all' : 'team';
  const queue = useTimesheets({ scope, status: 'SUBMITTED' }, canApprove);
  const [status, setStatus] = useState('');
  const browse = useTimesheets({ scope, status: status || undefined }, canApprove || readAll);

  if (!canApprove && !readAll) return <AccessDenied what="Timesheet review" />;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Review timesheets</h1>
      {canApprove ? (
        <Card>
          <CardHeader><CardTitle className="text-base">Waiting for your approval</CardTitle></CardHeader>
          <CardContent>
            {queue.isPending ? <LoadingState label="Loading approvals" rows={2} /> : null}
            {queue.isError ? <ErrorState error={queue.error} onRetry={() => void queue.refetch()} /> : null}
            {queue.data ? (
              queue.data.items.length === 0
                ? <EmptyState title="Nothing to approve" description="Submitted timesheets from your team appear here." />
                : <SheetTable items={queue.data.items} testId="approval-queue" />
            ) : null}
            <p className="mt-2 text-xs text-muted-foreground">You never approve your own timesheet; yours goes to your manager.</p>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-3">
          <CardTitle className="text-base">{scope === 'all' ? 'All timesheets' : 'Team timesheets'}</CardTitle>
          <div className="space-y-1">
            <Label htmlFor="status-filter">Status</Label>
            <NativeSelect id="status-filter" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any</option>
              {TIMESHEET_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </NativeSelect>
          </div>
        </CardHeader>
        <CardContent>
          {browse.isPending ? <LoadingState label="Loading timesheets" rows={3} /> : null}
          {browse.isError ? <ErrorState error={browse.error} onRetry={() => void browse.refetch()} /> : null}
          {browse.data ? (
            browse.data.items.length === 0 ? <EmptyState title="No timesheets match" /> : <SheetTable items={browse.data.items} testId="all-timesheets" />
          ) : null}
          {readAll && !canApprove ? <p className="mt-2 text-xs text-muted-foreground">Read-only access: you can view and export, not change.</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
