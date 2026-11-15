'use client';

import { useEffect, useState } from 'react';
import { Bell, BellRing, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { NudgeResult, OfficeClient } from '@/lib/office/office-client';
import { playNudgeSound, primeNudgeSound } from '@/lib/office/nudge-sound';
import type { NudgeSound } from '@/lib/office/nudge-sound';

/** What each person reads when a nudge has ended. */
export function nudgeResultText(r: NudgeResult): string {
  if (r.role === 'sender') {
    return {
      accepted: `${r.name} accepted your nudge.`,
      ignored: `${r.name} ignored your nudge.`,
      cancelled: `You cancelled the nudge to ${r.name}.`,
      expired: `${r.name} did not answer. The nudge expired.`,
      gone: `${r.name} has left the office.`,
    }[r.outcome];
  }
  return {
    accepted: `You accepted ${r.name}'s nudge.`,
    ignored: `You ignored ${r.name}'s nudge.`,
    cancelled: `${r.name} cancelled the nudge.`,
    expired: `${r.name}'s nudge expired.`,
    gone: `${r.name} has left the office.`,
  }[r.outcome];
}

/**
 * ADR 058 (FR-VO-016): the nudge notifications, in a corner of the window so they are seen in the
 * map view and the list view alike and wherever the page is scrolled. Someone nudged me: Accept
 * or Ignore. I nudged someone: waiting, with Cancel. Then how it ended, for both. Announced to
 * screen readers; the buttons are ordinary buttons (mouse, touch, Tab and Enter). The bell only
 * moves when the person has not asked for reduced motion.
 */
export function NudgeNotices({ client, sound }: { client: OfficeClient; sound: boolean }) {
  const [lastSound, setLastSound] = useState<NudgeSound | 'none'>('none');
  useEffect(() => { primeNudgeSound(); }, []);
  useEffect(() => {
    client.onNudge = () => setLastSound(sound ? playNudgeSound() : 'muted');
    return () => { client.onNudge = null; };
  }, [client, sound]);
  const result = client.nudgeResult;
  const card = 'pointer-events-auto flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm shadow-lg';
  return (
    <div
      data-testid="nudge-notices"
      data-sound={lastSound}
      role="region"
      aria-label="Nudges"
      aria-live="assertive"
      className="pointer-events-none fixed inset-x-2 bottom-2 z-50 flex flex-col items-stretch gap-2 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-80"
    >
      {client.nudgesIn.map((n) => (
        <div key={n.id} data-testid="nudge-request" data-from={n.from} className={`${card} border-primary`}>
          <BellRing aria-hidden="true" data-testid="nudge-bell-icon" className="h-5 w-5 shrink-0 text-primary motion-safe:animate-bounce" />
          <p className="min-w-0 flex-1 font-medium">{n.fromName} nudged you.</p>
          <div className="flex w-full gap-2">
            <Button size="sm" className="flex-1" onClick={() => client.answerNudge(n.id, true)}><Check aria-hidden="true" /> Accept</Button>
            <Button size="sm" variant="outline" className="flex-1" onClick={() => client.answerNudge(n.id, false)}><X aria-hidden="true" /> Ignore</Button>
          </div>
        </div>
      ))}
      {client.nudgeOut ? (
        <div data-testid="nudge-pending" className={card}>
          <Bell aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1">Nudge sent to {client.nudgeOut.toName}. Waiting for an answer…</p>
          <Button size="sm" variant="ghost" onClick={() => client.cancelNudge()}>Cancel</Button>
        </div>
      ) : null}
      {result ? (
        <div data-testid="nudge-result" data-outcome={result.outcome} data-role={result.role} className={card}>
          {result.outcome === 'accepted' ? <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-emerald-600" /> : <Bell aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <p className="min-w-0 flex-1">{nudgeResultText(result)}</p>
          <Button size="sm" variant="ghost" aria-label="Dismiss" onClick={() => client.dismissNudgeResult()}><X aria-hidden="true" /></Button>
        </div>
      ) : null}
    </div>
  );
}
