/// <reference lib="webworker" />
/**
 * Heartbeat Web Worker (FR-ATT-001..004).
 *
 * Owns the Socket.IO connection for the tab. When this tab is the elected leader it sends a
 * signed heartbeat every 30 s containing counters only (active/idle seconds, tab visibility,
 * window focus, in-call). Worker timers are not throttled like background-tab timers, so the
 * cadence holds while the tab is hidden. Signing uses WebCrypto via @hrvo/shared.
 */
import { io, type Socket } from 'socket.io-client';
import { signHeartbeatPayload } from '@hrvo/shared/heartbeat-signer';
import { intervalCounters, type Credentials, type MainToWorker, type WorkerToMain } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let socket: Socket | null = null;
let creds: Credentials | null = null;
let ids: { orgId: string; userId: string; deviceId: string } | null = null;
let intervalMs = 30_000;
let timer: ReturnType<typeof setInterval> | null = null;
let leader = false;
let lastInputAt: number | null = null;
let visible = true;
let focused = true;
let intervalStart = Date.now();
let seq = 0;
let waitingForCredentials = false;

function post(msg: WorkerToMain): void {
  self.postMessage(msg);
}

function nextSeq(): number {
  // Monotonic per device across reloads (the server rejects seq <= last seen) and within int4.
  seq = Math.max(seq + 1, Math.floor(Date.now() / 1000));
  return seq;
}

type Ack = { success: boolean; currentState?: string; error?: string };

async function sendHeartbeat(): Promise<void> {
  if (!socket?.connected || !creds || !ids || !leader) return;
  const now = Date.now();
  const counters = intervalCounters({ intervalStart, now, lastInputAt });
  intervalStart = now;

  const attempt = async (): Promise<{ ack: Ack; seq: number }> => {
    const sequenceNumber = nextSeq();
    const payload = await signHeartbeatPayload(
      {
        orgId: ids!.orgId,
        userId: ids!.userId,
        deviceId: ids!.deviceId,
        sessionId: creds!.sessionId,
        sequenceNumber,
        nonce: crypto.randomUUID().replace(/-/g, ''),
        activeSeconds: counters.activeSeconds,
        idleSeconds: counters.idleSeconds,
        tabVisible: visible,
        windowFocused: focused,
        inCall: false,
      },
      creds!.sessionSecret,
    );
    const ack = (await socket!.timeout(10_000).emitWithAck('presence:heartbeat', payload)) as Ack;
    return { ack, seq: sequenceNumber };
  };

  try {
    let { ack, seq: used } = await attempt();
    const violation = !ack.success && ack.error ? /last seen (\d+)/.exec(ack.error) : null;
    if (violation) {
      // Another worker on this device (reload, second tab) got ahead: continue above it once.
      seq = Math.max(seq, Number.parseInt(violation[1]!, 10));
      ({ ack, seq: used } = await attempt());
    }
    post({ type: 'heartbeat', ok: ack.success, state: ack.currentState, error: ack.error, at: Date.now(), seq: used });
  } catch {
    post({ type: 'heartbeat', ok: false, error: 'No acknowledgement from server', at: Date.now() });
  }
}

function startTimer(): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => void sendHeartbeat(), intervalMs);
}

function requestCredentials(kind: 'expired' | 'rejected'): void {
  waitingForCredentials = true;
  post({ type: 'connection', state: 'reconnecting' });
  post({ type: 'auth', kind });
}

function connect(apiUrl: string): void {
  post({ type: 'connection', state: 'connecting' });
  socket = io(apiUrl, {
    transports: ['websocket'],
    // Read the latest token on every (re)connect attempt.
    auth: (cb) => cb({ token: creds?.token ?? '' }),
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 10_000,
  });

  socket.on('connect', () => {
    post({ type: 'connection', state: 'connected' });
    intervalStart = Math.min(intervalStart, Date.now());
    void sendHeartbeat();
    startTimer();
  });

  socket.on('disconnect', (reason) => {
    if (timer) clearInterval(timer);
    timer = null;
    if (reason === 'io client disconnect') return;
    if (reason === 'io server disconnect') {
      // Kicked by the server (expired/revoked); it will not auto-reconnect.
      if (!waitingForCredentials) requestCredentials('expired');
      return;
    }
    post({ type: 'connection', state: 'reconnecting' });
  });

  socket.on('connect_error', (err) => {
    post({ type: 'connection', state: 'reconnecting' });
    if (err.message === 'Unauthorized' && !waitingForCredentials) {
      requestCredentials('rejected');
    }
  });

  socket.io.on('reconnect_attempt', () => post({ type: 'connection', state: 'reconnecting' }));

  socket.on('auth:expired', () => {
    if (!waitingForCredentials) requestCredentials('expired');
  });
  socket.on('auth:revoked', (p: { reason?: string }) => post({ type: 'auth', kind: 'revoked', reason: p?.reason }));
  socket.on('attendance:event', (p: { currentState: string; actionTaken: string }) =>
    post({ type: 'attendance', currentState: p.currentState, actionTaken: p.actionTaken }),
  );
  socket.on('presence:update', (p: { userId: string; state: string }) =>
    post({ type: 'presence', userId: p.userId, state: p.state }),
  );
}

async function applyCredentials(next: Credentials): Promise<void> {
  if (creds && creds.token === next.token && !waitingForCredentials) return;
  creds = next;
  waitingForCredentials = false;
  if (!socket) return;
  if (socket.connected) {
    // Extend the live socket instead of reconnecting (ADR 005 `auth:refresh`).
    const ack = (await socket.timeout(10_000).emitWithAck('auth:refresh', { token: next.token }).catch(() => null)) as
      | { success: boolean }
      | null;
    if (!ack?.success) {
      socket.disconnect();
      socket.connect();
    }
  } else {
    socket.connect();
  }
}

self.onmessage = (event: MessageEvent<MainToWorker>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      creds = { token: msg.token, sessionId: msg.sessionId, sessionSecret: msg.sessionSecret };
      ids = { orgId: msg.orgId, userId: msg.userId, deviceId: msg.deviceId };
      intervalMs = msg.intervalMs;
      seq = Math.max(seq, msg.seqFloor);
      intervalStart = Date.now();
      if (!socket) connect(msg.apiUrl);
      break;
    case 'credentials':
      void applyCredentials({ token: msg.token, sessionId: msg.sessionId, sessionSecret: msg.sessionSecret });
      break;
    case 'leader': {
      const becameLeader = msg.leader && !leader;
      leader = msg.leader;
      if (becameLeader) {
        intervalStart = Date.now();
        void sendHeartbeat();
      }
      break;
    }
    case 'activity':
      lastInputAt = msg.at;
      break;
    case 'visibility':
      visible = msg.visible;
      focused = msg.focused;
      break;
    case 'stop':
      if (timer) clearInterval(timer);
      socket?.disconnect();
      socket = null;
      self.close();
      break;
  }
};
