'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LiveBoardEntry } from '@hrvo/shared';
import { randomUUID } from '@/lib/uuid';
import { API_URL, HEARTBEAT_INTERVAL_MS } from '@/lib/env';
import { useAuthStore } from '@/lib/auth-store';
import { logout, refreshSession } from '@/lib/session';
import { queryKeys } from '@/lib/queries';
import { usePresenceStore } from './presence-store';
import type { MainToWorker, WorkerToMain } from './protocol';

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
const ACTIVITY_THROTTLE_MS = 5_000;

/**
 * Stable per-browser device id. Not a secret; it lets the server tell one browser from two
 * (FR-ATT-010) and scopes heartbeat sequence numbers.
 */
function deviceId(): string {
  const key = 'hrvo.deviceId';
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const created = `web-${randomUUID()}`;
    localStorage.setItem(key, created);
    return created;
  } catch {
    return `web-${randomUUID()}`;
  }
}

/**
 * Last heartbeat sequence number used by this device. The server rejects seq <= last seen per
 * device, so a reloaded page (new worker, same device) must continue above it.
 */
function seqKey(device: string): string {
  return `hrvo.seq.${device}`;
}

function readSeqFloor(device: string): number {
  try {
    const n = Number.parseInt(localStorage.getItem(seqKey(device)) ?? '0', 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeSeqFloor(device: string, seq: number): void {
  try {
    if (seq > readSeqFloor(device)) localStorage.setItem(seqKey(device), String(seq));
  } catch {
    // Storage unavailable: the worker still retries once on a sequence violation.
  }
}

const BOARD_STATUS: Record<string, LiveBoardEntry['status']> = {
  ACTIVE: 'ACTIVE',
  IDLE: 'IDLE',
  PAUSED: 'IDLE',
  DISCONNECTED: 'IDLE',
  ON_BREAK: 'ON_BREAK',
  IN_MEETING: 'IN_MEETING',
  OFFLINE: 'OFFLINE',
};

/**
 * Starts the heartbeat worker for the signed-in user once the monitoring notice is accepted.
 * Only one tab per browser sends heartbeats (Web Lock leader election); every tab keeps a
 * socket for live updates.
 */
export function useHeartbeat(enabled: boolean): void {
  const queryClient = useQueryClient();
  const workerRef = useRef<Worker | null>(null);
  const accessToken = useAuthStore((s) => s.accessToken);
  const sessionId = useAuthStore((s) => s.sessionId);
  const sessionSecret = useAuthStore((s) => s.sessionSecret);
  const user = useAuthStore((s) => s.user);
  const userId = user?.id;
  const orgId = user?.orgId;

  // Worker lifecycle
  useEffect(() => {
    if (!enabled || !userId || !orgId) return;
    const { accessToken: token, sessionId: sid, sessionSecret: secret } = useAuthStore.getState();
    if (!token || !sid || !secret) return;

    const device = deviceId();
    const worker = new Worker(new URL('./heartbeat.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    const send = (msg: MainToWorker) => worker.postMessage(msg);
    const presence = usePresenceStore.getState();

    // The first "today" request of a page can still be in flight when the first heartbeat is
    // acknowledged. Invalidating alone would not restart that initial request, so its stale
    // "not clocked in" answer would stick for a minute; cancel it, then fetch again.
    const refreshToday = async () => {
      await queryClient.cancelQueries({ queryKey: queryKeys.today });
      await queryClient.invalidateQueries({ queryKey: queryKeys.today });
    };
    worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'connection':
          usePresenceStore.getState().setConnection(msg.state);
          break;
        case 'heartbeat':
          if (msg.seq) writeSeqFloor(device, msg.seq);
          usePresenceStore.getState().heartbeat(msg.ok, msg.at, msg.error);
          if (msg.ok) void refreshToday();
          break;
        case 'attendance':
          void refreshToday();
          void queryClient.invalidateQueries({ queryKey: ['attendance', 'days'] });
          break;
        case 'presence': {
          const status = BOARD_STATUS[msg.state] ?? 'IDLE';
          queryClient.setQueriesData<LiveBoardEntry[]>({ queryKey: queryKeys.live }, (rows) =>
            rows?.map((r) =>
              r.userId === msg.userId
                ? { ...r, status, hasClockedInToday: r.hasClockedInToday || status !== 'OFFLINE' }
                : r,
            ),
          );
          break;
        }
        case 'notification':
          void queryClient.invalidateQueries({ queryKey: ['notifications'] });
          break;
        case 'auth':
          if (msg.kind === 'revoked') {
            void logout(msg.reason === 'PASSWORD_RESET' ? 'Your password was changed. Please sign in again.' : 'You were signed out.');
          } else {
            // Expired or rejected: refresh; the credentials effect below hands the new token to the worker.
            void refreshSession().then((ok) => {
              if (!ok) void logout('Your session has ended. Please sign in again.');
            });
          }
          break;
      }
    };

    send({
      type: 'init',
      apiUrl: API_URL,
      orgId,
      userId,
      deviceId: device,
      seqFloor: readSeqFloor(device),
      intervalMs: HEARTBEAT_INTERVAL_MS,
      token,
      sessionId: sid,
      sessionSecret: secret,
    });

    // Leader election: the lock is held until this tab closes or the hook unmounts.
    let releaseLock: (() => void) | null = null;
    let cancelled = false;
    if (navigator.locks) {
      void navigator.locks.request('hrvo-heartbeat-leader', () =>
        new Promise<void>((resolve) => {
          if (cancelled) {
            resolve();
            return;
          }
          releaseLock = resolve;
          usePresenceStore.getState().setLeader(true);
          send({ type: 'leader', leader: true });
        }),
      );
    } else {
      presence.setLeader(true);
      send({ type: 'leader', leader: true });
    }

    // Activity: only the fact and time of input, never its content (FR-ATT-004).
    let lastSent = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - lastSent < ACTIVITY_THROTTLE_MS) return;
      lastSent = now;
      send({ type: 'activity', at: now });
    };
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, onActivity, { passive: true });
    // Signing in / accepting the notice was itself an interaction.
    send({ type: 'activity', at: Date.now() });

    const onVisibility = () =>
      send({ type: 'visibility', visible: document.visibilityState === 'visible', focused: document.hasFocus() });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
    window.addEventListener('blur', onVisibility);
    onVisibility();

    return () => {
      cancelled = true;
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, onActivity);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
      window.removeEventListener('blur', onVisibility);
      send({ type: 'stop' });
      worker.terminate();
      workerRef.current = null;
      if (releaseLock) (releaseLock as () => void)();
      usePresenceStore.getState().reset();
    };
  }, [enabled, userId, orgId, queryClient]);

  // Hand refreshed credentials to the worker (token refresh, FR-AUTH-003)
  // ADR 016: forward the call state to the worker (the heartbeat's inCall counter).
  const inCall = usePresenceStore((st) => st.inCall);
  useEffect(() => {
    workerRef.current?.postMessage({ type: 'inCall', inCall } satisfies MainToWorker);
  }, [inCall]);

  useEffect(() => {
    if (!workerRef.current || !accessToken || !sessionId || !sessionSecret) return;
    workerRef.current.postMessage({ type: 'credentials', token: accessToken, sessionId, sessionSecret } satisfies MainToWorker);
  }, [accessToken, sessionId, sessionSecret]);
}
