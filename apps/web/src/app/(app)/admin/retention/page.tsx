'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { RETENTION_LIMITS } from '@hrvo/shared';
import { FormField } from '@/components/form-field';
import { ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useRecordingSettings, useRetentionSettings, useSaveRecordingSettings, useSaveRetentionSettings } from '@/lib/admin-queries';

/** FR-MEET-007 / SRS 13: recording is optional and off by default. */
function RecordingSwitch() {
  const data = useRecordingSettings();
  const save = useSaveRecordingSettings();
  return (
    <Card data-testid="recording-switch">
      <CardHeader>
        <CardTitle className="text-base">Meeting recording</CardTitle>
        <CardDescription>When on, hosts and co-hosts can ask to record a meeting. It starts only after everyone in the call agrees; recordings are encrypted and kept for the days set above.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.isPending ? <LoadingState label="Loading recording setting" rows={1} /> : null}
        {data.isError ? <ErrorState error={data.error} onRetry={() => void data.refetch()} /> : null}
        {data.data ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={data.data.enabled} disabled={save.isPending} onChange={(e) => save.mutate({ enabled: e.target.checked })} />
            Allow meeting recording
          </label>
        ) : null}
        {save.isError ? <Alert variant="destructive"><AlertDescription>{save.error.message}</AlertDescription></Alert> : null}
      </CardContent>
    </Card>
  );
}

/** FR-ADM-004: how long each kind of data is kept. */
export default function AdminRetentionPage() {
  const data = useRetentionSettings();
  const save = useSaveRetentionSettings();
  const [presence, setPresence] = useState('');
  const [notifications, setNotifications] = useState('');
  const [recordings, setRecordings] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data.data) {
      setPresence(String(data.data.presenceDays));
      setNotifications(String(data.data.notificationsDays));
      setRecordings(String(data.data.recordingsDays));
    }
  }, [data.data]);
  const check = (v: string, l: { min: number; max: number }) => (/^\d+$/.test(v) && Number(v) >= l.min && Number(v) <= l.max ? null : `Between ${l.min} and ${l.max} days`);
  const pErr = check(presence, RETENTION_LIMITS.presenceDays);
  const nErr = check(notifications, RETENTION_LIMITS.notificationsDays);
  const rErr = check(recordings, RETENTION_LIMITS.recordingsDays);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Data retention</h1>
      {data.isPending ? <LoadingState label="Loading retention settings" rows={3} /> : null}
      {data.isError ? <ErrorState error={data.error} onRetry={() => void data.refetch()} /> : null}
      {data.data ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Kept for a number of days</CardTitle>
              <CardDescription>Older records are deleted by the daily retention job. The monitoring notice shows the attendance value to everyone.</CardDescription>
            </CardHeader>
            <CardContent>
              <form aria-label="Retention settings" className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => {
                e.preventDefault();
                setSaved(false);
                if (!pErr && !nErr && !rErr) save.mutate({ presenceDays: Number(presence), notificationsDays: Number(notifications), recordingsDays: Number(recordings) }, { onSuccess: () => setSaved(true) });
              }}>
                <FormField label="Attendance events (days)" type="number" value={presence} error={pErr} hint="Raw presence signals. Daily totals and sessions are kept." onChange={(e) => setPresence(e.target.value)} />
                <FormField label="Notifications (days)" type="number" value={notifications} error={nErr} hint="In-app notifications, read or not." onChange={(e) => setNotifications(e.target.value)} />
                <FormField label="Meeting recordings (days)" type="number" value={recordings} error={rErr} hint="Counted from the end of each recording; then it is destroyed for good." onChange={(e) => setRecordings(e.target.value)} />
                <div className="flex items-center gap-3 sm:col-span-2">
                  <Button type="submit" disabled={!!pErr || !!nErr || !!rErr || save.isPending}>Save</Button>
                  {saved ? <p className="text-sm text-muted-foreground" role="status">Retention saved.</p> : null}
                </div>
              </form>
              {save.isError ? <Alert variant="destructive" className="mt-3"><AlertDescription>{save.error.message}</AlertDescription></Alert> : null}
            </CardContent>
          </Card>
          <RecordingSwitch />
          <Card>
            <CardHeader><CardTitle className="text-base">Other data</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table data-testid="retention-other">
                <TableHeader><TableRow><TableHead>Data</TableHead><TableHead>Rule</TableHead></TableRow></TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell>Documents</TableCell>
                    <TableCell>{data.data.documentRules} categor{data.data.documentRules === 1 ? 'y has' : 'ies have'} rules. <Link href="/documents/retention" className="text-primary underline-offset-4 hover:underline">Edit document rules</Link></TableCell>
                  </TableRow>
                  <TableRow><TableCell>Audit log</TableCell><TableCell>Kept permanently; append-only and hash-chained.</TableCell></TableRow>
                  {data.data.notAvailable.map((n) => (
                    <TableRow key={n}><TableCell>{n}</TableCell><TableCell><Badge variant="secondary">Not available in this release</Badge></TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
