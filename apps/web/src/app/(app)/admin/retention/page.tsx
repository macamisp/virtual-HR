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
import { useRetentionSettings, useSaveRetentionSettings } from '@/lib/admin-queries';

/** FR-ADM-004: how long each kind of data is kept. */
export default function AdminRetentionPage() {
  const data = useRetentionSettings();
  const save = useSaveRetentionSettings();
  const [presence, setPresence] = useState('');
  const [notifications, setNotifications] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data.data) {
      setPresence(String(data.data.presenceDays));
      setNotifications(String(data.data.notificationsDays));
    }
  }, [data.data]);
  const check = (v: string, l: { min: number; max: number }) => (/^\d+$/.test(v) && Number(v) >= l.min && Number(v) <= l.max ? null : `Between ${l.min} and ${l.max} days`);
  const pErr = check(presence, RETENTION_LIMITS.presenceDays);
  const nErr = check(notifications, RETENTION_LIMITS.notificationsDays);

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
                if (!pErr && !nErr) save.mutate({ presenceDays: Number(presence), notificationsDays: Number(notifications) }, { onSuccess: () => setSaved(true) });
              }}>
                <FormField label="Attendance events (days)" type="number" value={presence} error={pErr} hint="Raw presence signals. Daily totals and sessions are kept." onChange={(e) => setPresence(e.target.value)} />
                <FormField label="Notifications (days)" type="number" value={notifications} error={nErr} hint="In-app notifications, read or not." onChange={(e) => setNotifications(e.target.value)} />
                <div className="flex items-center gap-3 sm:col-span-2">
                  <Button type="submit" disabled={!!pErr || !!nErr || save.isPending}>Save</Button>
                  {saved ? <p className="text-sm text-muted-foreground" role="status">Retention saved.</p> : null}
                </div>
              </form>
              {save.isError ? <Alert variant="destructive" className="mt-3"><AlertDescription>{save.error.message}</AlertDescription></Alert> : null}
            </CardContent>
          </Card>
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
