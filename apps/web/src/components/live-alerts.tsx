'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Megaphone, PhoneIncoming, X } from 'lucide-react';
import type { BroadcastMessage } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { closeUiSocket, onUiEvent } from '@/lib/ui-socket';

interface Ring { meetingId: string; title: string }

/**
 * App-wide live alerts over the UI socket (ADR 016): incoming calls (FR-MEET-001) and office
 * broadcasts (FR-VO-010). Rings disappear after 45 s.
 */
export function LiveAlerts() {
  const [rings, setRings] = useState<Ring[]>([]);
  const [broadcasts, setBroadcasts] = useState<Array<BroadcastMessage & { key: number }>>([]);
  useEffect(() => {
    const offRing = onUiEvent<Ring>('meeting:ring', (r) => {
      setRings((rs) => [...rs.filter((x) => x.meetingId !== r.meetingId), r]);
      setTimeout(() => setRings((rs) => rs.filter((x) => x.meetingId !== r.meetingId)), 45_000);
    });
    const offCast = onUiEvent<BroadcastMessage>('office:broadcast', (b) => setBroadcasts((bs) => [...bs.slice(-2), { ...b, key: Date.now() }]));
    return () => { offRing(); offCast(); closeUiSocket(); };
  }, []);
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
      {rings.map((r) => (
        <div key={r.meetingId} role="alert" data-testid="ring" className="rounded border border-primary bg-background p-3 shadow-lg">
          <p className="flex items-center gap-2 text-sm font-medium"><PhoneIncoming className="h-4 w-4" aria-hidden="true" /> Incoming call</p>
          <p className="text-sm">{r.title}</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" asChild onClick={() => setRings((rs) => rs.filter((x) => x.meetingId !== r.meetingId))}><Link href={`/meetings/${r.meetingId}?join=1`}>Join</Link></Button>
            <Button size="sm" variant="ghost" onClick={() => setRings((rs) => rs.filter((x) => x.meetingId !== r.meetingId))}>Dismiss</Button>
          </div>
        </div>
      ))}
    </div>
  );
}
