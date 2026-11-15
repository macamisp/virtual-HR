'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { useConsent, useTransparency } from '@/lib/queries';
import { formatDateTime, formatDateTimeSeconds } from '@/lib/format';

const NOT_COLLECTED = [
  'Keystrokes or what you type',
  'Screenshots or screen recordings',
  'Webcam or microphone',
  'Browser history, URLs or page titles',
  'Names of applications you use',
  'Where you go or what you do in the virtual office (rooms, positions, desks, games, nudges, avatar actions)',
];

/** FR-ATT-020: plain-language description of what is collected, plus the user's own raw events. */
export default function TransparencyPage() {
  const info = useTransparency();
  const consent = useConsent();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">What we collect</h1>
      {info.isPending ? <LoadingState label="Loading" rows={4} /> : null}
      {info.isError ? <ErrorState error={info.error} onRetry={() => void info.refetch()} /> : null}
      {info.data ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>In plain language</CardTitle>
              <CardDescription>
                Notice version {info.data.noticeVersion}
                {consent.data?.acceptedAt ? ` · you accepted it on ${formatDateTime(consent.data.acceptedAt)}` : ''}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="leading-relaxed">{info.data.plainLanguageNotice}</p>
              <div className="grid gap-6 sm:grid-cols-2">
                <div>
                  <h2 className="mb-2 font-medium">Collected</h2>
                  <ul className="list-inside list-disc text-sm" data-testid="collected-fields">
                    {info.data.collectedFields.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h2 className="mb-2 font-medium">Never collected</h2>
                  <ul className="list-inside list-disc text-sm">
                    {NOT_COLLECTED.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                The browser sends a heartbeat every 30 seconds with counters only: seconds active and idle, whether the tab
                is visible and focused, and whether you are in a call. Raw events are kept for {info.data.retentionDays} days.
              </p>
              <section aria-labelledby="office-time-title" className="rounded-md border p-3 text-sm" data-testid="office-time-notice">
                <h2 id="office-time-title" className="mb-1 font-medium">Virtual office connection times</h2>
                <p className="leading-relaxed">
                  When you are connected to the virtual office, the server records when your connection started and ended (and,
                  once a minute while you are connected, that you still are). Nothing about which room you are in, where you
                  walk, what you play or who you nudge is recorded. HR and your manager see these times as office connected
                  time, which is not work time; your work attendance is measured as described above. The times are kept
                  for {info.data.retentionDays} days, are in your <a className="underline" href="/account/privacy">data download</a>,
                  and you can see them yourself on <a className="underline" href="/attendance/analytics">your attendance analytics page</a>.
                </p>
              </section>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Your recent raw events</CardTitle>
              <CardDescription>The latest 100 events recorded for you.</CardDescription>
            </CardHeader>
            <CardContent>
              {info.data.events.length === 0 ? (
                <EmptyState title="No events recorded yet" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Server time</TableHead>
                      <TableHead>Event</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead className="text-right">Sequence</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {info.data.events.map((e) => (
                      <TableRow key={String(e.id)}>
                        <TableCell className="whitespace-nowrap tabular-nums" data-testid="event-time">{formatDateTimeSeconds(e.serverTs)}</TableCell>
                        <TableCell>{e.eventType}</TableCell>
                        <TableCell>{e.state}</TableCell>
                        <TableCell className="text-right tabular-nums">{e.seq}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
