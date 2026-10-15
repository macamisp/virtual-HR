'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { minutesLabel } from '@/components/tasks/badges';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiDownload, saveBlob } from '@/lib/api';
import { addDays, startOfWeek, toWorkDate } from '@/lib/format';
import { Permission, useCan } from '@/lib/permissions';
import { reportQuery, useTimesheetReport } from '@/lib/timesheet-queries';
import type { ReportFilters } from '@/lib/timesheet-queries';

const GROUP_LABEL = { user: 'Person', project: 'Project', team: 'Team', period: 'Period' } as const;

function signed(m: number): string {
  return m === 0 ? '0m' : `${m > 0 ? '+' : '−'}${minutesLabel(Math.abs(m))}`;
}

/** FR-TS-013: hours, approved hours, variance, cost and approval turnaround, with CSV / XLSX export. */
export default function TimesheetReportsPage() {
  const team = useCan(Permission.TIMESHEETS_APPROVE_TEAM);
  const all = useCan(Permission.TIMESHEETS_APPROVE_ALL);
  const readAll = useCan(Permission.TIMESHEETS_READ_ALL);
  const allowed = team || all || readAll;
  const monday = startOfWeek(new Date());
  const [f, setF] = useState<ReportFilters>({ groupBy: 'user', from: toWorkDate(addDays(monday, -28)), to: toWorkDate(addDays(monday, 6)) });
  const report = useTimesheetReport(f, allowed);
  const [busy, setBusy] = useState<'csv' | 'xlsx' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  if (!allowed) return <AccessDenied what="Timesheet reports" />;

  const download = async (format: 'csv' | 'xlsx') => {
    setBusy(format);
    setExportError(null);
    try {
      const file = await apiDownload(`/timesheets/reports?${reportQuery(f, format)}`);
      saveBlob(file.blob, file.filename);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  };

  const currencies = [...new Set((report.data?.rows ?? []).flatMap((r) => Object.keys(r.cost)))].sort();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Timesheet reports</h1>
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1">
            <Label htmlFor="r-group">Group by</Label>
            <NativeSelect id="r-group" value={f.groupBy} onChange={(e) => setF({ ...f, groupBy: e.target.value as ReportFilters['groupBy'] })}>
              {(Object.keys(GROUP_LABEL) as ReportFilters['groupBy'][]).map((g) => <option key={g} value={g}>{GROUP_LABEL[g]}</option>)}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="r-from">From</Label>
            <Input id="r-from" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="r-to">To</Label>
            <Input id="r-to" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
          </div>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={() => void download('csv')} disabled={busy !== null || !report.data}>
              <Download aria-hidden="true" /> {busy === 'csv' ? 'Exporting…' : 'CSV'}
            </Button>
            <Button variant="outline" onClick={() => void download('xlsx')} disabled={busy !== null || !report.data}>
              <Download aria-hidden="true" /> {busy === 'xlsx' ? 'Exporting…' : 'Excel'}
            </Button>
          </div>
          {f.from > f.to ? <p className="w-full text-sm text-destructive" role="alert">“From” must be on or before “To”.</p> : null}
          {exportError ? <Alert variant="destructive" className="w-full"><AlertDescription>{exportError}</AlertDescription></Alert> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By {GROUP_LABEL[f.groupBy].toLowerCase()}</CardTitle>
          <CardDescription>
            Timesheets whose period overlaps the range count in full. Cost is approved amounts only, per currency. {all || readAll ? 'Whole organisation.' : 'Your team and direct reports.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {report.isPending && f.from <= f.to ? <LoadingState label="Loading report" rows={4} /> : null}
          {report.isError ? <ErrorState error={report.error} onRetry={() => void report.refetch()} /> : null}
          {report.data && report.data.rows.length === 0 ? <EmptyState title="No timesheets in this range" /> : null}
          {report.data && report.data.rows.length > 0 ? (
            <Table data-testid="timesheet-report">
              <TableHeader>
                <TableRow>
                  <TableHead>{GROUP_LABEL[f.groupBy]}</TableHead>
                  <TableHead className="text-right">Timesheets</TableHead>
                  {f.groupBy !== 'project' ? <TableHead className="text-right">Attendance</TableHead> : null}
                  <TableHead className="text-right">Logged</TableHead>
                  <TableHead className="text-right">Approved</TableHead>
                  {f.groupBy !== 'project' ? <TableHead className="text-right">Variance</TableHead> : null}
                  {f.groupBy !== 'project' ? <TableHead className="text-right">Flagged days</TableHead> : null}
                  {currencies.map((c) => <TableHead key={c} className="text-right">Cost {c}</TableHead>)}
                  <TableHead className="text-right">Avg approval</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.data.rows.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell>{r.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.timesheets}</TableCell>
                    {f.groupBy !== 'project' ? <TableCell className="text-right tabular-nums">{minutesLabel(r.attendanceMinutes)}</TableCell> : null}
                    <TableCell className="text-right tabular-nums">{minutesLabel(r.loggedMinutes)}</TableCell>
                    <TableCell className="text-right tabular-nums">{minutesLabel(r.approvedMinutes)}</TableCell>
                    {f.groupBy !== 'project' ? <TableCell className="text-right tabular-nums">{signed(r.varianceMinutes)}</TableCell> : null}
                    {f.groupBy !== 'project' ? <TableCell className="text-right tabular-nums">{r.flaggedDays}</TableCell> : null}
                    {currencies.map((c) => <TableCell key={c} className="text-right tabular-nums">{r.cost[c] ?? '—'}</TableCell>)}
                    <TableCell className="text-right tabular-nums">{r.avgApprovalHours === null ? '—' : `${r.avgApprovalHours} h`}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
