'use client';

import { create } from 'zustand';
import type { ConnectionState } from './protocol';

interface PresenceState {
  connection: ConnectionState;
  leader: boolean;
  lastHeartbeatAt: number | null;
  lastHeartbeatError: string | null;
  setConnection: (c: ConnectionState) => void;
  setLeader: (l: boolean) => void;
  heartbeat: (ok: boolean, at: number, error?: string) => void;
  reset: () => void;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  connection: 'idle',
  leader: false,
  lastHeartbeatAt: null,
  lastHeartbeatError: null,
  setConnection: (connection) => set({ connection }),
  setLeader: (leader) => set({ leader }),
  heartbeat: (ok, at, error) =>
    set(ok ? { lastHeartbeatAt: at, lastHeartbeatError: null } : { lastHeartbeatError: error ?? 'Heartbeat failed' }),
  reset: () => set({ connection: 'idle', leader: false, lastHeartbeatAt: null, lastHeartbeatError: null }),
}));
