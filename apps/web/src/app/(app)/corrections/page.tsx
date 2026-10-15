'use client';

import { useId, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { CorrectionQueueItem } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Permission, useCan } from '@/lib/permissions';
import { useCorrectionQueue, useReviewCorrection } from '@/lib/queries';
import { formatClock, formatDateTime, formatDuration } from '@/lib/format';

function QueueItem({ item, onDone }: { item: CorrectionQueueItem; onDone: (msg: string) => void }) {
  const review = useReviewCorrection();
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteId = useId();
  const durationSec = (Date.parse(item.requestedOut) - Date.parse(item.requestedIn)) / 1000;
  const who = item.requesterName ?? item.requesterEmail;

  const decide = (status: 'APPROVED' | 'REJECTED') => {
    if (status === 'REJECTED' && note.trim().length === 0) {
      setNoteError('Add a note explaining the rejection.');
      return;
    }
    setNoteError(null);
    review.mutate(
      { id: item.id, status, reviewNote: note.trim() || undefined },
      { onSuccess: () => onDone(`${status === 'APPROVED' ? 'Approved' : 'Rejected'} the request from ${who}.`) },
    );
  };

  return (
    <Card data-testid="queue-item">
      <CardHeader>
        <CardTitle className="text-base">{who}</CardTitle>
        <CardDescription>
          Requested {formatDateTime(item.requestedIn)} – {formatClock(item.requestedOut)} ({formatDuration(durationSec)}) ·
          submitted {formatDateTime(item.createdAt)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p>
          <span className="font-medium">Reason:</span> {item.reason}
        </p>
        <div className="space-y-1.5">
          <Label htmlFor={noteId}>Note to {who}</Label>
          <Textarea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} aria-invalid={noteError ? true : undefined}
            aria-describedby={noteError ? `${noteId}-err` : undefined} />
          {noteError ? <p id={`${noteId}-err`} className="text-xs font-medium text-destructive">{noteError}</p> : null}
        </div>
        {review.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{review.error.message}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter className="gap-2">
        <Button onClick={() => decide('APPROVED')} disabled={review.isPending}>
          <Check aria-hidden="true" />
          Approve
        </Button>
        <Button variant="destructive" onClick={() => decide('REJECTED')} disabled={review.isPending}>
          <X aria-hidden="true" />
          Reject
        </Button>
      </CardFooter>
    </Card>
  );
}

/** FR-ATT-013: managers approve or reject correction requests with a note. */
export default function CorrectionsQueuePage() {
  const allowed = useCan(Permission.ATTENDANCE_CORRECTIONS_REVIEW);
  const queue = useCorrectionQueue(allowed);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Correction requests</h1>
      {!allowed ? <AccessDenied what="The corrections queue" /> : null}
      <div aria-live="polite">
        {message ? (
          <Alert variant="success">
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      {allowed && queue.isPending ? <LoadingState label="Loading requests" rows={3} /> : null}
      {allowed && queue.isError ? <ErrorState error={queue.error} onRetry={() => void queue.refetch()} /> : null}
      {allowed && queue.data && queue.data.length === 0 ? (
        <EmptyState title="Nothing to review" description="New requests from your team will appear here." />
      ) : null}
      {queue.data?.map((item) => <QueueItem key={item.id} item={item} onDone={setMessage} />)}
    </div>
  );
}
