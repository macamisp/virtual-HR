'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { minutesLabel } from '@/components/tasks/badges';
import { TaskViewsNav } from '@/components/tasks/task-views-nav';
import { Permission, useCan } from '@/lib/permissions';
import { useWorkload } from '@/lib/planning-queries';
import { addDays, formatWorkDate, toWorkDate } from '@/lib/format';
import { cn } from '@/lib/utils';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** FR-TASK-005 team workload (team-lead scope; HR sees everyone). */
export default function WorkloadPage() {
  const allowed = useCan(Permission.TASKS_READ_TEAM);
  const [start, setStart] = useState<string | undefined>(undefined);
  const workload = useWorkload(start, allowed);
  const current = workload.data?.weekStart;
  const shift = (weeks: number) => {
    if (!current) return;
    const [y, m, d] = current.split('-').map(Number);
    setStart(toWorkDate(addDays(new Date(y!, m! - 1, d!), weeks * 7)));
  };

  if (!allowed) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Team workload</h1>
        <AccessDenied what="Team workload" />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Team workload{current ? ` · week of ${formatWorkDate(current)}` : ''}</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => shift(-1)} disabled={!current}><ChevronLeft aria-hidden="true" />Previous week</Button>
          <Button variant="outline" size="sm" onClick={() => setStart(undefined)}>This week</Button>
          <Button variant="outline" size="sm" onClick={() => shift(1)} disabled={!current}>Next week<ChevronRight aria-hidden="true" /></Button>
        </div>
      </div>
      <TaskViewsNav />
      {workload.isPending ? <LoadingState label="Loading workload" rows={5} /> : null}
      {workload.isError ? <ErrorState error={workload.error} onRetry={() => void workload.refetch()} /> : null}
      {workload.data && workload.data.people.length === 0 ? <EmptyState title="No one in your team scope" /> : null}
      {workload.data && workload.data.people.length > 0 ? (
        <Table data-testid="workload">
          <TableHeader>
            <TableRow>
              <TableHead>Person</TableHead>
              <TableHead>Scheduled / capacity</TableHead>
              {DAYS.map((d) => <TableHead key={d} className="text-right">{d}</TableHead>)}
              <TableHead className="text-right">Open</TableHead>
              <TableHead className="text-right">Overdue</TableHead>
              <TableHead>Today</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {workload.data.people.map((p) => {
              const over = p.scheduledMinutes > p.capacityMinutes;
              const pct = p.capacityMinutes ? Math.min(100, Math.round((p.scheduledMinutes / p.capacityMinutes) * 100)) : 0;
              return (
                <TableRow key={p.user.id} data-testid={`workload-${p.user.email}`}>
                  <TableCell>
                    <span className="font-medium">{p.user.displayName ?? p.user.email}</span>
                    <span className="block text-xs text-muted-foreground">{p.user.role.toLowerCase()}</span>
                  </TableCell>
                  <TableCell className="min-w-[10rem]">
                    <div role="meter" aria-label={`${p.user.displayName ?? p.user.email} scheduled hours`} aria-valuemin={0} aria-valuemax={p.capacityMinutes}
                      aria-valuenow={p.scheduledMinutes} aria-valuetext={`${minutesLabel(p.scheduledMinutes)} of ${minutesLabel(p.capacityMinutes)}`}
                      className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div className={cn('h-full', over ? 'bg-destructive' : 'bg-primary')} style={{ width: `${pct}%` }} />
                    </div>
                    <span className={cn('text-xs tabular-nums', over && 'font-medium text-destructive')}>
                      {minutesLabel(p.scheduledMinutes)} / {minutesLabel(p.capacityMinutes)}{over ? ' · over' : ''}
                    </span>
                  </TableCell>
                  {p.perDayMinutes.map((m, i) => <TableCell key={i} className="text-right tabular-nums text-xs">{m ? minutesLabel(m) : '—'}</TableCell>)}
                  <TableCell className="text-right tabular-nums">{p.openTasks}</TableCell>
                  <TableCell className={cn('text-right tabular-nums', p.overdueTasks > 0 && 'font-medium text-destructive')}>{p.overdueTasks}</TableCell>
                  <TableCell className="space-x-1">
                    {p.eodSubmittedToday ? <Badge variant="success">Report in</Badge> : <Badge variant="outline">No report yet</Badge>}
                    {p.pendingAcceptance > 0 ? <Badge variant="warning">{p.pendingAcceptance} awaiting acceptance</Badge> : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : null}
    </div>
  );
}
