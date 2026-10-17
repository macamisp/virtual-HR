'use client';

import { useEffect, useId, useState } from 'react';
import { Circle, Download, Trash2, Video } from 'lucide-react';
import { CONSENT_NOTICES } from '@hrvo/shared';
import type { Recording } from '@hrvo/shared';
import { InlineSpinner } from '@/components/state-views';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { saveBlob } from '@/lib/api';
import { formatDateTime, formatDuration } from '@/lib/format';
import { fetchRecording, useRecordingAction, useRecordingConsent, useRecordings, useStartRecording } from '@/lib/recording-queries';

const who = (p: { displayName: string | null; email: string }) => p.displayName ?? p.email;

/** FR-MEET-007: always visible while a recording is asked for, running or being saved. */
export function RecordingBanner({ recording }: { recording: Recording | null }) {
  if (!recording) return null;
  if (recording.status === 'RECORDING') {
    return (
      <div role="status" data-testid="recording-banner" className="flex items-center gap-2 rounded border border-destructive bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
        <Circle className="h-3 w-3 animate-pulse fill-current" aria-hidden="true" /> Recording. Everyone in this call agreed{recording.startedAt ? ` · since ${formatDateTime(recording.startedAt)}` : ''}.
      </div>
    );
  }
  if (recording.status === 'CONSENT') {
    return (
      <div role="status" data-testid="recording-banner" className="rounded border border-warning px-3 py-2 text-sm">
        {who(recording.startedBy)} asked to record this meeting. Nothing is recorded until everyone agrees{recording.waitingFor.length ? `; waiting for ${recording.waitingFor.map(who).join(', ')}` : ''}.
      </div>
    );
  }
  return <div role="status" data-testid="recording-banner" className="rounded border px-3 py-2 text-sm text-muted-foreground">The recording has stopped and is being saved.</div>;
}

/** The recording notice and the two answers (FR-AUD-004: the notice version is recorded). */
export function ConsentNotice({ busy, error, onAnswer, joining }: { busy: boolean; error: string | null; onAnswer: (granted: boolean) => void; joining: boolean }) {
  const id = useId();
  const notice = CONSENT_NOTICES.RECORDING;
  return (
    <Alert data-testid="recording-consent" aria-labelledby={id}>
      <AlertTitle id={id}>{joining ? 'This meeting is being recorded' : 'May this meeting be recorded?'}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{notice.summary} Only the host, co-hosts and the people recorded can watch it. <span className="text-xs text-muted-foreground">(Notice {notice.version})</span></p>
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => onAnswer(true)}>{joining ? 'I agree, join' : 'I agree'}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onAnswer(false)}>{joining ? 'Do not join' : 'No, do not record'}</Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** In the call: answer a pending request (only while you have not answered). */
export function InCallConsent({ meetingId, recording }: { meetingId: string; recording: Recording | null }) {
  const answer = useRecordingConsent(meetingId);
  if (!recording || recording.status !== 'CONSENT' || recording.myConsent !== null) return null;
  return <ConsentNotice joining={false} busy={answer.isPending} error={answer.error?.message ?? null} onAnswer={(granted) => answer.mutate({ recordingId: recording.id, granted })} />;
}

/** Host controls: ask to record, cancel the request, stop. */
export function RecordControls({ meetingId, recording, canRecord }: { meetingId: string; recording: Recording | null; canRecord: boolean }) {
  const start = useStartRecording(meetingId);
  const stop = useRecordingAction(meetingId, 'stop');
  if (!canRecord && !recording?.canStop) return null;
  return (
    <>
      {recording?.canStop ? (
        <Button size="sm" variant="destructive" disabled={stop.isPending} onClick={() => stop.mutate(recording.id)}>
          <Circle className="fill-current" aria-hidden="true" /> {recording.status === 'CONSENT' ? 'Cancel recording request' : 'Stop recording'}
        </Button>
      ) : !recording && canRecord ? (
        <Button size="sm" variant="outline" disabled={start.isPending} onClick={() => start.mutate()}><Circle aria-hidden="true" /> Record</Button>
      ) : null}
      {start.isError || stop.isError ? <span role="alert" className="text-xs text-destructive">{(start.error ?? stop.error)?.message}</span> : null}
    </>
  );
}

const STATUS: Record<Recording['status'], { label: string; variant: 'secondary' | 'success' | 'destructive' | 'outline' }> = {
  CONSENT: { label: 'Waiting for consent', variant: 'secondary' }, RECORDING: { label: 'Recording', variant: 'destructive' }, PROCESSING: { label: 'Saving', variant: 'secondary' },
  READY: { label: 'Ready', variant: 'success' }, FAILED: { label: 'Failed', variant: 'destructive' }, CANCELLED: { label: 'Not recorded', variant: 'outline' }, DELETED: { label: 'Deleted', variant: 'outline' },
};

function Player({ r }: { r: Recording }) {
  const [url, setUrl] = useState<string | null>(null);
  const [file, setFile] = useState<{ blob: Blob; filename: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (url && file) {
    return (
      <div className="w-full space-y-1">
        <video src={url} controls className="w-full max-w-xl rounded border" data-testid="recording-player" />
        <Button size="sm" variant="ghost" onClick={() => saveBlob(file.blob, file.filename)}><Download aria-hidden="true" /> Download</Button>
      </div>
    );
  }
  return (
    <>
      <Button size="sm" variant="outline" disabled={loading} onClick={() => {
        setLoading(true); setError(null);
        fetchRecording(r.id).then((f) => { setFile(f); setUrl(URL.createObjectURL(f.blob)); }).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not open the recording')).finally(() => setLoading(false));
      }}><Video aria-hidden="true" /> {loading ? 'Opening…' : 'Watch'}</Button>
      {error ? <span role="alert" className="text-xs text-destructive">{error}</span> : null}
    </>
  );
}

/** FR-MEET-007: the recordings of this meeting (encrypted; destroyed after the retention period). */
export function RecordingsCard({ meetingId }: { meetingId: string }) {
  const list = useRecordings(meetingId);
  const del = useRecordingAction(meetingId, 'delete');
  if (list.data && !list.data.items.length && !list.data.enabled) return null;
  return (
    <Card data-testid="recordings-card">
      <CardHeader><CardTitle className="text-base">Recordings</CardTitle><CardDescription>Only the host, co-hosts and the people who were recorded can watch.</CardDescription></CardHeader>
      <CardContent className="space-y-2 text-sm">
        {list.isPending ? <InlineSpinner label="Loading recordings" /> : null}
        {list.isError ? <Alert variant="destructive"><AlertDescription>{list.error.message}</AlertDescription></Alert> : null}
        {list.data && !list.data.items.length ? <p className="text-muted-foreground">No recordings.</p> : null}
        <ul className="space-y-2">
          {list.data?.items.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 rounded border p-2">
              <span>{formatDateTime(r.startedAt ?? r.createdAt)}</span>
              <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge>
              {r.durationSeconds ? <span className="text-muted-foreground">{formatDuration(r.durationSeconds)}</span> : null}
              {r.expiresAt ? <span className="text-xs text-muted-foreground">deleted on {formatDateTime(r.expiresAt)}</span> : null}
              {r.detail ? <span className="w-full text-xs text-muted-foreground">{r.detail}</span> : null}
              {r.canWatch ? <Player r={r} /> : null}
              {r.canDelete ? <Button size="sm" variant="ghost" disabled={del.isPending} onClick={() => { if (window.confirm('Delete this recording for good? It cannot be recovered.')) del.mutate(r.id); }}><Trash2 aria-hidden="true" /> Delete</Button> : null}
            </li>
          ))}
        </ul>
        {del.isError ? <p role="alert" className="text-destructive">{del.error.message}</p> : null}
      </CardContent>
    </Card>
  );
}
