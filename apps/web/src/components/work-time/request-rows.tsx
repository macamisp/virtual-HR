'use client';

import { useState } from 'react';
import { Check, X } from 'lucide-react';
import type { OnsiteRequest, OvertimeRequest } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RequestStatusBadge, hours } from '@/components/work-time/request-parts';
import { useOnsiteAction, useOvertimeAction } from '@/lib/work-request-queries';
import { formatClock, formatDateTime, formatWorkDate } from '@/lib/format';

export function OvertimeRow({ r, showPerson, children }: { r: OvertimeRequest; showPerson?: boolean; children?: React.ReactNode }) {
  const action = useOvertimeAction();
  return (
    <li className="space-y-1 p-3 text-sm" data-testid={`ot-${r.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">
          {showPerson ? `${r.user.displayName ?? r.user.email} · ` : ''}{formatWorkDate(r.workDate)}
          {r.plannedStart ? ` · ${r.plannedStart}–${r.plannedEnd}` : ''}
        </p>
        <RequestStatusBadge status={r.status} />
      </div>
      <p>{r.workDescription}{r.project ? <span className="text-muted-foreground"> · {r.project.name}{r.task ? ` / ${r.task.title}` : ''}</span> : null}</p>
      <p className="text-muted-foreground">Reason: {r.reason}{r.notes ? ` · Notes: ${r.notes}` : ''}</p>
      <dl className="flex flex-wrap gap-x-4 text-xs">
        <div><dt className="inline text-muted-foreground">Requested </dt><dd className="inline tabular-nums">{hours(r.requestedMinutes)}</dd></div>
        <div><dt className="inline text-muted-foreground">Approved </dt><dd className="inline tabular-nums">{r.approvedMinutes === null ? '—' : hours(r.approvedMinutes)}</dd></div>
        <div><dt className="inline text-muted-foreground">Worked beyond schedule that day </dt><dd className="inline tabular-nums">{r.workedOvertimeMinutes === null ? 'not known yet' : hours(r.workedOvertimeMinutes)}</dd></div>
      </dl>
      {r.decidedBy ? <p className="text-xs text-muted-foreground">Decided by {r.decidedBy.displayName ?? r.decidedBy.email} on {formatDateTime(r.decidedAt)}{r.decisionComment ? `: “${r.decisionComment}”` : ''}</p> : null}
      {r.cancelledAt ? <p className="text-xs text-muted-foreground">Cancelled on {formatDateTime(r.cancelledAt)}{r.decisionComment && !r.decidedBy ? `: “${r.decisionComment}”` : ''}</p> : null}
      {r.canCancel && !showPerson ? (
        <Button size="sm" variant="outline" onClick={() => action.mutate({ id: r.id, cancel: {} })} disabled={action.isPending}><X aria-hidden="true" /> Cancel request</Button>
      ) : null}
      {action.isError ? <Alert variant="destructive"><AlertDescription>{action.error.message}</AlertDescription></Alert> : null}
      {children}
    </li>
  );
}


/** Approve / reject with a comment (required to reject); overtime may approve fewer minutes. */
export function DecisionPanel({ kind, r }: { kind: 'overtime'; r: OvertimeRequest } | { kind: 'onsite'; r: OnsiteRequest }) {
  const ot = useOvertimeAction();
  const os = useOnsiteAction();
  const action = kind === 'overtime' ? ot : os;
  const [comment, setComment] = useState('');
  const [minutes, setMinutes] = useState(kind === 'overtime' ? String(r.requestedMinutes) : '');
  const decide = (approved: boolean) => {
    const c = comment.trim() ? { comment: comment.trim() } : {};
    if (kind === 'overtime') ot.mutate({ id: r.id, decide: { approved, ...(approved ? { approvedMinutes: Number(minutes) } : {}), ...c } });
    else os.mutate({ id: r.id, decide: { approved, ...c } });
  };
  return (
    <div className="mt-2 space-y-2 rounded-md bg-muted/50 p-2">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <div className="space-y-1">
          <Label htmlFor={`c-${r.id}`} className="text-xs">Comment (required to reject)</Label>
          <Input id={`c-${r.id}`} value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} />
        </div>
        {kind === 'overtime' ? (
          <div className="space-y-1">
            <Label htmlFor={`m-${r.id}`} className="text-xs">Approve minutes</Label>
            <Input id={`m-${r.id}`} type="number" min={1} max={r.requestedMinutes} className="w-28" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => decide(true)} disabled={action.isPending || (kind === 'overtime' && !(Number(minutes) >= 1 && Number(minutes) <= r.requestedMinutes))}><Check aria-hidden="true" /> Approve</Button>
        <Button size="sm" variant="destructive" onClick={() => decide(false)} disabled={action.isPending || comment.trim().length === 0}><X aria-hidden="true" /> Reject</Button>
      </div>
      {action.isError ? <Alert variant="destructive"><AlertDescription>{action.error.message}</AlertDescription></Alert> : null}
    </div>
  );
}

export function OnsiteRow({ r, showPerson, children }: { r: OnsiteRequest; showPerson?: boolean; children?: React.ReactNode }) {
  const action = useOnsiteAction();
  return (
    <li className="space-y-1 p-3 text-sm" data-testid={`onsite-${r.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">
          {showPerson ? `${r.user.displayName ?? r.user.email} · ` : ''}{formatWorkDate(r.workDate)} · {formatClock(r.startedAt)}–{formatClock(r.endedAt)} · {hours(r.minutes)}
        </p>
        <RequestStatusBadge status={r.status} />
      </div>
      <p>{r.location}{r.project ? <span className="text-muted-foreground"> · {r.project.name}{r.task ? ` / ${r.task.title}` : ''}</span> : null}</p>
      <p>{r.description}</p>
      <p className="text-muted-foreground">Why it was entered by hand: {r.reason}</p>
      {r.decidedBy ? <p className="text-xs text-muted-foreground">Reviewed by {r.decidedBy.displayName ?? r.decidedBy.email} on {formatDateTime(r.decidedAt)}{r.decisionComment ? `: “${r.decisionComment}”` : ''}{r.status === 'APPROVED' ? ' · added to the timesheet as onsite work' : ''}</p> : null}
      {r.canCancel && !showPerson ? (
        <Button size="sm" variant="outline" onClick={() => action.mutate({ id: r.id, cancel: true })} disabled={action.isPending}><X aria-hidden="true" /> Cancel</Button>
      ) : null}
      {action.isError ? <Alert variant="destructive"><AlertDescription>{action.error.message}</AlertDescription></Alert> : null}
      {children}
    </li>
  );
}
