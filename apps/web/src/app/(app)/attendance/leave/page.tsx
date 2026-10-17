'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { CalendarOff, Plus } from 'lucide-react';
import { LEAVE_TYPES, LEAVE_TYPE_LABEL } from '@hrvo/shared';
import type { LeaveType } from '@hrvo/shared';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime, formatWorkDate, toWorkDate } from '@/lib/format';
import { useCancelLeave, useHolidays, useLeaveRequests, useRequestLeave } from '@/lib/leave-queries';
import { Permission, useCan } from '@/lib/permissions';
import { LEAVE_STATUS } from '@/components/leave/status';


function RequestForm({ onDone }: { onDone: () => void }) {
  const request = useRequestLeave();
  const today = toWorkDate(new Date());
  const [type, setType] = useState<LeaveType>('ANNUAL');
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  const [reason, setReason] = useState('');
  const ids = { t: useId(), s: useId(), e: useId(), r: useId() };
  const invalid = end < start;
  return (
    <form className="space-y-3" aria-label="Request leave" onSubmit={(e) => { e.preventDefault(); if (!invalid) request.mutate({ type, startDate: start, endDate: end, reason }, { onSuccess: onDone }); }}>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1"><Label htmlFor={ids.t}>Type</Label>
          <NativeSelect id={ids.t} value={type} onChange={(e) => setType(e.target.value as LeaveType)}>{LEAVE_TYPES.map((t) => <option key={t} value={t}>{LEAVE_TYPE_LABEL[t]}</option>)}</NativeSelect></div>
        <div className="space-y-1"><Label htmlFor={ids.s}>First day</Label><Input id={ids.s} type="date" required value={start} onChange={(e) => { setStart(e.target.value); if (end < e.target.value) setEnd(e.target.value); }} /></div>
        <div className="space-y-1"><Label htmlFor={ids.e}>Last day</Label><Input id={ids.e} type="date" required value={end} min={start} aria-invalid={invalid || undefined} onChange={(e) => setEnd(e.target.value)} /></div>
      </div>
      <div className="space-y-1"><Label htmlFor={ids.r}>Reason (optional)</Label><Textarea id={ids.r} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      {request.isError ? <Alert variant="destructive"><AlertDescription>{request.error.message}</AlertDescription></Alert> : null}
      <Button type="submit" disabled={invalid || request.isPending}><Plus aria-hidden="true" /> {request.isPending ? 'Sending…' : 'Send request'}</Button>
    </form>
  );
}

/** FR-ORG-010: my leave requests, and FR-ORG-011: the upcoming public holidays. */
export default function LeavePage() {
  const allowed = useCan(Permission.LEAVE_USE);
  const decidesTeam = useCan(Permission.LEAVE_APPROVE_TEAM);
  const decidesAll = useCan(Permission.LEAVE_APPROVE_ALL);
  const decides = decidesTeam || decidesAll;
  const list = useLeaveRequests('mine', allowed);
  const cancel = useCancelLeave();
  const year = new Date().getFullYear();
  const holidays = useHolidays(year);
  const [open, setOpen] = useState(false);
  if (!allowed) return <AccessDenied what="Leave" />;
  const today = toWorkDate(new Date());
  const upcoming = (holidays.data?.items ?? []).filter((h) => h.date >= today).slice(0, 6);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Leave</h1>
        <div className="flex gap-2">
          {decides ? <Button variant="outline" asChild><Link href="/attendance/leave/review">Requests to decide</Link></Button> : null}
          <Button variant={open ? 'default' : 'outline'} aria-expanded={open} onClick={() => setOpen((o) => !o)}><Plus aria-hidden="true" /> Request leave</Button>
        </div>
      </div>
      {open ? <Card><CardHeader><CardTitle className="text-base">Request leave</CardTitle><CardDescription>Your manager (or HR) approves or rejects it. Approved days count as leave: no absence or late flags, no expected hours.</CardDescription></CardHeader><CardContent><RequestForm onDone={() => setOpen(false)} /></CardContent></Card> : null}
      <Card>
        <CardHeader><CardTitle className="text-base">My requests</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {list.isPending ? <div className="p-4"><LoadingState label="Loading leave requests" /></div> : null}
          {list.isError ? <div className="p-4"><ErrorState error={list.error} onRetry={() => void list.refetch()} /></div> : null}
          {list.data && !list.data.items.length ? <div className="p-4"><EmptyState title="No leave requests yet" description="Use “Request leave” for annual, sick, unpaid or other leave." /></div> : null}
          {list.data?.items.length ? (
            <Table data-testid="my-leave">
              <TableHeader><TableRow><TableHead>Days</TableHead><TableHead>Type</TableHead><TableHead>Status</TableHead><TableHead>Decision</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {list.data.items.map((r) => (
                  <TableRow key={r.id} data-testid={`leave-${r.status}`}>
                    <TableCell>{formatWorkDate(r.startDate)}{r.endDate !== r.startDate ? ` – ${formatWorkDate(r.endDate)}` : ''} <span className="text-xs text-muted-foreground">({r.days} d)</span></TableCell>
                    <TableCell>{LEAVE_TYPE_LABEL[r.type]}{r.reason ? <div className="text-xs text-muted-foreground">{r.reason}</div> : null}</TableCell>
                    <TableCell><Badge variant={LEAVE_STATUS[r.status].variant}>{LEAVE_STATUS[r.status].label}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.decidedBy ? `${r.decidedBy.displayName ?? r.decidedBy.email} · ${formatDateTime(r.decidedAt)}` : ''}{r.decisionNote ? <div>“{r.decisionNote}”</div> : null}</TableCell>
                    <TableCell>{r.canCancel ? <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(r.id)}>Cancel</Button> : null}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          {cancel.isError ? <div className="p-4"><Alert variant="destructive"><AlertDescription>{cancel.error.message}</AlertDescription></Alert></div> : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><CalendarOff className="h-4 w-4" aria-hidden="true" /> Public holidays {year}</CardTitle><CardDescription>Holidays count as no expected working time.</CardDescription></CardHeader>
        <CardContent>
          {holidays.isPending ? <LoadingState label="Loading holidays" rows={2} /> : null}
          {holidays.isError ? <ErrorState error={holidays.error} onRetry={() => void holidays.refetch()} /> : null}
          {holidays.data && !upcoming.length ? <p className="text-sm text-muted-foreground">No more holidays this year.</p> : null}
          {upcoming.length ? <ul className="space-y-1 text-sm" data-testid="upcoming-holidays">{upcoming.map((h) => <li key={h.id}><span className="font-medium">{formatWorkDate(h.date)}</span> · {h.name}</li>)}</ul> : null}
        </CardContent>
      </Card>
    </div>
  );
}
