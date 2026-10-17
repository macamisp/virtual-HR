'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { CalendarCheck, RefreshCw } from 'lucide-react';
import { CALENDAR_PROVIDER_LABEL } from '@hrvo/shared';
import { AccessDenied, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useCalendarConnections, useConnectCalendar, useDisconnectCalendar, useSyncCalendar } from '@/lib/calendar-queries';
import { formatDateTime } from '@/lib/format';
import { Permission, useCan } from '@/lib/permissions';

const RESULT: Record<string, string> = {
  invalid_state: 'That link has already been used or is not valid. Try connecting again.',
  expired: 'That took too long. Try connecting again.',
  denied: 'You did not allow access, so nothing was connected.',
  failed: 'The calendar provider did not complete the connection. Try again.',
  no_offline_access: 'The provider did not grant lasting access. Try again and allow access.',
};

function CalendarPage() {
  const allowed = useCan(Permission.MEETINGS_USE);
  const params = useSearchParams();
  const list = useCalendarConnections();
  const connect = useConnectCalendar();
  const disconnect = useDisconnectCalendar();
  const sync = useSyncCalendar();
  if (!allowed) return <AccessDenied what="Calendar sync" />;
  const connected = params.get('connected');
  const error = params.get('error');
  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Calendar sync</h1>
      <p className="text-sm text-muted-foreground">
        Scheduled meetings you host or attend appear in your calendar and move with the meeting. Accepting or declining there updates the meeting here.
        Your busy times (times only, never what the other events are) help colleagues pick a slot.
      </p>
      {connected ? <Alert data-testid="calendar-result"><AlertDescription>{CALENDAR_PROVIDER_LABEL[connected as 'GOOGLE'] ?? 'Calendar'} connected. The first sync runs within a few minutes, or use Sync now.</AlertDescription></Alert> : null}
      {error ? <Alert variant="destructive" data-testid="calendar-result"><AlertDescription>{RESULT[error] ?? RESULT.failed}</AlertDescription></Alert> : null}
      {list.isPending ? <LoadingState label="Loading calendars" rows={2} /> : null}
      {list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
      {list.data?.items.map((c) => (
        <Card key={c.provider} data-testid={`calendar-${c.provider}`}>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2 text-base"><CalendarCheck className="h-4 w-4" aria-hidden="true" /> {CALENDAR_PROVIDER_LABEL[c.provider]}
                {c.connected ? <Badge variant={c.status === 'ERROR' ? 'destructive' : 'success'}>{c.status === 'ERROR' ? 'Needs attention' : 'Connected'}</Badge> : null}</CardTitle>
              <CardDescription>{c.connected ? `${c.accountEmail ?? 'Connected account'} · last sync ${c.lastSyncAt ? formatDateTime(c.lastSyncAt) : 'not yet'}` : c.available ? 'Not connected.' : 'Not set up on this server yet (your administrator registers the app).'}</CardDescription>
            </div>
            <div className="flex gap-2">
              {c.connected ? (
                <Button size="sm" variant="outline" disabled={disconnect.isPending} onClick={() => { if (window.confirm(`Disconnect ${CALENDAR_PROVIDER_LABEL[c.provider]}? Upcoming meetings are removed from it.`)) disconnect.mutate(c.provider); }}>Disconnect</Button>
              ) : null}
              {(!c.connected || c.status === 'ERROR') && c.available ? <Button size="sm" disabled={connect.isPending} onClick={() => connect.mutate(c.provider)}>{c.connected ? 'Connect again' : 'Connect'}</Button> : null}
            </div>
          </CardHeader>
          {c.lastError ? <CardContent><p role="alert" className="text-sm text-destructive">{c.lastError}</p></CardContent> : null}
        </Card>
      ))}
      {list.data?.items.some((c) => c.connected) ? (
        <Button variant="outline" disabled={sync.isPending} onClick={() => sync.mutate()}><RefreshCw aria-hidden="true" /> {sync.isPending ? 'Syncing…' : 'Sync now'}</Button>
      ) : null}
      {connect.isError ? <p role="alert" className="text-sm text-destructive">{connect.error.message}</p> : null}
      {sync.isError ? <p role="alert" className="text-sm text-destructive">{sync.error.message}</p> : null}
    </div>
  );
}

export default function Page() {
  return <Suspense><CalendarPage /></Suspense>;
}
