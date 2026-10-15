'use client';

import { CONSENT_NOTICES } from '@hrvo/shared';
import type { ConsentOverview } from '@hrvo/shared';
import { ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useMyConsents, useRecordConsent } from '@/lib/admin-queries';
import { formatDateTime } from '@/lib/format';

function Status({ c }: { c: ConsentOverview }) {
  if (c.granted === true) return <Badge variant="success">Given</Badge>;
  if (c.granted === false) return <Badge variant="secondary">Withdrawn</Badge>;
  return <Badge variant="outline">Not decided</Badge>;
}

/** FR-AUD-004: your consent decisions, each with notice version and time; nothing is overwritten. */
export default function ConsentsPage() {
  const list = useMyConsents();
  const record = useRecordConsent();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">My consents</h1>
      {list.isPending ? <LoadingState label="Loading consents" rows={3} /> : null}
      {list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
      {record.isError ? <Alert variant="destructive"><AlertDescription>{record.error.message}</AlertDescription></Alert> : null}
      {list.data?.map((c) => {
        const notice = CONSENT_NOTICES[c.type];
        return (
          <Card key={c.type} data-testid={`consent-${c.type}`}>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-base">{notice.title}</CardTitle>
                <Status c={c} />
              </div>
              <CardDescription>{notice.summary} Notice {c.currentVersion}.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {c.type === 'MONITORING' ? (
                <p className="text-sm text-muted-foreground">You accept this notice when you start attendance tracking. It is required to clock in.</p>
              ) : (
                <div className="flex gap-2">
                  <Button size="sm" disabled={record.isPending || c.granted === true} onClick={() => record.mutate({ type: c.type as 'RECORDING' | 'AI', granted: true, noticeVersion: c.currentVersion })}>Give consent</Button>
                  <Button size="sm" variant="outline" disabled={record.isPending || c.granted !== true} onClick={() => record.mutate({ type: c.type as 'RECORDING' | 'AI', granted: false, noticeVersion: c.currentVersion })}>Withdraw</Button>
                </div>
              )}
              {c.history.length > 0 ? (
                <details>
                  <summary className="cursor-pointer text-sm text-primary">History ({c.history.length})</summary>
                  <ul className="mt-2 space-y-1 text-sm">
                    {c.history.map((h) => <li key={h.id}>{formatDateTime(h.at)}: {h.granted ? 'given' : 'withdrawn'} (notice {h.noticeVersion})</li>)}
                  </ul>
                </details>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
