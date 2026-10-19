'use client';

import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useIncomingCalls, useRespond } from '@/lib/meeting-queries';
import { useEffect, useState } from 'react';
import { Megaphone, PhoneIncoming, X } from 'lucide-react';
import type { BroadcastMessage } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { closeUiSocket, onUiEvent } from '@/lib/ui-socket';
import type { CallState } from '@hrvo/shared';

interface Ring { meetingId: string; title: string }

function RingAlert({ ring }: { ring: CallState }) {
  const respond = useRespond(ring.meetingId);
  const router = useRouter();
  const qc = useQueryClient();
  // mutateAsync, not mutate(…, { onSuccess }): the server's call-state event can remove this ring
  // (unmounting the alert) before the response arrives, and per-call callbacks of an unmounted
  // component never run. The promise still resolves, so the navigation always happens.
  const meetingId = ring.meetingId;
  const answer = (accept: boolean) => {
    respond.mutateAsync(accept).then(() => {
      void qc.invalidateQueries({ queryKey: ['meetings', 'incoming'] });
      if (accept) router.push(`/meetings/${meetingId}?join=1`);
    }).catch(() => undefined); // the error is shown from respond.error while the alert is mounted
  };
  return <div role="alert" data-testid="ring" className="rounded border border-primary bg-background p-3 shadow-lg">
    <p className="flex items-center gap-2 text-sm font-medium"><PhoneIncoming className="h-4 w-4" aria-hidden="true" /> Incoming call</p>
    <p className="text-sm"><span className="font-medium">{ring.callerName}</span> is calling you</p>
    <p className="text-xs text-muted-foreground">{ring.title}</p>
    <div className="mt-2 flex gap-2">
      <Button size="sm" disabled={respond.isPending} onClick={() => answer(true)}>Accept</Button>
      <Button size="sm" variant="ghost" disabled={respond.isPending} onClick={() => answer(false)}>Decline</Button>
    </div>
    {respond.isError ? <p role="alert" className="text-sm text-destructive">{respond.error.message}</p> : null}
  </div>;
}

/**
 * App-wide live alerts over the UI socket (ADR 016): incoming calls (FR-MEET-001) and office
 * broadcasts (FR-VO-010). Rings disappear after 45 s.
 */
export function LiveAlerts() {
  const incoming = useIncomingCalls();
  const qc = useQueryClient();
  const rings = incoming.data?.items ?? [];
  const [broadcasts, setBroadcasts] = useState<Array<BroadcastMessage & { key: number }>>([]);
  useEffect(() => {
    const refresh = () => { void qc.invalidateQueries({ queryKey: ['meetings', 'incoming'] }); };
    const offRing = onUiEvent<Ring>('meeting:ring', refresh);
    const offState = onUiEvent('meeting:call-state', refresh);
    const offCast = onUiEvent<BroadcastMessage>('office:broadcast', (b) => setBroadcasts((bs) => [...bs.slice(-2), { ...b, key: Date.now() }]));
    return () => { offRing(); offState(); offCast(); closeUiSocket(); };
  }, [qc]);
  if (!rings.length && !broadcasts.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 space-y-2" aria-live="assertive">
      {broadcasts.map((b) => (
        <div key={b.key} role="alert" data-testid="broadcast" className="rounded border bg-background p-3 shadow-lg">
          <div className="flex items-start gap-2">
            <Megaphone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p className="flex-1 text-sm"><span className="font-semibold">{b.from}:</span> {b.message}</p>
            <Button size="icon" variant="ghost" className="h-6 w-6" aria-label="Dismiss" onClick={() => setBroadcasts((bs) => bs.filter((x) => x.key !== b.key))}><X aria-hidden="true" /></Button>
          </div>
        </div>
      ))}
      {rings.map((r) => <RingAlert key={r.meetingId} ring={r} />)}
    </div>
  );
}
