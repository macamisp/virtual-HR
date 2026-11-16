'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * ADR 055: the office's festive decorations, on or off, remembered in this browser only (no
 * server, no account setting). On by default. Changing it never reloads anything: the renderer
 * builds or destroys its festive layer in place.
 */
export const FESTIVE_KEY = 'hrvo.office.festive';

function read(): boolean {
  try { return window.localStorage.getItem(FESTIVE_KEY) !== 'off'; } catch { return true; }
}

export function useFestiveMode(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(true);
  // Read after mounting, so the server render and the first client render agree.
  useEffect(() => { setOn(read()); }, []);
  const set = useCallback((v: boolean) => {
    setOn(v);
    try { window.localStorage.setItem(FESTIVE_KEY, v ? 'on' : 'off'); } catch { /* storage unavailable: this visit only */ }
  }, []);
  return [on, set];
}
