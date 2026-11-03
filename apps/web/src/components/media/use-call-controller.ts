'use client';

import { createContext, useContext, useSyncExternalStore } from 'react';
import type { CallController } from '@/lib/media/call-controller';

export const CallContext = createContext<CallController | null>(null);
const zero = () => 0;

/** The tab's call controller, re-rendering on every change (ADR 048). */
export function useCallController(): CallController {
  const c = useContext(CallContext);
  if (!c) throw new Error('useCallController needs CallProvider');
  useSyncExternalStore(c.subscribe, c.getVersion, zero);
  return c;
}
