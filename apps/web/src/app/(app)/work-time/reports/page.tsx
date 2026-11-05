'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Lightbulb } from 'lucide-react';
import { WorkTimeReportSchema } from '@hrvo/shared';
import type { WorkTimeReport, WorkTimeTaskRow } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { ActivityNote, WorkTimeNav } from '@/components/work-time/work-time-nav';
import { minutesLabel } from '@/components/tasks/badges';
import { Permission, useCan } from '@/lib/permissions';
import { apiDownload, apiFetch, saveBlob } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { addDays, toWorkDate } from '@/lib/format';

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold tabular-nums">{value}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function Buckets({ title, rows }: { title: string; rows: WorkTimeReport['projects'] }) {
  const total = rows.reduce((n, r) => n + r.minutes, 0);
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No task time in this range.</p> : (
          <ul className="space-y-1 text-sm">
            {rows.map((r) => (
              <li key={r.key} className="flex justify-between gap-2">
                <span className="truncate">{r.label}</span>
                <span className="tabular-nums text-muted-foreground">{minutesLabel(r.minutes)} · {total ? Math.round((r.minutes * 100) / total) : 0}%</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function TaskTable({ rows, testId }: { rows: WorkTimeTaskRow[]; testId: string }) {
  return (
    <div className="overflow-x-auto">
      <Table data-testid={testId}>
        <TableHeader>
          <TableRow>
            <TableHead>Task</TableHead>
            <TableHead className="text-right">In range</TableHead>
            <TableHead className="text-right">Estimate</TableHead>
            <TableHead className="text-right">Actual</TableHead>
            <TableHead className="text-right">Remaining</TableHead>
            <TableHead className="text-right">Of estimate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((t) => (
            <TableRow key={t.taskId}>
              <TableCell><span className="block">{t.title}</span>{t.projectName ? <span className="text-xs text-muted-foreground">{t.projectName}</span> : null}</TableCell>
              <TableCell className="text-right tabular-nums">{minutesLabel(t.minutesInRange)}</TableCell>
              <TableCell className="text-right tabular-nums">{t.estimateMinutes === null ? '—' : minutesLabel(t.estimateMinutes)}</TableCell>
              <TableCell className="text-right tabular-nums">{minutesLabel(t.actualMinutes)}</TableCell>
              <TableCell className="text-right tabular-nums">{t.remainingMinutes === null ? '—' : minutesLabel(t.remainingMinutes)}</TableCell>
              <TableCell className="text-right tabular-nums">{t.percentOfEstimate === null ? '—' : `${t.percentOfEstimate}%`}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** ADR 049 §5 (FR-WT-019..021): work-time analytics for me or, in scope, my team. */
export default function WorkTimeReportPage() {
  const canUse = useCan(Permission.TIMESHEETS_USE);
  const team = useCan(Permission.REPORTS_TEAM);
  const all = useCan(Permission.REPORTS_ALL);
  const signedIn = useAuthStore((s) => s.status === 'authenticated');
  const [from, setFrom] = useState(() => toWorkDate(addDays(new Date(), -27)));
  const [to, setTo] = useState(() => toWorkDate(new Date()));
  const [scope, setScope] = useState<'me' | 'team'>(canUse ? 'me' : 'team');
  const [exportError, setExportError] = useState<string | null>(null);
  const q = `from=${from}&to=${to}&scope=${scope}`;
  const report = useQuery({
    queryKey: ['work-time-report', q],
    queryFn: () => apiFetch(`/reports/work-time?${q}`, { schema: WorkTimeReportSchema }),
    enabled: signedIn && (canUse || team || all) && from <= to,
  });
  if (!canUse && !team && !all) return <AccessDenied what="Work-time report" />;
  const r = report.data;
  const download = async (format: 'csv' | 'xlsx') => {
    setExportError(null);
    try {
      const f = await apiDownload(`/reports/work-time?${q}&format=${format}`);
      saveBlob(f.blob, f.filename);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Export failed');
    }
  };
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Work-time report</h1>
        <WorkTimeNav />
        <Alert>
          <AlertDescription>
            These figures come from server records: attendance, calls with other people, and time entries. They show where time went, to help plan
            estimates and meetings. They do not measure the quality or value of anyone&apos;s work, and a low or high number is not a judgement.
          </AlertDescription>
        </Alert>
      </div>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()} aria-label="Report filters">
        <div className="space-y-1.5"><Label htmlFor="wt-from">From</Label><Input id="wt-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="space-y-1.5"><Label htmlFor="wt-to">To</Label><Input id="wt-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></div>
        {team || all ? (
          <div className="space-y-1.5">
            <Label htmlFor="wt-scope">For</Label>
            <NativeSelect id="wt-scope" className="w-48" value={scope} onChange={(e) => setScope(e.target.value as 'me' | 'team')}>
              {canUse ? <option value="me">Me</option> : null}
              <option value="team">{all ? 'Everyone I report on' : 'My team'}</option>
            </NativeSelect>
          </div>
        ) : null}
        <Button type="button" variant="outline" onClick={() => void download('csv')} disabled={!r}><Download aria-hidden="true" /> CSV</Button>
        <Button type="button" variant="outline" onClick={() => void download('xlsx')} disabled={!r}><Download aria-hidden="true" /> Excel</Button>
      </form>
      {exportError ? <Alert variant="destructive"><AlertDescription>{exportError}</AlertDescription></Alert> : null}
      {report.isPending ? <LoadingState label="Loading report" rows={4} /> : null}
      {report.isError ? <ErrorState error={report.error} onRetry={() => void report.refetch()} /> : null}
      {r ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" data-testid="wt-totals">
            <Tile label="Attended" value={minutesLabel(r.totals.attendanceMinutes)} hint={r.scope === 'team' ? `${r.people} people` : undefined} />
            <Tile label="In meetings" value={minutesLabel(r.totals.meetingMinutes)} hint="calls with other people" />
            <Tile label="Task time" value={minutesLabel(r.totals.taskMinutes)} hint={`${minutesLabel(r.totals.manualMinutes)} manual · ${minutesLabel(r.totals.onsiteMinutes)} onsite`} />
            <Tile label="Focused task time" value={minutesLabel(r.totals.focusedTaskMinutes)} hint="task time outside meetings" />
            <Tile label="Task time during meetings" value={minutesLabel(r.totals.taskDuringMeetingsMinutes)} hint="counted once" />
          </div>
          {r.insights.length ? (
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Lightbulb className="h-4 w-4" aria-hidden="true" /> Observations for planning</CardTitle></CardHeader>
              <CardContent><ul className="list-disc space-y-1 pl-5 text-sm" data-testid="wt-insights">{r.insights.map((i) => <li key={i}>{i}</li>)}</ul></CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Estimated vs actual, by task</CardTitle>
              <CardDescription>Tasks with time in this range. Actual is all time recorded on the task.</CardDescription>
            </CardHeader>
            <CardContent>{r.tasks.length ? <TaskTable rows={r.tasks} testId="wt-tasks" /> : <EmptyState title="No task time in this range" />}</CardContent>
          </Card>
          <div className="grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
            <Buckets title="By project" rows={r.projects} />
            <Buckets title="By kind of work" rows={r.categories} />
            <Buckets title="By place" rows={r.workTypes} />
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Over estimate</CardTitle>
              <CardDescription>
                {r.overEstimate.completedTasks
                  ? `${r.overEstimate.completedOverEstimate} of ${r.overEstimate.completedTasks} tasks completed in this range with an estimate took longer than estimated.`
                  : 'No tasks with an estimate were completed in this range.'}
              </CardDescription>
            </CardHeader>
            <CardContent>{r.overEstimate.tasks.length ? <TaskTable rows={r.overEstimate.tasks} testId="wt-over" /> : <p className="text-sm text-muted-foreground">No task is over its estimate.</p>}</CardContent>
          </Card>
          <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
            {([['Weekly', r.weekly, 'Week of '], ['Monthly', r.monthly, '']] as const).map(([title, rows, prefix]) => (
              <Card key={title}>
                <CardHeader><CardTitle className="text-base">{title} trend</CardTitle></CardHeader>
                <CardContent className="overflow-x-auto">
                  {rows.length === 0 ? <p className="text-sm text-muted-foreground">No data.</p> : (
                    <Table>
                      <TableHeader><TableRow><TableHead>Period</TableHead><TableHead className="text-right">Attended</TableHead><TableHead className="text-right">Meetings</TableHead><TableHead className="text-right">Tasks</TableHead><TableHead className="text-right">Focused</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {rows.map((w) => (
                          <TableRow key={w.period}>
                            <TableCell>{prefix}{w.period}</TableCell>
                            <TableCell className="text-right tabular-nums">{minutesLabel(w.attendanceMinutes)}</TableCell>
                            <TableCell className="text-right tabular-nums">{minutesLabel(w.meetingMinutes)}</TableCell>
                            <TableCell className="text-right tabular-nums">{minutesLabel(w.taskMinutes)}</TableCell>
                            <TableCell className="text-right tabular-nums">{minutesLabel(w.focusedTaskMinutes)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
          <ActivityNote />
        </>
      ) : null}
    </div>
  );
}
