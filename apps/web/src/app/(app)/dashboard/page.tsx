'use client';

import Link from 'next/link';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatClock, formatWorkDate } from '@/lib/format';
import { Permission, useCan } from '@/lib/permissions';
import { useDashboard } from '@/lib/report-queries';

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'success' | 'warning' | 'destructive' }) {
  return (
    <div className="rounded border p-3" data-testid={`stat-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${tone === 'destructive' ? 'text-destructive' : ''}`}>{value}</div>
    </div>
  );
}

/** FR-REP-001: today at a glance for the people in the viewer's scope (FR-REP-008). */
export default function DashboardPage() {
  const team = useCan(Permission.REPORTS_TEAM);
  const all = useCan(Permission.REPORTS_ALL);
  const allowed = team || all;
  const d = useDashboard(allowed);
  if (!allowed) return <AccessDenied what="The manager dashboard" />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        {d.data ? <p className="text-sm text-muted-foreground">{formatWorkDate(d.data.today)} · {d.data.scope === 'all' ? 'whole organisation' : 'my team'} · {d.data.peopleInScope} people</p> : null}
      </div>
      {d.isPending ? <LoadingState label="Loading dashboard" rows={5} /> : null}
      {d.isError ? <ErrorState error={d.error} onRetry={() => void d.refetch()} /> : null}
      {d.data ? (
        <>
          <section aria-label="Today's attendance" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="Working" value={d.data.attendance.working} tone="success" />
            <Stat label="On break" value={d.data.attendance.onBreak} />
            <Stat label="Finished" value={d.data.attendance.finished} />
            <Stat label="Not yet in" value={d.data.attendance.notYetIn} tone={d.data.attendance.notYetIn > 0 ? 'warning' : undefined} />
            <Stat label="On leave or off" value={d.data.attendance.onLeaveOrOff} />
          </section>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base">Late arrivals today</CardTitle><CardDescription>Against each person&apos;s schedule, after the grace period.</CardDescription></CardHeader>
              <CardContent className="p-0">
                {d.data.lateArrivals.length === 0 ? <div className="p-4"><EmptyState title="Nobody late" /></div> : (
                  <Table data-testid="late-arrivals">
                    <TableHeader><TableRow><TableHead>Person</TableHead><TableHead>Expected</TableHead><TableHead>Clocked in</TableHead><TableHead className="text-right">Late</TableHead></TableRow></TableHeader>
                    <TableBody>{d.data.lateArrivals.map((l) => (
                      <TableRow key={l.user.id}><TableCell>{l.user.displayName ?? l.user.email}</TableCell><TableCell>{l.expectedStart}</TableCell><TableCell>{formatClock(l.clockInAt)}</TableCell><TableCell className="text-right tabular-nums">{l.lateMinutes} min</TableCell></TableRow>
                    ))}</TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Waiting for approval</CardTitle></CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                <Link href="/timesheets/review" className="rounded border p-3 hover:bg-accent"><div className="text-xs text-muted-foreground">Timesheets</div><div className="text-2xl font-semibold tabular-nums">{d.data.pendingApprovals.timesheets}</div>{d.data.pendingApprovals.oldestSubmittedAt ? <div className="text-xs text-muted-foreground">oldest {formatWorkDate(d.data.pendingApprovals.oldestSubmittedAt.slice(0, 10))}</div> : null}</Link>
                <Link href="/corrections" className="rounded border p-3 hover:bg-accent"><div className="text-xs text-muted-foreground">Attendance corrections</div><div className="text-2xl font-semibold tabular-nums">{d.data.pendingApprovals.corrections}</div></Link>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Overdue tasks <Badge variant={d.data.overdueTaskCount > 0 ? 'destructive' : 'secondary'}>{d.data.overdueTaskCount}</Badge></CardTitle></CardHeader>
              <CardContent className="p-0">
                {d.data.overdueTasks.length === 0 ? <div className="p-4"><EmptyState title="Nothing overdue" /></div> : (
                  <Table data-testid="overdue-tasks">
                    <TableHeader><TableRow><TableHead>Task</TableHead><TableHead>Assignee</TableHead><TableHead>Due</TableHead></TableRow></TableHeader>
                    <TableBody>{d.data.overdueTasks.map((t) => (
                      <TableRow key={t.id}><TableCell><Link href={`/tasks/${t.id}`} className="text-primary underline-offset-4 hover:underline">{t.title}</Link>{t.projectName ? <div className="text-xs text-muted-foreground">{t.projectName}</div> : null}</TableCell><TableCell>{t.assignee ? t.assignee.displayName ?? t.assignee.email : '—'}</TableCell><TableCell>{formatWorkDate(t.dueDate)} <span className="text-xs text-destructive">({t.daysOverdue}d)</span></TableCell></TableRow>
                    ))}</TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Expiring within 30 days</CardTitle><CardDescription>Documents and contracts. Confidential titles are not shown.</CardDescription></CardHeader>
              <CardContent className="p-0">
                {d.data.expiring.length === 0 ? <div className="p-4"><EmptyState title="Nothing expiring soon" /></div> : (
                  <Table data-testid="expiring">
                    <TableHeader><TableRow><TableHead>Item</TableHead><TableHead>Person</TableHead><TableHead>Expires</TableHead></TableRow></TableHeader>
                    <TableBody>{d.data.expiring.map((e) => (
                      <TableRow key={`${e.kind}-${e.id}`}><TableCell><Badge variant="outline">{e.kind === 'CONTRACT' ? 'Contract' : 'Document'}</Badge> {e.kind === 'DOCUMENT' ? <Link href={`/documents/${e.id}`} className="text-primary underline-offset-4 hover:underline">{e.title}</Link> : e.title}</TableCell><TableCell>{e.user ? e.user.displayName ?? e.user.email : '—'}</TableCell><TableCell>{formatWorkDate(e.expiresOn)} <span className="text-xs text-muted-foreground">({e.daysLeft}d)</span></TableCell></TableRow>
                    ))}</TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
