'use client';

import { create } from 'zustand';
import type { ConnectionState } from './protocol';

interface PresenceState {
  connection: ConnectionState;
  leader: boolean;
  lastHeartbeatAt: number | null;
  lastHeartbeatError: string | null;
  /** ADR 016: set by the media layer while a call is connected. */
  inCall: boolean;
  setInCall: (v: boolean) => void;
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
  inCall: false,
  setInCall: (inCall) => set({ inCall }),
  setConnection: (connection) => set({ connection }),
  setLeader: (leader) => set({ leader }),
  heartbeat: (ok, at, error) =>
    set(ok ? { lastHeartbeatAt: at, lastHeartbeatError: null } : { lastHeartbeatError: error ?? 'Heartbeat failed' }),
  reset: () => set({ connection: 'idle', leader: false, lastHeartbeatAt: null, lastHeartbeatError: null, inCall: false }),
}));
