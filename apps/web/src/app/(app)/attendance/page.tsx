'use client';

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Coffee, Play } from 'lucide-react';
import { FLAG_META } from '@hrvo/shared';
import type { MyDay, MyToday } from '@hrvo/shared';
import { FlagCard } from '@/components/flags/flag-card';
import { useFlags } from '@/lib/flag-queries';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { FormField } from '@/components/form-field';
import { EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { useBreak, useDays, useMyCorrections, useRequestCorrection, useToday } from '@/lib/queries';
import { addDays, formatClock, formatDateTime, formatDuration, formatWorkDate, startOfWeek, toWorkDate } from '@/lib/format';

const STATE_LABEL: Record<MyToday['state'], string> = {
  OFFLINE: 'Not clocked in',
  ACTIVE: 'Active',
  IDLE: 'Idle',
  PAUSED: 'Idle (paused)',
  IN_MEETING: 'In meeting',
  ON_BREAK: 'On break',
  DISCONNECTED: 'Reconnecting',
};

function Totals({ t }: { t: MyToday['totals'] }) {
  const items: Array<[string, number, string]> = [
    ['Active', t.activeSeconds, 'total-active'],
    ['Idle', t.idleSeconds, 'total-idle'],
    ['Break', t.breakSeconds, 'total-break'],
    ['Meeting', t.meetingSeconds, 'total-meeting'],
    ['Net work time', t.netSeconds, 'total-net'],
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {items.map(([label, secs, id]) => (
        <div key={label} className="rounded-md border p-3">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="text-lg font-semibold tabular-nums" data-testid={id}>
            {formatDuration(secs)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function TodayCard() {
  const today = useToday();
  const brk = useBreak();
  const t = today.data;
  const canStart = !!t && ['ACTIVE', 'IDLE', 'PAUSED', 'IN_MEETING'].includes(t.state);
  const onBreak = t?.state === 'ON_BREAK';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Today</CardTitle>
        <CardDescription>
          Clock-in and clock-out are automatic. Times come from the server clock.
        </CardDescription>
        {t?.lastClosed ? (
          <Alert variant="warning" data-testid="outage-notice" className="mt-2">
            <AlertTitle>Your earlier session ended at {formatClock(t.lastClosed.at)} because {t.lastClosed.source === 'DISCONNECT' ? 'the connection dropped' : 'heartbeats stopped'}.</AlertTitle>
            <AlertDescription>
              {t.lastClosed.minutesUnaccounted > 0 ? `${t.lastClosed.minutesUnaccounted} minute${t.lastClosed.minutesUnaccounted === 1 ? '' : 's'} are not counted. ` : ''}
              If you were working, <a href="#correction-title" className="font-medium underline underline-offset-4">request a correction</a> below.
            </AlertDescription>
          </Alert>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {today.isPending ? <LoadingState label="Loading today" rows={2} /> : null}
        {today.isError ? <ErrorState error={today.error} onRetry={() => void today.refetch()} /> : null}
        {t ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant={t.state === 'ACTIVE' || t.state === 'IN_MEETING' ? 'success' : t.state === 'OFFLINE' ? 'secondary' : 'warning'}>
                {STATE_LABEL[t.state]}
              </Badge>
              <span className="text-sm text-muted-foreground">
                {t.trackingSince ? `Clocked in at ${formatClock(t.trackingSince)}` : 'You will be clocked in automatically when you are active.'}
                {onBreak && t.onBreakSince ? ` · on break since ${formatClock(t.onBreakSince)}` : ''}
              </span>
            </div>
            <Totals t={t.totals} />
            <div className="flex flex-wrap items-center gap-3">
              {onBreak ? (
                <Button onClick={() => brk.mutate('end')} disabled={brk.isPending}>
                  <Play aria-hidden="true" />
                  {brk.isPending ? 'Ending break…' : 'End break'}
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => brk.mutate('start')} disabled={!canStart || brk.isPending}
                  aria-describedby={!canStart ? 'break-hint' : undefined}>
                  <Coffee aria-hidden="true" />
                  {brk.isPending ? 'Starting break…' : 'Start break'}
                </Button>
              )}
              {!canStart && !onBreak ? (
                <span id="break-hint" className="text-sm text-muted-foreground">
                  Breaks can be started once you are clocked in.
                </span>
              ) : null}
              <span className="ml-auto text-xs text-muted-foreground">As of {formatClock(t.asOf)}</span>
            </div>
            {brk.isError ? (
              <Alert variant="destructive">
                <AlertDescription>{brk.error.message}</AlertDescription>
              </Alert>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function WeekList() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const from = toWorkDate(weekStart);
  const to = toWorkDate(addDays(weekStart, 6));
  const days = useDays(from, to);
  const isCurrentWeek = toWorkDate(startOfWeek(new Date())) === from;

  const total = useMemo(
    () =>
      (days.data ?? []).reduce(
        (acc, d) => ({
          active: acc.active + d.activeSeconds,
          idle: acc.idle + d.idleSeconds,
          brk: acc.brk + d.breakSeconds,
          meeting: acc.meeting + d.meetingSeconds,
          net: acc.net + d.netSeconds,
        }),
        { active: 0, idle: 0, brk: 0, meeting: 0, net: 0 },
      ),
    [days.data],
  );

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Daily and weekly record</CardTitle>
          <CardDescription>
            Week of {formatWorkDate(from)} – {formatWorkDate(to)}
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setWeekStart((w) => addDays(w, -7))}>
            <ChevronLeft aria-hidden="true" />
            Previous week
          </Button>
          <Button variant="outline" size="sm" onClick={() => setWeekStart((w) => addDays(w, 7))} disabled={isCurrentWeek}>
            Next week
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {days.isPending ? <LoadingState label="Loading week" /> : null}
        {days.isError ? <ErrorState error={days.error} onRetry={() => void days.refetch()} /> : null}
        {days.data && days.data.length === 0 ? (
          <EmptyState title="No attendance recorded this week" description="Days appear here once you have been clocked in." />
        ) : null}
        {days.data && days.data.length > 0 ? (
          <Table data-testid="days-table">
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead>First in</TableHead>
                <TableHead>Last out</TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead className="text-right">Idle</TableHead>
                <TableHead className="text-right">Break</TableHead>
                <TableHead className="text-right">Meeting</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead>Flags</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {days.data.map((d: MyDay) => (
                <TableRow key={d.workDate}>
                  <TableCell className="font-medium">{formatWorkDate(d.workDate)}</TableCell>
                  <TableCell>{formatClock(d.firstIn)}</TableCell>
                  <TableCell>{d.open ? <Badge variant="success">In progress</Badge> : formatClock(d.lastOut)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatDuration(d.activeSeconds)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatDuration(d.idleSeconds)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatDuration(d.breakSeconds)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatDuration(d.meetingSeconds)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatDuration(d.netSeconds)}</TableCell>
                  <TableCell className="space-x-1">
                    {d.flags.map((f) => (
                      <Badge key={f} variant="outline">{f in FLAG_META ? FLAG_META[f as keyof typeof FLAG_META].label : f}</Badge>
                    ))}
                    {d.lateMinutes ? <Badge variant="warning">Late {d.lateMinutes}m</Badge> : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={3}>Week total</TableCell>
                <TableCell className="text-right tabular-nums">{formatDuration(total.active)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatDuration(total.idle)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatDuration(total.brk)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatDuration(total.meeting)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatDuration(total.net)}</TableCell>
                <TableCell />
              </TableRow>
            </TableFooter>
          </Table>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CorrectionForm() {
  const request = useRequestCorrection();
  const [date, setDate] = useState(() => toWorkDate(addDays(new Date(), -1)));
  const [timeIn, setTimeIn] = useState('09:00');
  const [timeOut, setTimeOut] = useState('17:00');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  const requestedIn = new Date(`${date}T${timeIn}`);
  const requestedOut = new Date(`${date}T${timeOut}`);
  const rangeProblem =
    Number.isNaN(requestedIn.getTime()) || Number.isNaN(requestedOut.getTime())
      ? 'Enter a valid date and times.'
      : requestedOut <= requestedIn
        ? 'Clock-out must be after clock-in.'
        : requestedOut.getTime() > Date.now()
          ? 'Corrections cannot be in the future.'
          : null;
  const reasonProblem = reason.trim().length < 5 ? 'Explain what happened (at least 5 characters).' : null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (rangeProblem || reasonProblem) return;
    request.mutate(
      { requestedIn: requestedIn.toISOString(), requestedOut: requestedOut.toISOString(), reason: reason.trim() },
      { onSuccess: () => { setReason(''); setTouched(false); } },
    );
  };

  return (
    <Card>
      <form onSubmit={submit} noValidate aria-labelledby="correction-title">
        <CardHeader>
          <CardTitle id="correction-title">Request a correction</CardTitle>
          <CardDescription>
            For a missed or wrong clock-in/out. Your manager reviews it; the original record is kept.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label="Date" type="date" value={date} max={toWorkDate(new Date())} onChange={(e) => setDate(e.target.value)} />
            <FormField label="Clock-in" type="time" value={timeIn} onChange={(e) => setTimeIn(e.target.value)} />
            <FormField label="Clock-out" type="time" value={timeOut} onChange={(e) => setTimeOut(e.target.value)}
              error={touched ? rangeProblem : null} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="correction-reason">Reason</Label>
            <Textarea id="correction-reason" value={reason} onChange={(e) => setReason(e.target.value)}
              aria-invalid={touched && reasonProblem ? true : undefined}
              aria-describedby={touched && reasonProblem ? 'correction-reason-error' : undefined} />
            {touched && reasonProblem ? (
              <p id="correction-reason-error" className="text-xs font-medium text-destructive">{reasonProblem}</p>
            ) : null}
          </div>
          {request.isError ? (
            <Alert variant="destructive">
              <AlertDescription>{request.error.message}</AlertDescription>
            </Alert>
          ) : null}
          {request.isSuccess ? (
            <Alert variant="success">
              <AlertDescription>Correction requested. You will see the decision below.</AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" disabled={request.isPending}>
            {request.isPending ? 'Submitting…' : 'Submit request'}
          </Button>
        </CardContent>
      </form>
    </Card>
  );
}

function MyCorrections() {
  const list = useMyCorrections();
  return (
    <Card>
      <CardHeader>
        <CardTitle>My correction requests</CardTitle>
      </CardHeader>
      <CardContent>
        {list.isPending ? <LoadingState label="Loading requests" rows={2} /> : null}
        {list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
        {list.data && list.data.length === 0 ? <EmptyState title="No correction requests yet" /> : null}
        {list.data && list.data.length > 0 ? (
          <ul className="divide-y" data-testid="my-corrections">
            {list.data.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
                <div>
                  <p className="font-medium">
                    {formatDateTime(c.requestedIn)} – {formatClock(c.requestedOut)}
                  </p>
                  <p className="text-sm text-muted-foreground">{c.reason}</p>
                  {c.reviewNote ? <p className="mt-1 text-sm">Reviewer note: {c.reviewNote}</p> : null}
                </div>
                <Badge variant={c.status === 'APPROVED' ? 'success' : c.status === 'REJECTED' ? 'destructive' : 'secondary'}>
                  {c.status === 'PENDING' ? 'Pending' : c.status === 'APPROVED' ? 'Approved' : 'Rejected'}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** ADR 019: what automatic checks raised about me, in plain words, with room to explain. */
function MyFlags() {
  const flags = useFlags('mine');
  if (flags.isPending) return null;
  if (flags.isError) return <ErrorState error={flags.error} onRetry={() => void flags.refetch()} />;
  if (!flags.data.items.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Items under review</CardTitle>
        <CardDescription>Automatic checks asked your manager or HR to look at these. Nothing was changed or deducted. You can add an explanation.</CardDescription>
      </CardHeader>
      <CardContent><ul className="space-y-2" data-testid="my-flags">{flags.data.items.map((f) => <FlagCard key={f.id} flag={f} mine />)}</ul></CardContent>
    </Card>
  );
}

export default function MyAttendancePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">My attendance</h1>
      <TodayCard />
      <MyFlags />
      <WeekList />
      <div className="grid gap-6 lg:grid-cols-2">
        <CorrectionForm />
        <MyCorrections />
      </div>
    </div>
  );
}
