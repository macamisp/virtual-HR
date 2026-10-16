/**
 * The agent's link to the API (ADR 018): device-bound token refresh, the attendance socket,
 * signed heartbeats and offline uploads. No Electron imports, so it is testable in Node.
 */
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { signHeartbeatPayload } from '../../../packages/shared/src/attendance/heartbeat-signer.ts';
import { AgentSessionSchema, OfflineSyncResultSchema } from '../../../packages/shared/src/agent/types.ts';
import type { AgentSession, Anchor, OfflineSyncResult, PairDto } from '../../../packages/shared/src/agent/types.ts';
import type { Counters, PendingBatch } from './tracker.ts';

export type LinkState = 'connecting' | 'online' | 'offline' | 'revoked';

export interface StoredCredentials {
  apiUrl: string;
  deviceId: string;
  refreshToken: string;
  email: string;
  displayName: string | null;
  lastSequence: number;
}

/** A refusal by the API (as opposed to the network being down). */
export class ApiRefusal extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function post<T>(url: string, body: unknown, parse: (v: unknown) => T, token?: string): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try { const m = (JSON.parse(text) as { message?: unknown }).message; if (typeof m === 'string') message = m; } catch { /* not JSON */ }
    throw new ApiRefusal(res.status, message);
  }
  return parse(JSON.parse(text));
}

export const trimUrl = (u: string) => u.trim().replace(/\/+$/, '');

export async function fetchNotice(apiUrl: string): Promise<{ version: string; title: string; summary: string; monitoringSummary: string }> {
  const res = await fetch(`${trimUrl(apiUrl)}/agent/notice`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new ApiRefusal(res.status, 'Could not load the notice from this server');
  const n = (await res.json()) as { desktopAgent: { version: string; title: string; summary: string }; monitoring: { summary: string } };
  return { ...n.desktopAgent, monitoringSummary: n.monitoring.summary };
}

export async function pair(apiUrl: string, dto: PairDto): Promise<AgentSession> {
  return await post(`${trimUrl(apiUrl)}/agent/pair`, dto, (v) => AgentSessionSchema.parse(v));
}

interface Handlers {
  onState: (s: LinkState, detail?: string) => void;
  /** Rotated refresh token or sequence: must be persisted before anything else is sent. */
  onCredentials: (c: StoredCredentials) => void;
  onAnchor: (a: Anchor) => void;
  /** FR-ATT-023: the server asks "Are you still working?". */
  onChallenge: (c: { id: string; expiresAt: string }) => void;
}

const REFRESH_EVERY_MS = 12 * 60_000; // access tokens live 15 minutes

export class AgentLink {
  state: LinkState = 'connecting';
  private session: AgentSession | null = null;
  private socket: Socket | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Test hook (HRVO_AGENT_TEST): behave as if the network were down. */
  forcedOffline = false;

  constructor(private creds: StoredCredentials, private readonly h: Handlers) {}

  get credentials(): StoredCredentials { return this.creds; }

  async start(): Promise<void> {
    this.stopped = false;
    await this.refresh();
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.socket?.disconnect();
    this.socket = null;
  }

  private set(state: LinkState, detail?: string): void {
    this.state = state;
    this.h.onState(state, detail);
  }

  /** Rotate the refresh token. A refusal means the device was revoked; a network error means offline. */
  private async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    try {
      if (this.forcedOffline) throw new Error('offline (test)');
      const s = await post(`${this.creds.apiUrl}/agent/token`, { deviceId: this.creds.deviceId, refreshToken: this.creds.refreshToken }, (v) => AgentSessionSchema.parse(v));
      this.session = s;
      this.creds = { ...this.creds, refreshToken: s.refreshToken };
      this.h.onCredentials(this.creds);
      this.refreshTimer = setTimeout(() => void this.refresh(), REFRESH_EVERY_MS);
      if (this.socket?.connected) this.socket.emit('auth:refresh', { token: s.accessToken });
      else this.openSocket();
    } catch (err) {
      if (err instanceof ApiRefusal && (err.status === 401 || err.status === 403)) {
        this.stop();
        this.set('revoked', err.message);
        return;
      }
      this.set('offline', err instanceof Error ? err.message : 'Network error');
      this.refreshTimer = setTimeout(() => void this.refresh(), 15_000);
    }
  }

  private openSocket(): void {
    this.socket?.disconnect();
    const s = io(this.creds.apiUrl, {
      transports: ['websocket'],
      // purpose 'attendance': the agent's socket is an attendance connection (unlike the office UI's).
      auth: (cb) => cb({ token: this.session?.accessToken ?? '' }),
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30_000,
    });
    this.socket = s;
    s.on('connect', () => this.set('online'));
    s.on('disconnect', () => { if (!this.stopped && this.state !== 'revoked') this.set('offline', 'Disconnected'); });
    s.on('connect_error', () => { if (this.state !== 'revoked') this.set('offline', 'Cannot reach the server'); });
    s.on('auth:expired', () => void this.refresh());
    s.on('auth:revoked', () => { this.stop(); this.set('revoked', 'This device was disconnected'); });
    s.on('attendance:challenge', (c: { id?: unknown; expiresAt?: unknown }) => {
      if (typeof c?.id === 'string' && typeof c.expiresAt === 'string') this.h.onChallenge({ id: c.id, expiresAt: c.expiresAt });
    });
  }

  /** Monotonic across restarts (the server rejects a sequence it has seen) and within int4. */
  private nextSequence(): number {
    const seq = Math.max(this.creds.lastSequence + 1, Math.floor(Date.now() / 1000));
    this.creds = { ...this.creds, lastSequence: seq };
    this.h.onCredentials(this.creds);
    return seq;
  }

  /** Sends one signed heartbeat. false = not delivered (the caller buffers the interval). */
  async heartbeat(c: Counters): Promise<boolean> {
    const s = this.session;
    const sock = this.socket;
    if (this.forcedOffline || !s || !sock?.connected) return false;
    const payload = await signHeartbeatPayload({
      orgId: s.user.orgId, userId: s.user.id, deviceId: this.creds.deviceId, sessionId: s.sessionId,
      sequenceNumber: this.nextSequence(), nonce: randomUUID(),
      activeSeconds: c.activeSeconds, idleSeconds: c.idleSeconds, tabVisible: true, windowFocused: true, inCall: false,
    }, s.sessionSecret);
    try {
      const ack = (await sock.timeout(10_000).emitWithAck('presence:heartbeat', payload)) as { success: boolean; anchor?: Anchor };
      if (!ack.success) return false;
      if (ack.anchor) this.h.onAnchor(ack.anchor);
      return true;
    } catch {
      return false;
    }
  }

  async upload(batch: PendingBatch): Promise<OfflineSyncResult> {
    if (this.forcedOffline || !this.session) throw new Error('offline');
    return await post(`${this.creds.apiUrl}/agent/offline-sync`, { batchId: batch.batchId, anchor: batch.anchor, intervals: batch.intervals }, (v) => OfflineSyncResultSchema.parse(v), this.session.accessToken);
  }

  /** FR-ATT-023: "Yes, I am still working". The server decides whether it is in time. */
  async answerChallenge(id: string): Promise<boolean> {
    const sock = this.socket;
    if (!sock?.connected) return false;
    try {
      const r = (await sock.timeout(10_000).emitWithAck('attendance:challenge-response', { challengeId: id })) as { success: boolean };
      return r.success;
    } catch {
      return false;
    }
  }

  /** "Disconnect this device": revoke it on the server (its session family ends). */
  async revokeSelf(): Promise<void> {
    if (!this.session) return;
    const res = await fetch(`${this.creds.apiUrl}/agent/devices/${this.creds.deviceId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${this.session.accessToken}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new ApiRefusal(res.status, 'Could not disconnect this device');
  }

  /** Test hook: simulate losing and regaining the network. */
  async setForcedOffline(v: boolean): Promise<void> {
    this.forcedOffline = v;
    if (v) { this.socket?.disconnect(); this.set('offline', 'Offline (test)'); }
    else await this.refresh();
  }
}
