'use client';

import { useEffect, useRef, useState } from 'react';
import type { PresenceChallenge } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { answerChallenge } from '@/lib/flag-queries';
import { onUiEvent } from '@/lib/ui-socket';

/**
 * FR-ATT-023 (ADR 019): "Are you still working?" after a long idle period, when the organisation
 * has turned it on. One minute to answer (server clock); otherwise tracking pauses until input.
 */
export function PresenceChallengeDialog() {
  const [c, setC] = useState<PresenceChallenge | null>(null);
  const [left, setLeft] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  useEffect(() => onUiEvent<PresenceChallenge>('attendance:challenge', (x) => { setResult(null); setC(x); }), []);
  useEffect(() => {
    if (!c) return;
    button.current?.focus();
    const tick = () => {
      const s = Math.max(0, Math.round((Date.parse(c.expiresAt) - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) { setC(null); setResult('No answer: tracking paused until you are back. Any input resumes it.'); }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [c]);
  if (!c && !result) return null;
  if (!c) {
    return (
      <div role="status" className="fixed bottom-4 left-4 z-50 max-w-sm rounded border bg-background p-3 text-sm shadow-lg" data-testid="challenge-result">
        {result} <Button size="sm" variant="ghost" onClick={() => setResult(null)}>Dismiss</Button>
      </div>
    );
  }
  const yes = () => {
    answerChallenge(c.id)
      .then(() => setResult('Thanks. Tracking continues.'))
      .catch((e: unknown) => setResult(e instanceof Error ? e.message : 'The question had expired.'))
      .finally(() => setC(null));
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div role="alertdialog" aria-modal="true" aria-labelledby="challenge-title" aria-describedby="challenge-text" className="w-full max-w-sm rounded-lg border bg-background p-5 shadow-xl" data-testid="presence-challenge">
        <h2 id="challenge-title" className="text-lg font-semibold">Are you still working?</h2>
        <p id="challenge-text" className="mt-2 text-sm text-muted-foreground">There has been no input for a while. Answer within a minute, or tracking pauses until you are back. Nothing else happens either way.</p>
        <p className="mt-2 text-sm font-medium" role="timer">{left} s left</p>
        <Button ref={button} className="mt-4 w-full" onClick={yes}>Yes, I am still working</Button>
      </div>
    </div>
  );
}
