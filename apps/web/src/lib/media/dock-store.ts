'use client';

import { create } from 'zustand';

/** ADR 048: where the floating call dock is, so other floating UI (incoming-call alerts) keeps clear of it. */
interface DockState {
  visible: boolean;
  height: number;
  set: (s: Partial<Pick<DockState, 'visible' | 'height'>>) => void;
}

export const useDockStore = create<DockState>((set) => ({ visible: false, height: 0, set: (s) => set(s) }));
