'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download } from 'lucide-react';
import type { AnalyticsGroup } from '@hrvo/shared';
import { EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiDownload, saveBlob } from '@/lib/api';
import { analyticsQuery, useAttendanceAnalytics } from '@/lib/report-queries';
import type { AnalyticsFilters } from '@/lib/report-queries';
import { AnalyticsDefinitions, PRESET_LABEL, PRESETS, presetRange, Stat, StatusCell, clock, dur, periodLabel } from './shared';
import type { Preset } from './shared';

type SortKey = AnalyticsFilters['sort'];
const COLUMNS: Array<{ label: string; sort?: SortKey; numeric?: boolean }> = [
  { label: 'Employee', sort: 'name' }, { label: 'Team' }, { label: 'Date', sort: 'date' }, { label: 'First check-in' }, { label: 'Last check-out' },
  { label: 'Work attendance', sort: 'work', numeric: true }, { label: 'Office connected', sort: 'office', numeric: true }, { label: 'Meeting time', sort: 'meeting', numeric: true }, { label: 'Status' },
];

/**
 * FR-REP-009 (ADR 059): the HR attendance analytics tab. Everyone the viewer may see (their
 * existing report scope); filters, grouping, sorting and paging run on the server. Export buttons
 * show only for people allowed to export attendance.
 */
export function AttendanceAnalyticsTab() {
  const [preset, setPreset] = useState<Preset>('this-week');
  const [f, setF] = useState<AnalyticsFilters>({ ...presetRange('this-week'), groupBy: 'day', sort: 'date', dir: 'desc', page: 1, pageSize: 25 });
  const set = (patch: Partial<AnalyticsFilters>) => setF((x) => ({ ...x, page: 1, ...patch }));
  useEffect(() => { if (preset !== 'custom') setF((x) => ({ ...x, page: 1, ...presetRange(preset) })); }, [preset]);
  const r = useAttendanceAnalytics(f, true);
  const sortBy = (k: SortKey) => set({ sort: k, dir: f.sort === k && f.dir === 'desc' ? 'asc' : 'desc' });
  const data = r.data;
  const pages = data ? Math.max(1, Math.ceil(data.totalRows / data.pageSize)) : 1;

  return (
    <div className="space-y-4" data-testid="analytics-tab">
      <Card><CardContent className="flex flex-wrap items-end justify-between gap-3 p-4">
        <form className="flex flex-wrap items-end gap-3" aria-label="Analytics filters" onSubmit={(e) => e.preventDefault()}>
          <div className="space-y-1"><Label htmlFor="a-preset">Period</Label>
            <NativeSelect id="a-preset" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>{PRESETS.map((p) => <option key={p} value={p}>{PRESET_LABEL[p]}</option>)}</NativeSelect></div>
          {preset === 'custom' ? (
            <>
              <div className="space-y-1"><Label htmlFor="a-from">From</Label><Input id="a-from" type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} /></div>
              <div className="space-y-1"><Label htmlFor="a-to">To</Label><Input id="a-to" type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} /></div>
            </>
          ) : null}
          <div className="space-y-1"><Label htmlFor="a-team">Team</Label>
            <NativeSelect id="a-team" value={f.teamId ?? ''} onChange={(e) => set({ teamId: e.target.value || undefined, userId: undefined })}>
              <option value="">All teams</option>{data?.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </NativeSelect></div>
          <div className="space-y-1"><Label htmlFor="a-person">Person</Label>
            <NativeSelect id="a-person" value={f.userId ?? ''} onChange={(e) => set({ userId: e.target.value || undefined })}>
              <option value="">Everyone</option>{data?.people.filter((p) => !f.teamId || p.teamId === f.teamId).map((p) => <option key={p.id} value={p.id}>{p.displayName ?? p.email}</option>)}
            </NativeSelect></div>
          <div className="space-y-1"><Label htmlFor="a-group">Group by</Label>
            <NativeSelect id="a-group" value={f.groupBy} onChange={(e) => set({ groupBy: e.target.value as AnalyticsGroup })}>
              <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
            </NativeSelect></div>
        </form>
        {data?.canExport ? <ExportButtons f={f} /> : null}
      </CardContent></Card>
      {f.from > f.to ? <Alert variant="destructive"><AlertDescription>“From” must not be after “To”.</AlertDescription></Alert> : null}
      <AnalyticsDefinitions retentionDays={data?.retentionDays} />
      {r.isPending && f.from <= f.to ? <LoadingState label="Loading attendance analytics" rows={5} /> : null}
      {r.isError ? <ErrorState error={r.error} onRetry={() => void r.refetch()} /> : null}
      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="analytics-summary">
            <Stat label="People present" value={`${data.summary.peoplePresent} of ${data.summary.people}`} hint={`${data.summary.daysWorked} days worked`} testId="stat-present" />
            <Stat label="Average work attendance" value={dur(data.summary.averageWorkSeconds)} hint="per day worked" testId="stat-average" />
            <Stat label="Meeting time" value={dur(data.summary.meetingSeconds)} hint={`${data.summary.meetingSharePct}% of work attendance`} testId="stat-meetings" />
            <Stat label="Attendance status" value={`${data.summary.statusCounts.LATE ?? 0} late · ${data.summary.statusCounts.ABSENT ?? 0} absent`}
              hint={`${data.summary.statusCounts.LEAVE ?? 0} on leave · ${data.summary.statusCounts.IN_PROGRESS ?? 0} in progress`} testId="stat-status" />
          </div>
          {data.officeDataFrom > data.from ? <p className="text-sm text-muted-foreground" data-testid="office-retention-note">Office connection times before {data.officeDataFrom} have been deleted (kept {data.retentionDays} days).</p> : null}
          {data.rows.length === 0 ? (
            <EmptyState title="No attendance in this period" description="Nobody in your scope has attendance or office time in these dates. Try another period or filter." />
          ) : (
            <Card><CardContent className="overflow-x-auto p-0">
              <Table data-testid="analytics-table" aria-label={`Attendance analytics, ${periodLabel(data.from, 'day')} to ${periodLabel(data.to, 'day')}`}>
                <TableHeader><TableRow>{COLUMNS.map((c) => (
                  <TableHead key={c.label} className={c.numeric ? 'text-right' : undefined} aria-sort={c.sort && f.sort === c.sort ? (f.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {c.sort ? (
                      <button type="button" className="inline-flex items-center gap-1 rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => sortBy(c.sort!)}>
                        {c.label}{f.sort === c.sort ? (f.dir === 'asc' ? <ArrowUp aria-hidden="true" className="h-3 w-3" /> : <ArrowDown aria-hidden="true" className="h-3 w-3" />) : null}
                      </button>
                    ) : c.label}
                  </TableHead>
                ))}</TableRow></TableHeader>
                <TableBody>{data.rows.map((x) => (
                  <TableRow key={`${x.user.id}|${x.period}`}>
                    <TableCell className="font-medium">
                      <Link className="underline-offset-2 hover:underline" href={`/reports/attendance-analytics/${x.user.id}?from=${data.from}&to=${data.to}`}>{x.user.displayName ?? x.user.email}</Link>
                    </TableCell>
                    <TableCell>{x.user.teamName ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap">{periodLabel(x.period, f.groupBy)}</TableCell>
                    <TableCell className="tabular-nums">{clock(x.firstIn, data.timezone)}</TableCell>
                    <TableCell className="tabular-nums">{x.status === 'IN_PROGRESS' ? 'Still in' : clock(x.lastOut, data.timezone)}</TableCell>
                    <TableCell className="text-right tabular-nums">{dur(x.workSeconds)}</TableCell>
                    <TableCell className="text-right tabular-nums">{dur(x.officeSeconds)}</TableCell>
                    <TableCell className="text-right tabular-nums">{dur(x.meetingSeconds)}</TableCell>
                    <TableCell><StatusCell row={x} /></TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            </CardContent></Card>
          )}
          <nav className="flex items-center justify-between gap-2 text-sm" aria-label="Pages">
            <span data-testid="analytics-count">{data.totalRows} row{data.totalRows === 1 ? '' : 's'} · page {data.page} of {pages} · times in {data.timezone}</span>
            <span className="flex gap-2">
              <Button variant="outline" size="sm" disabled={f.page <= 1} onClick={() => setF((x) => ({ ...x, page: x.page - 1 }))}><ChevronLeft aria-hidden="true" /> Previous</Button>
              <Button variant="outline" size="sm" disabled={f.page >= pages} onClick={() => setF((x) => ({ ...x, page: x.page + 1 }))}>Next <ChevronRight aria-hidden="true" /></Button>
            </span>
          </nav>
        </>
      ) : null}
    </div>
  );
}

function ExportButtons({ f }: { f: AnalyticsFilters }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const download = async (format: 'csv' | 'xlsx' | 'pdf') => {
    setBusy(format);
    setError(null);
    try {
      const file = await apiDownload(`/reports/attendance-analytics?${analyticsQuery(f, format)}`);
      saveBlob(file.blob, file.filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="analytics-export">
      {(['csv', 'xlsx', 'pdf'] as const).map((fmt) => (
        <Button key={fmt} variant="outline" size="sm" disabled={busy !== null} onClick={() => void download(fmt)}><Download aria-hidden="true" /> {busy === fmt ? 'Preparing…' : fmt.toUpperCase()}</Button>
      ))}
      {error ? <span role="alert" className="text-sm text-destructive">{error}</span> : null}
    </div>
  );
}
