/**
 * Messages between the main thread and the heartbeat Web Worker.
 * Privacy (FR-ATT-004): activity messages carry only a timestamp, never what was typed,
 * clicked or viewed.
 */

export interface Credentials {
  token: string;
  sessionId: string;
  sessionSecret: string;
}

export type MainToWorker =
  | ({ type: 'init'; apiUrl: string; orgId: string; userId: string; deviceId: string; seqFloor: number; intervalMs: number } & Credentials)
  | ({ type: 'credentials' } & Credentials)
  | { type: 'leader'; leader: boolean }
  | { type: 'activity'; at: number }
  | { type: 'visibility'; visible: boolean; focused: boolean }
  | { type: 'stop' };

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting';

export type WorkerToMain =
  | { type: 'connection'; state: ConnectionState }
  | { type: 'heartbeat'; ok: boolean; state?: string; error?: string; at: number; seq?: number }
  | { type: 'attendance'; currentState: string; actionTaken: string }
  | { type: 'presence'; userId: string; state: string }
  | { type: 'auth'; kind: 'expired' | 'rejected' | 'revoked'; reason?: string };

/** A user counts as active for this long after their last input (reading without moving the mouse). */
export const ACTIVITY_WINDOW_MS = 60_000;

/**
 * Splits one heartbeat interval into active/idle seconds (counters only).
 * Active = the part of the interval within ACTIVITY_WINDOW_MS after the last input.
 * Any activity rounds up to at least 1 s so the server sees an ACTIVE heartbeat (FR-ATT-001).
 */
export function intervalCounters(params: {
  intervalStart: number;
  now: number;
  lastInputAt: number | null;
  maxSeconds?: number;
}): { activeSeconds: number; idleSeconds: number } {
  const max = params.maxSeconds ?? 30;
  const intervalSeconds = Math.min(max, Math.max(1, Math.round((params.now - params.intervalStart) / 1000)));
  if (params.lastInputAt === null) return { activeSeconds: 0, idleSeconds: intervalSeconds };
  const activeEnd = Math.min(params.now, params.lastInputAt + ACTIVITY_WINDOW_MS);
  const activeMs = Math.max(0, activeEnd - params.intervalStart);
  const activeSeconds = activeMs > 0 ? Math.min(intervalSeconds, Math.max(1, Math.ceil(activeMs / 1000))) : 0;
  return { activeSeconds, idleSeconds: intervalSeconds - activeSeconds };
}
