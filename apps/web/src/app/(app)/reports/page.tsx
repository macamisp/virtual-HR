'use client';

import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { CATEGORY_LABEL, DOCUMENT_CATEGORIES, ROLE_LABEL } from '@hrvo/shared';
import type { ComplianceRequirements, DocumentCategory, ReportFormat, UserRole } from '@hrvo/shared';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiDownload, saveBlob } from '@/lib/api';
import { addDays, startOfWeek, toWorkDate } from '@/lib/format';
import { Permission, useCan } from '@/lib/permissions';
import { reportQuery, useAttendanceReport, useComplianceReport, useComplianceRequirements, useCostReport, useSaveComplianceRequirements, useTaskReport } from '@/lib/report-queries';
import type { ReportFilters, ReportKind } from '@/lib/report-queries';

const TABS: Array<{ kind: ReportKind; label: string }> = [
  { kind: 'attendance', label: 'Attendance' },
  { kind: 'hours-cost', label: 'Hours and cost' },
  { kind: 'tasks', label: 'Tasks and workload' },
  { kind: 'compliance', label: 'Compliance' },
];
const GROUPS: Record<ReportKind, Array<[string, string]>> = {
  attendance: [['user', 'Person'], ['team', 'Team'], ['day', 'Day'], ['week', 'Week'], ['month', 'Month']],
  'hours-cost': [['user', 'Person'], ['project', 'Project'], ['month', 'Month']],
  tasks: [],
  compliance: [],
};
const h = (m: number) => (m / 60).toFixed(1);

function ExportButtons({ kind, f }: { kind: ReportKind; f: ReportFilters }) {
  const [busy, setBusy] = useState<ReportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const download = async (format: 'csv' | 'xlsx' | 'pdf') => {
    setBusy(format);
    setError(null);
    try {
      const file = await apiDownload(`/reports/${kind}?${reportQuery(kind, f, format)}`);
      saveBlob(file.blob, file.filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {(['csv', 'xlsx', 'pdf'] as const).map((fmt) => (
        <Button key={fmt} variant="outline" size="sm" disabled={busy !== null} onClick={() => void download(fmt)}><Download aria-hidden="true" /> {busy === fmt ? 'Preparing…' : fmt.toUpperCase()}</Button>
      ))}
      {error ? <span role="alert" className="text-sm text-destructive">{error}</span> : null}
    </div>
  );
}

function RequirementsEditor({ initial }: { initial: ComplianceRequirements }) {
  const save = useSaveComplianceRequirements();
  const [map, setMap] = useState<Map<UserRole, Set<DocumentCategory>>>(new Map(initial.items.map((i) => [i.role, new Set(i.categories)])));
  const [saved, setSaved] = useState(false);
  // Follow server state without remounting, so the saved confirmation stays visible.
  useEffect(() => setMap(new Map(initial.items.map((i) => [i.role, new Set(i.categories)]))), [initial]);
  const roles = (Object.keys(ROLE_LABEL) as UserRole[]).filter((r) => r !== 'SUPER_ADMIN');
  const toggle = (role: UserRole, c: DocumentCategory) => {
    const next = new Map(map);
    const set = new Set(next.get(role) ?? []);
    if (set.has(c)) set.delete(c); else set.add(c);
    next.set(role, set);
    setMap(next);
  };
  return (
    <Card data-testid="compliance-requirements">
      <CardHeader><CardTitle className="text-base">Required documents per role</CardTitle><CardDescription>A person is compliant when every required category has a document on file that has not expired.</CardDescription></CardHeader>
      <CardContent className="space-y-3 overflow-x-auto">
        <form aria-label="Required documents" onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          save.mutate({ items: [...map.entries()].filter(([, s]) => s.size > 0).map(([role, s]) => ({ role, categories: [...s] })) }, { onSuccess: () => setSaved(true) });
        }}>
          <Table>
            <TableHeader><TableRow><TableHead>Role</TableHead>{DOCUMENT_CATEGORIES.map((c) => <TableHead key={c} className="text-center text-xs">{CATEGORY_LABEL[c]}</TableHead>)}</TableRow></TableHeader>
            <TableBody>
              {roles.map((role) => (
                <TableRow key={role}>
                  <TableCell className="font-medium">{ROLE_LABEL[role]}</TableCell>
                  {DOCUMENT_CATEGORIES.map((c) => (
                    <TableCell key={c} className="text-center"><input type="checkbox" aria-label={`${ROLE_LABEL[role]}: ${CATEGORY_LABEL[c]}`} checked={map.get(role)?.has(c) ?? false} onChange={() => toggle(role, c)} /></TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3 flex items-center gap-3"><Button type="submit" size="sm" disabled={save.isPending}>Save requirements</Button>{saved ? <span className="text-sm text-muted-foreground" role="status">Requirements saved.</span> : null}</div>
        </form>
        {save.isError ? <Alert variant="destructive"><AlertDescription>{save.error.message}</AlertDescription></Alert> : null}
      </CardContent>
    </Card>
  );
}

function AttendanceTab({ f, allowed }: { f: ReportFilters; allowed: boolean }) {
  const r = useAttendanceReport(f, allowed);
  if (r.isPending) return <LoadingState label="Loading attendance report" rows={4} />;
  if (r.isError) return <ErrorState error={r.error} onRetry={() => void r.refetch()} />;
  if (r.data.rows.length === 0) return <EmptyState title="No attendance in this range" />;
  const cells = (x: typeof r.data.totals) => [x.people, x.daysPresent, x.daysLate, x.lateMinutes, x.daysEarlyLeave, x.daysAbsent, x.daysOnLeave, h(x.netMinutes), h(x.expectedMinutes), x.overtimeMinutes];
  return (
    <Card><CardContent className="overflow-x-auto p-0">
      <Table data-testid="report-table">
        <TableHeader><TableRow>{[GROUPS.attendance.find((g) => g[0] === f.groupBy)?.[1] ?? 'Person', 'People', 'Present', 'Late', 'Late (min)', 'Early leaves', 'Absent', 'On leave', 'Net (h)', 'Expected (h)', 'Overtime (min)'].map((c) => <TableHead key={c} className={c === 'Person' || c === 'Team' || c === 'Day' || c === 'Week' || c === 'Month' ? '' : 'text-right'}>{c}</TableHead>)}</TableRow></TableHeader>
        <TableBody>
          {r.data.rows.map((x) => <TableRow key={x.key}><TableCell>{x.label}</TableCell>{cells(x).map((v, i) => <TableCell key={i} className="text-right tabular-nums">{v}</TableCell>)}</TableRow>)}
          <TableRow className="font-medium"><TableCell>Total</TableCell>{cells(r.data.totals).map((v, i) => <TableCell key={i} className="text-right tabular-nums">{v}</TableCell>)}</TableRow>
        </TableBody>
      </Table>
    </CardContent></Card>
  );
}

function CostTab({ f, allowed }: { f: ReportFilters; allowed: boolean }) {
  const r = useCostReport(f, allowed);
  if (r.isPending) return <LoadingState label="Loading hours and cost" rows={4} />;
  if (r.isError) return <ErrorState error={r.error} onRetry={() => void r.refetch()} />;
  if (r.data.rows.length === 0) return <EmptyState title="No time in this range" />;
  const currencies = [...new Set(r.data.rows.flatMap((x) => Object.keys(x.cost)))].sort();
  return (
    <Card><CardContent className="overflow-x-auto p-0">
      <Table data-testid="report-table">
        <TableHeader><TableRow><TableHead>{GROUPS['hours-cost'].find((g) => g[0] === f.groupBy)?.[1]}</TableHead><TableHead className="text-right">People</TableHead><TableHead className="text-right">Logged (h)</TableHead><TableHead className="text-right">Billable (h)</TableHead><TableHead className="text-right">Approved (h)</TableHead>{currencies.map((c) => <TableHead key={c} className="text-right">Cost {c}</TableHead>)}</TableRow></TableHeader>
        <TableBody>{r.data.rows.map((x) => (
          <TableRow key={x.key}><TableCell>{x.label}</TableCell><TableCell className="text-right tabular-nums">{x.people}</TableCell><TableCell className="text-right tabular-nums">{h(x.loggedMinutes)}</TableCell><TableCell className="text-right tabular-nums">{h(x.billableMinutes)}</TableCell><TableCell className="text-right tabular-nums">{h(x.approvedMinutes)}</TableCell>{currencies.map((c) => <TableCell key={c} className="text-right tabular-nums">{x.cost[c] ?? '—'}</TableCell>)}</TableRow>
        ))}</TableBody>
      </Table>
    </CardContent></Card>
  );
}

function TasksTab({ f, allowed }: { f: ReportFilters; allowed: boolean }) {
  const r = useTaskReport(f, allowed);
  if (r.isPending) return <LoadingState label="Loading task report" rows={4} />;
  if (r.isError) return <ErrorState error={r.error} onRetry={() => void r.refetch()} />;
  if (r.data.rows.length === 0) return <EmptyState title="Nobody in scope" />;
  return (
    <Card>
      <CardHeader><CardDescription>Load index compares each person&apos;s remaining estimate with the scope average ({h(r.data.averageRemainingEstimateMinutes)} h): above 1.5 is heavy, below 0.5 is light.</CardDescription></CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table data-testid="report-table">
          <TableHeader><TableRow>{['Person', 'Open', 'In progress', 'Blocked', 'Completed', 'On time', 'Overdue', 'Remaining (h)', 'Estimate (h)', 'Actual (h)', 'Load'].map((c) => <TableHead key={c} className={c === 'Person' ? '' : 'text-right'}>{c}</TableHead>)}</TableRow></TableHeader>
          <TableBody>{r.data.rows.map((x) => (
            <TableRow key={x.user.id}>
              <TableCell>{x.user.displayName ?? x.user.email}{x.user.teamName ? <div className="text-xs text-muted-foreground">{x.user.teamName}</div> : null}</TableCell>
              {[x.open, x.inProgress, x.blocked, x.completed, x.completedOnTime].map((v, i) => <TableCell key={i} className="text-right tabular-nums">{v}</TableCell>)}
              <TableCell className={`text-right tabular-nums ${x.overdue > 0 ? 'text-destructive' : ''}`}>{x.overdue}</TableCell>
              <TableCell className="text-right tabular-nums">{h(x.remainingEstimateMinutes)}</TableCell><TableCell className="text-right tabular-nums">{h(x.estimateMinutes)}</TableCell><TableCell className="text-right tabular-nums">{h(x.actualMinutes)}</TableCell>
              <TableCell className="text-right"><Badge variant={x.loadIndex > 1.5 ? 'destructive' : x.loadIndex < 0.5 ? 'secondary' : 'outline'}>{x.loadIndex.toFixed(2)}</Badge></TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ComplianceTab({ f, allowed }: { f: ReportFilters; allowed: boolean }) {
  const r = useComplianceReport(f, allowed);
  const reqs = useComplianceRequirements(allowed && !!r.data?.canEditRequirements);
  if (r.isPending) return <LoadingState label="Loading compliance report" rows={4} />;
  if (r.isError) return <ErrorState error={r.error} onRetry={() => void r.refetch()} />;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground" data-testid="compliance-summary">{r.data.summary.compliant} of {r.data.summary.people} compliant · {r.data.summary.withMissing} missing documents · {r.data.summary.withExpired} with expired documents · onboarding status is not available in this release.</p>
      {r.data.rows.length === 0 ? <EmptyState title="Nobody to show" description={f.onlyIssues ? 'Everyone in scope is compliant.' : undefined} /> : (
        <Card><CardContent className="overflow-x-auto p-0">
          <Table data-testid="report-table">
            <TableHeader><TableRow><TableHead>Person</TableHead><TableHead>Role</TableHead><TableHead>Status</TableHead><TableHead>Missing</TableHead><TableHead>Expired</TableHead><TableHead>Expiring within 30 days</TableHead></TableRow></TableHeader>
            <TableBody>{r.data.rows.map((x) => (
              <TableRow key={x.user.id}>
                <TableCell>{x.user.displayName ?? x.user.email}</TableCell>
                <TableCell>{ROLE_LABEL[x.role as UserRole] ?? x.role}</TableCell>
                <TableCell>{x.compliant ? <Badge variant="success">Compliant</Badge> : <Badge variant="destructive">Action needed</Badge>}</TableCell>
                <TableCell>{x.missing.length ? x.missing.map((c) => CATEGORY_LABEL[c]).join(', ') : '—'}</TableCell>
                <TableCell>{x.expired.length ? x.expired.map((d) => `${d.title} (${d.expiredOn})`).join(', ') : '—'}</TableCell>
                <TableCell>{x.expiringSoon.length ? x.expiringSoon.map((d) => `${d.title} (${d.expiresOn})`).join(', ') : '—'}</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        </CardContent></Card>
      )}
      {r.data.canEditRequirements && reqs.data ? <RequirementsEditor initial={reqs.data} /> : null}
    </div>
  );
}

/** FR-REP-002..006: attendance, hours and cost, tasks and compliance, each exportable; scope by role (FR-REP-008). */
export default function ReportsPage() {
  const team = useCan(Permission.REPORTS_TEAM);
  const all = useCan(Permission.REPORTS_ALL);
  const allowed = team || all;
  const monday = startOfWeek(new Date());
  const [kind, setKind] = useState<ReportKind>('attendance');
  const [f, setF] = useState<ReportFilters>({ groupBy: 'user', from: toWorkDate(addDays(monday, -28)), to: toWorkDate(addDays(monday, 6)) });
  useEffect(() => setF((x) => ({ ...x, groupBy: GROUPS[kind][0]?.[0] })), [kind]);
  if (!allowed) return <AccessDenied what="Reports" />;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Reports</h1>
      <div role="tablist" aria-label="Report" className="flex flex-wrap gap-1 border-b">
        {TABS.map((t) => (
          <button key={t.kind} role="tab" type="button" aria-selected={kind === t.kind} onClick={() => setKind(t.kind)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${kind === t.kind ? 'border-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>{t.label}</button>
        ))}
      </div>
      <Card><CardContent className="flex flex-wrap items-end justify-between gap-3 p-4">
        <form className="flex flex-wrap items-end gap-3" aria-label="Filters" onSubmit={(e) => e.preventDefault()}>
          {kind !== 'compliance' ? (
            <>
              <div className="space-y-1"><Label htmlFor="r-from">From</Label><Input id="r-from" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></div>
              <div className="space-y-1"><Label htmlFor="r-to">To</Label><Input id="r-to" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>
            </>
          ) : (
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!f.onlyIssues} onChange={(e) => setF({ ...f, onlyIssues: e.target.checked })} /> Only people with findings</label>
          )}
          {GROUPS[kind].length > 0 ? (
            <div className="space-y-1"><Label htmlFor="r-group">Group by</Label>
              <NativeSelect id="r-group" value={f.groupBy ?? ''} onChange={(e) => setF({ ...f, groupBy: e.target.value })}>{GROUPS[kind].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</NativeSelect></div>
          ) : null}
        </form>
        <ExportButtons kind={kind} f={f} />
      </CardContent></Card>
      {f.from > f.to && kind !== 'compliance' ? <Alert variant="destructive"><AlertDescription>“From” must not be after “To”.</AlertDescription></Alert> : null}
      <div role="tabpanel">
        {kind === 'attendance' ? <AttendanceTab f={f} allowed={allowed} /> : null}
        {kind === 'hours-cost' ? <CostTab f={f} allowed={allowed} /> : null}
        {kind === 'tasks' ? <TasksTab f={f} allowed={allowed} /> : null}
        {kind === 'compliance' ? <ComplianceTab f={f} allowed={allowed} /> : null}
      </div>
    </div>
  );
}
