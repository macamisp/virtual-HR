'use client';

import { useId, useState } from 'react';
import { AlertTriangle, Check, RotateCcw, Send, Trash2, X } from 'lucide-react';
import type { TimesheetDay, TimesheetDetail, TimesheetStatus } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/state-views';
import { minutesLabel } from '@/components/tasks/badges';
import { useAddManualEntry, useEntryMutation, useTimesheetAction } from '@/lib/timesheet-queries';
import { useTasks } from '@/lib/task-queries';
import { formatDateTime, formatWorkDate, toWorkDate } from '@/lib/format';
import { cn } from '@/lib/utils';

export const STATUS_LABEL: Record<TimesheetStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved · locked',
  REJECTED: 'Returned',
  LOCKED: 'Locked',
  PAID: 'Paid',
};

const FLAG_LABEL: Record<TimesheetDay['flags'][number], string> = {
  VARIANCE: 'Variance',
  NO_ATTENDANCE: 'No attendance',
  MANUAL_LIMIT: 'Manual over limit',
};

export function TimesheetStatusBadge({ status }: { status: TimesheetStatus }) {
  const variant = status === 'APPROVED' || status === 'PAID' ? 'success' : status === 'REJECTED' ? 'destructive' : status === 'SUBMITTED' ? 'warning' : 'secondary';
  return <Badge variant={variant} data-testid="timesheet-status">{STATUS_LABEL[status]}</Badge>;
}

function signed(m: number): string {
  return m === 0 ? '0m' : `${m > 0 ? '+' : '−'}${minutesLabel(Math.abs(m))}`;
}

export function periodLabel(start: string, end: string): string {
  return `${formatWorkDate(start)} – ${formatWorkDate(end)}`;
}

export function TimesheetView({ sheet, heading }: { sheet: TimesheetDetail; heading: string }) {
  const p = sheet.permissions;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{heading}</h1>
          <p className="text-sm text-muted-foreground">
            {sheet.user.displayName ?? sheet.user.email} · <span data-testid="timesheet-period">{periodLabel(sheet.periodStart, sheet.periodEnd)}</span>
          </p>
        </div>
        <TimesheetStatusBadge status={sheet.status} />
      </div>

      {sheet.status === 'REJECTED' && sheet.rejectionReason ? (
        <Alert variant="destructive" data-testid="rejection">
          <AlertTitle>Returned for changes</AlertTitle>
          <AlertDescription>{sheet.rejectionReason}</AlertDescription>
        </Alert>
      ) : null}
      {sheet.status === 'DRAFT' && sheet.reopenReason ? (
        <Alert><AlertTitle>Reopened</AlertTitle><AlertDescription>{sheet.reopenReason}</AlertDescription></Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="timesheet-totals">
        <Stat label="Attendance (net)" value={minutesLabel(sheet.attendanceMinutes)} />
        <Stat label="Logged on tasks" value={minutesLabel(sheet.loggedMinutes)} />
        <Stat label="Variance" value={signed(sheet.varianceMinutes)} />
        <Stat label="Flagged days" value={String(sheet.flaggedDays)} warn={sheet.flaggedDays > 0} />
      </div>

      <ActionsCard sheet={sheet} />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <DaysCard sheet={sheet} />
          <EntriesCard sheet={sheet} />
          {p.canEdit ? <ManualEntryCard sheet={sheet} /> : null}
        </div>
        <div className="space-y-4">
          <PayableCard sheet={sheet} />
          <NotesCard sheet={sheet} />
          <HistoryCard sheet={sheet} />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={cn('text-xl font-semibold tabular-nums', warn && 'text-destructive')}>{value}</p>
      </CardContent>
    </Card>
  );
}

function ActionsCard({ sheet }: { sheet: TimesheetDetail }) {
  const p = sheet.permissions;
  const act = useTimesheetAction(sheet.id);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const commentId = useId();
  if (!p.canSubmit && !p.canApprove && !p.canReopen) {
    if (sheet.status === 'SUBMITTED') return <p className="text-sm text-muted-foreground">Waiting for approval since {formatDateTime(sheet.submittedAt)}.</p>;
    if (sheet.status === 'APPROVED') {
      return <p className="text-sm text-muted-foreground">Approved by {sheet.approvedBy?.displayName ?? sheet.approvedBy?.email ?? 'an approver'} on {formatDateTime(sheet.approvedAt)}. Approved timesheets are locked.</p>;
    }
    return null;
  }
  const needText = (label: string, fn: () => void) => {
    if (comment.trim().length < 3) {
      setError(`${label} needs a short explanation.`);
      return;
    }
    setError(null);
    fn();
  };

  return (
    <Card data-testid="timesheet-actions">
      <CardContent className="space-y-3 p-4">
        {p.canSubmit ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => act.mutate({ action: 'submit', version: sheet.version })} disabled={act.isPending}>
              <Send aria-hidden="true" /> Submit for approval
            </Button>
            <span className="text-sm text-muted-foreground">Due by {formatWorkDate(sheet.submitDueDate)}. You can submit on or after the last day of the period.</span>
          </div>
        ) : null}
        {p.canApprove || p.canReopen ? (
          <div className="space-y-1.5">
            <Label htmlFor={commentId}>{p.canReopen ? 'Reason for reopening' : 'Comment to the submitter'}</Label>
            <Textarea id={commentId} value={comment} onChange={(e) => setComment(e.target.value)} aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${commentId}-err` : undefined} />
            {error ? <p id={`${commentId}-err`} className="text-xs font-medium text-destructive">{error}</p> : null}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {p.canApprove ? (
            <>
              <Button onClick={() => act.mutate({ action: 'approve', version: sheet.version, comment: comment.trim() })} disabled={act.isPending}>
                <Check aria-hidden="true" /> Approve
              </Button>
              <Button variant="destructive" disabled={act.isPending}
                onClick={() => needText('Rejecting', () => act.mutate({ action: 'reject', version: sheet.version, comment: comment.trim() }))}>
                <X aria-hidden="true" /> Reject
              </Button>
            </>
          ) : null}
          {p.canReopen ? (
            <Button variant="outline" disabled={act.isPending}
              onClick={() => needText('Reopening', () => act.mutate({ action: 'reopen', reason: comment.trim() }))}>
              <RotateCcw aria-hidden="true" /> Reopen
            </Button>
          ) : null}
        </div>
        {act.isError ? <Alert variant="destructive"><AlertDescription>{act.error.message}</AlertDescription></Alert> : null}
      </CardContent>
    </Card>
  );
}

function DaysCard({ sheet }: { sheet: TimesheetDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Days</CardTitle>
        <CardDescription>Attendance (net) against time logged on tasks. Days over {sheet.settings.variancePct}% apart are flagged.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table data-testid="timesheet-days">
          <TableHeader>
            <TableRow>
              <TableHead>Day</TableHead>
              <TableHead className="text-right">Attendance</TableHead>
              <TableHead className="text-right">Logged</TableHead>
              <TableHead className="text-right">Variance</TableHead>
              <TableHead>Flags</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sheet.days.map((d) => (
              <TableRow key={d.date} data-testid={`day-${d.date}`}>
                <TableCell>{formatWorkDate(d.date)}</TableCell>
                <TableCell className="text-right tabular-nums">{minutesLabel(d.attendanceMinutes)}</TableCell>
                <TableCell className="text-right tabular-nums">{minutesLabel(d.loggedMinutes)}</TableCell>
                <TableCell className="text-right tabular-nums">{signed(d.varianceMinutes)}{d.variancePct !== null && d.varianceMinutes !== 0 ? ` (${d.variancePct}%)` : ''}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {d.flags.map((f) => <Badge key={f} variant="warning"><AlertTriangle className="mr-1 h-3 w-3" aria-hidden="true" />{FLAG_LABEL[f]}</Badge>)}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function EntriesCard({ sheet }: { sheet: TimesheetDetail }) {
  const mutate = useEntryMutation();
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Time entries</CardTitle></CardHeader>
      <CardContent className="overflow-x-auto">
        {sheet.entries.length === 0 ? (
          <EmptyState title="No time logged in this period" description="Start a timer on a task, or add manual time below." />
        ) : (
          <Table data-testid="timesheet-entries">
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead>Task / project</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Time</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sheet.entries.map((e) => (
                <TableRow key={e.id} data-testid="entry-row" className={cn(e.flagged && 'bg-warning/10')}>
                  <TableCell>{formatWorkDate(e.workDate)}</TableCell>
                  <TableCell>
                    <span className="block">{e.taskTitle ?? e.projectName ?? <span className="text-muted-foreground">No task</span>}</span>
                    {e.taskTitle && e.projectName ? <span className="block text-xs text-muted-foreground">{e.projectName}</span> : null}
                    {e.note ? <span className="block text-xs text-muted-foreground">{e.note}</span> : null}
                  </TableCell>
                  <TableCell>
                    {e.source === 'MANUAL' ? (
                      <>
                        <Badge variant="outline">Manual</Badge>
                        <span className="mt-1 block text-xs text-muted-foreground">Reason: {e.manualReason}</span>
                      </>
                    ) : (
                      <Badge variant="secondary">{e.running ? 'Timer · running' : e.autoStopped ? 'Timer · stopped at clock-out' : 'Timer'}</Badge>
                    )}
                    {e.flagged ? <span className="mt-1 block text-xs font-medium text-destructive">Over the {minutesLabel(sheet.settings.manualLimitMinutes)} daily manual limit</span> : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{e.running ? '…' : minutesLabel(e.minutes)}</TableCell>
                  <TableCell>
                    {e.editable && !e.running ? (
                      <Button variant="ghost" size="sm" aria-label={`Delete ${minutesLabel(e.minutes)} on ${formatWorkDate(e.workDate)}`}
                        disabled={mutate.isPending} onClick={() => { if (window.confirm('Delete this time entry?')) mutate.mutate({ id: e.id, remove: true }); }}>
                        <Trash2 aria-hidden="true" />
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {mutate.isError ? <Alert variant="destructive" className="mt-3"><AlertDescription>{mutate.error.message}</AlertDescription></Alert> : null}
      </CardContent>
    </Card>
  );
}

function ManualEntryCard({ sheet }: { sheet: TimesheetDetail }) {
  const add = useAddManualEntry();
  const tasks = useTasks({ scope: 'mine', includeDone: true });
  const today = toWorkDate(new Date());
  const lastDay = sheet.periodEnd < today ? sheet.periodEnd : today;
  const [date, setDate] = useState(lastDay);
  const [hours, setHours] = useState('');
  const [mins, setMins] = useState('');
  const [taskId, setTaskId] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const ids = { date: useId(), h: useId(), m: useId(), task: useId(), reason: useId(), note: useId() };

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    const minutes = (Number(hours || 0) * 60) + Number(mins || 0);
    if (!Number.isInteger(minutes) || minutes <= 0) return setError('Enter the time in whole hours and minutes.');
    if (reason.trim().length < 3) return setError('A reason is required for manual time.');
    setError(null);
    add.mutate(
      { workDate: date, minutes, taskId: taskId || undefined, reason: reason.trim(), note, billable: true },
      {
        onSuccess: (e) => {
          setDone(e.flagged ? `Added ${minutesLabel(minutes)}. It is over the daily manual limit, so it is flagged for your approver.` : `Added ${minutesLabel(minutes)}.`);
          setHours(''); setMins(''); setReason(''); setNote('');
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add manual time</CardTitle>
        <CardDescription>For work the timer missed. Manual time is marked as such; more than {minutesLabel(sheet.settings.manualLimitMinutes)} a day is flagged.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="grid gap-3 sm:grid-cols-2" aria-label="Add manual time">
          <div className="space-y-1.5">
            <Label htmlFor={ids.date}>Day</Label>
            <Input id={ids.date} type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} aria-describedby={`${ids.date}-hint`} />
            <p id={`${ids.date}-hint`} className="text-xs text-muted-foreground">Time on another day goes into that day&apos;s timesheet.</p>
          </div>
          <div className="flex gap-2">
            <div className="space-y-1.5">
              <Label htmlFor={ids.h}>Hours</Label>
              <Input id={ids.h} inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value.replace(/\D/g, ''))} className="w-20" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.m}>Minutes</Label>
              <Input id={ids.m} inputMode="numeric" value={mins} onChange={(e) => setMins(e.target.value.replace(/\D/g, ''))} className="w-20" />
            </div>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={ids.task}>Task</Label>
            <NativeSelect id={ids.task} value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="">No task</option>
              {(tasks.data ?? []).filter((t) => t.acceptanceStatus !== 'PENDING' && t.acceptanceStatus !== 'DECLINED').map((t) => (
                <option key={t.id} value={t.id}>{t.projectCode ? `${t.projectCode} · ` : ''}{t.title}</option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={ids.reason}>Reason (required)</Label>
            <Input id={ids.reason} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. Worked offline at the client site" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={ids.note}>Note</Label>
            <Input id={ids.note} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          </div>
          <div className="space-y-2 sm:col-span-2">
            {error ? <p className="text-sm font-medium text-destructive" role="alert">{error}</p> : null}
            {add.isError ? <Alert variant="destructive"><AlertDescription>{add.error.message}</AlertDescription></Alert> : null}
            {done ? <p className="text-sm text-muted-foreground" role="status">{done}</p> : null}
            <Button type="submit" disabled={add.isPending}>Add time</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function PayableCard({ sheet }: { sheet: TimesheetDetail }) {
  const pay = sheet.payable;
  return (
    <Card data-testid="payable">
      <CardHeader>
        <CardTitle className="text-base">Payable</CardTitle>
        {pay ? <CardDescription>{pay.final ? 'Fixed at approval.' : 'Estimate from the current entries.'} {pay.rateType.toLowerCase()} rate</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {pay ? (
          <>
            <p className="text-2xl font-semibold tabular-nums" data-testid="payable-amount">{pay.currency} {pay.amount}</p>
            <p className="text-muted-foreground">{minutesLabel(pay.regularMinutes)} regular{pay.overtimeMinutes ? ` · ${minutesLabel(pay.overtimeMinutes)} overtime` : ''}</p>
            {pay.lines.length > 1 || pay.lines[0]?.projectId ? (
              <ul className="space-y-1 border-t pt-2">
                {pay.lines.map((l) => (
                  <li key={l.projectId ?? 'base'} className="flex justify-between gap-2">
                    <span>{l.projectName ?? 'No project'} <span className="text-xs text-muted-foreground">@ {l.rate}</span></span>
                    <span className="tabular-nums">{l.amount}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground">{sheet.payableNote}</p>
        )}
      </CardContent>
    </Card>
  );
}

function NotesCard({ sheet }: { sheet: TimesheetDetail }) {
  const act = useTimesheetAction(sheet.id);
  const [notes, setNotes] = useState(sheet.notes);
  const id = useId();
  if (!sheet.permissions.canEdit) {
    return sheet.notes ? (
      <Card><CardHeader><CardTitle className="text-base">Notes</CardTitle></CardHeader><CardContent className="whitespace-pre-wrap text-sm">{sheet.notes}</CardContent></Card>
    ) : null;
  }
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Notes</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        <Label htmlFor={id} className="sr-only">Notes for your approver</Label>
        <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} placeholder="Anything your approver should know" />
        <Button variant="outline" size="sm" disabled={act.isPending || notes === sheet.notes} onClick={() => act.mutate({ action: 'notes', version: sheet.version, notes })}>Save notes</Button>
        {act.isError ? <Alert variant="destructive"><AlertDescription>{act.error.message}</AlertDescription></Alert> : null}
      </CardContent>
    </Card>
  );
}

const ACTION_LABEL = { SUBMIT: 'Submitted', APPROVE: 'Approved', REJECT: 'Returned', REOPEN: 'Reopened' } as const;

function HistoryCard({ sheet }: { sheet: TimesheetDetail }) {
  if (sheet.approvals.length === 0) return null;
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">History</CardTitle></CardHeader>
      <CardContent>
        <ol className="space-y-2 text-sm" data-testid="timesheet-history">
          {sheet.approvals.map((a) => (
            <li key={a.id}>
              <span className="font-medium">{ACTION_LABEL[a.action]}</span> by {a.actor.displayName ?? a.actor.email}
              <span className="block text-xs text-muted-foreground">{formatDateTime(a.createdAt)}</span>
              {a.comment ? <span className="block text-xs">“{a.comment}”</span> : null}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
