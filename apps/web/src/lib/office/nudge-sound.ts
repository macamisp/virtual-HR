'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * ADR 058: the short chime of a nudge. Made with the Web Audio API (two soft notes), so there is
 * no audio file to ship and the Content Security Policy is unchanged. Browsers only let a page
 * make sound after the person has clicked, tapped or pressed a key on it: until then the chime is
 * skipped (the notification is still shown). Whether it plays at all is this device's choice,
 * remembered in this browser only.
 */
export const NUDGE_SOUND_KEY = 'hrvo.office.nudgeSound';
export type NudgeSound = 'played' | 'blocked' | 'muted';

let ctx: AudioContext | null = null;
let primed = false;

function unlock(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  } catch { ctx = null; }
}

/** Listens (once per page) for the first click, tap or key, which is what allows sound. */
export function primeNudgeSound(): void {
  if (primed || typeof window === 'undefined') return;
  primed = true;
  for (const type of ['pointerdown', 'keydown'] as const) window.addEventListener(type, unlock, { capture: true, passive: true });
}

/** Two notes, about a third of a second, quiet. Returns what happened, for the page and the tests. */
export function playNudgeSound(): NudgeSound {
  if (!ctx || ctx.state !== 'running') return 'blocked';
  try {
    const t0 = ctx.currentTime + 0.01;
    [[880, 0], [1174.66, 0.14]].forEach(([freq, at]) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq!;
      gain.gain.setValueAtTime(0.0001, t0 + at!);
      gain.gain.exponentialRampToValueAtTime(0.12, t0 + at! + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at! + 0.2);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t0 + at!);
      osc.stop(t0 + at! + 0.22);
    });
    return 'played';
  } catch { return 'blocked'; }
}

function read(): boolean {
  try { return window.localStorage.getItem(NUDGE_SOUND_KEY) !== 'off'; } catch { return true; }
}

/** The nudge sound, on or off, on this device. On by default. */
export function useNudgeSound(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(true);
  useEffect(() => { setOn(read()); }, []);
  const set = useCallback((v: boolean) => {
    setOn(v);
    try { window.localStorage.setItem(NUDGE_SOUND_KEY, v ? 'on' : 'off'); } catch { /* storage unavailable: this visit only */ }
  }, []);
  return [on, set];
}
