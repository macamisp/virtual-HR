'use client';

import { useId, useState } from 'react';
import { Check, X } from 'lucide-react';
import { LEAVE_TYPE_LABEL } from '@hrvo/shared';
import type { LeaveRequest } from '@hrvo/shared';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime, formatWorkDate } from '@/lib/format';
import { useDecideLeave, useLeaveRequests } from '@/lib/leave-queries';
import { Permission, useCan } from '@/lib/permissions';
import { LEAVE_STATUS } from '@/components/leave/status';

function Item({ r, onDone }: { r: LeaveRequest; onDone: (msg: string) => void }) {
  const decide = useDecideLeave();
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteId = useId();
  const who = r.user.displayName ?? r.user.email;
  const go = (approved: boolean) => {
    if (!approved && !note.trim()) { setNoteError('Say why the request is rejected.'); return; }
    setNoteError(null);
    decide.mutate({ id: r.id, dto: { approved, note: note.trim() } }, { onSuccess: () => onDone(`${approved ? 'Approved' : 'Rejected'} ${who}'s request.`) });
  };
  return (
    <Card data-testid="leave-queue-item">
      <CardHeader>
        <CardTitle className="text-base">{who}</CardTitle>
        <CardDescription>{LEAVE_TYPE_LABEL[r.type]} · {formatWorkDate(r.startDate)}{r.endDate !== r.startDate ? ` – ${formatWorkDate(r.endDate)}` : ''} ({r.days} day{r.days === 1 ? '' : 's'}) · asked {formatDateTime(r.createdAt)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {r.reason ? <p><span className="font-medium">Reason:</span> {r.reason}</p> : null}
        <div className="space-y-1.5">
          <Label htmlFor={noteId}>Note to {who}</Label>
          <Textarea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} aria-invalid={noteError ? true : undefined} aria-describedby={noteError ? `${noteId}-err` : undefined} />
          {noteError ? <p id={`${noteId}-err`} className="text-xs font-medium text-destructive">{noteError}</p> : null}
        </div>
        {decide.isError ? <Alert variant="destructive"><AlertDescription>{decide.error.message}</AlertDescription></Alert> : null}
      </CardContent>
      <CardFooter className="gap-2">
        <Button disabled={decide.isPending} onClick={() => go(true)}><Check aria-hidden="true" /> Approve</Button>
        <Button variant="outline" disabled={decide.isPending} onClick={() => go(false)}><X aria-hidden="true" /> Reject</Button>
      </CardFooter>
    </Card>
  );
}

/** FR-ORG-010: the requests this manager or HR decides, pending first. */
export default function LeaveReviewPage() {
  const allowedTeam = useCan(Permission.LEAVE_APPROVE_TEAM);
  const allowedAll = useCan(Permission.LEAVE_APPROVE_ALL);
  const allowed = allowedTeam || allowedAll;
  const list = useLeaveRequests('team', allowed);
  const [message, setMessage] = useState<string | null>(null);
  if (!allowed) return <AccessDenied what="Leave requests" />;
  const pending = list.data?.items.filter((r) => r.status === 'PENDING') ?? [];
  const decided = list.data?.items.filter((r) => r.status !== 'PENDING') ?? [];
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Leave requests</h1>
      {message ? <Alert><AlertDescription role="status">{message}</AlertDescription></Alert> : null}
      {list.isPending ? <LoadingState label="Loading leave requests" /> : null}
      {list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
      {list.data && !pending.length ? <EmptyState title="Nothing to decide" description="New requests from your team appear here." /> : null}
      <div className="grid gap-4 lg:grid-cols-2">{pending.map((r) => <Item key={r.id} r={r} onDone={setMessage} />)}</div>
      {decided.length ? (
        <Card>
          <CardHeader><CardTitle className="text-base">Decided</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm" data-testid="leave-decided">
              {decided.map((r) => <li key={r.id} className="flex flex-wrap items-center gap-2">{r.user.displayName ?? r.user.email} · {LEAVE_TYPE_LABEL[r.type]} · {formatWorkDate(r.startDate)}{r.endDate !== r.startDate ? ` – ${formatWorkDate(r.endDate)}` : ''} <Badge variant={LEAVE_STATUS[r.status].variant}>{LEAVE_STATUS[r.status].label}</Badge></li>)}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
