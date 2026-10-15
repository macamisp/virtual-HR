'use client';

import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useAcceptConsent, useTransparency } from '@/lib/queries';

/**
 * FR-ATT-020 / FR-AUD-004: blocks the whole app until the current monitoring notice is accepted.
 * No heartbeat is sent before acceptance (the worker is not started).
 */
export function ConsentGate({ noticeVersion }: { noticeVersion: string }) {
  const notice = useTransparency();
  const accept = useAcceptConsent();

  return (
    <main id="main" className="mx-auto max-w-2xl p-4 sm:p-8">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
            Attendance monitoring notice
          </CardTitle>
          <CardDescription>
            Please read and accept before using HR Virtual Office. Version {noticeVersion}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {notice.isPending ? <LoadingState label="Loading notice" rows={4} /> : null}
          {notice.isError ? <ErrorState error={notice.error} onRetry={() => void notice.refetch()} /> : null}
          {notice.data ? (
            <>
              <p className="leading-relaxed">{notice.data.plainLanguageNotice}</p>
              <div>
                <h3 className="mb-1 font-medium">What is collected</h3>
                <ul className="list-inside list-disc text-sm text-muted-foreground">
                  {notice.data.collectedFields.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </div>
              <p className="text-sm text-muted-foreground">Raw events are kept for {notice.data.retentionDays} days.</p>
            </>
          ) : null}
          {accept.isError ? (
            <Alert variant="destructive">
              <AlertDescription>{accept.error.message}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter>
          <Button onClick={() => accept.mutate(noticeVersion)} disabled={accept.isPending || !notice.data}>
            {accept.isPending ? 'Saving…' : 'I have read and accept this notice'}
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}
