import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectThrottlerStorage, ThrottlerStorage } from '@nestjs/throttler';
import { Server, Socket } from 'socket.io';
import type pg from 'pg';
import { AttendanceService } from './attendance.service.ts';
import { PrismaService } from '../common/prisma.service.ts';
import { getJwtSecret, getRateLimits } from '../common/config.ts';
import { anchorKey, signAnchor } from '../agent/offline-sync.ts';
import { AttendanceFlagsService } from './attendance-flags.service.ts';
import { isIP } from 'node:net';
import { verifyToken } from '../auth/tokens.ts';
import type { JwtPayload, HeartbeatPayload, StateMachineTransitionResult } from '../../../../packages/shared/src/index.ts';

const AUTH_EVENTS_CHANNEL = 'hrvo_auth_events';

/** Per-socket auth state. Never contains the raw token. */
interface SocketAuth {
  user: JwtPayload;
  sessionId: string;
  familyId: string;
  expiresAtMs: number;
  /** ADR 018: set when this login belongs to a paired, unrevoked desktop agent. */
  agentDeviceId: string | null;
}

type AuthEvent =
  | { type: 'session_revoked'; orgId: string; userId: string; sessionId: string; familyId: string; reason: string }
  | { type: 'user_deactivated'; orgId: string; userId: string; status: string };

/**
 * Presence gateway (FR-ATT-001..004) with socket lifecycle enforcement (FR-AUTH-003, ADR 005):
 *  - the handshake token must be a valid access token whose session is live and whose user is ACTIVE;
 *  - the socket is disconnected when its access token expires unless the client sends
 *    `auth:refresh` with a newer token first;
 *  - revoked sessions/families (logout, reuse detection, password reset) and suspended or
 *    offboarded users are disconnected immediately via Postgres LISTEN/NOTIFY, with a
 *    periodic re-validation sweep as a safety net.
 * CORS and Origin checks are applied by ConfiguredIoAdapter (main.ts).
 */
@WebSocketGateway()
export class AttendanceGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private listener: pg.Client | null = null;
  private listenerRetry: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private expiryTimers = new Map<string, NodeJS.Timeout>();
  private shuttingDown = false;
  private readonly heartbeatLimit = getRateLimits().heartbeat;
  private readonly anchorKey = anchorKey(getJwtSecret());
  private readonly agentTouched = new Map<string, number>();

  /** Device list shows when each agent last reported; written at most once a minute per device. */
  private touchAgent(orgId: string, deviceId: string): void {
    const now = Date.now();
    if ((this.agentTouched.get(deviceId) ?? 0) > now - 60_000) return;
    this.agentTouched.set(deviceId, now);
    void this.prisma.runWithTenantContext(orgId, (db) => db.query(`UPDATE agent_devices SET last_seen_at = now() WHERE id = $1`, [deviceId])).catch(() => undefined);
  }
  private readonly presenceListeners: Array<(orgId: string, userId: string, state: string) => void> = [];

  /** FR-VO-003: the virtual office shows the attendance state on avatars. */
  onPresence(listener: (orgId: string, userId: string, state: string) => void): void {
    this.presenceListeners.push(listener);
  }

  private publishPresence(orgId: string, payload: { userId: string; state: string; [k: string]: unknown }): void {
    this.server?.to(`org:${orgId}`).emit('presence:update', payload);
    for (const l of this.presenceListeners) {
      try { l(orgId, payload.userId, payload.state); } catch { /* a listener never breaks attendance */ }
    }
  }

  constructor(
    private readonly attendanceService: AttendanceService,
    private readonly prisma: PrismaService,
    @InjectThrottlerStorage() private readonly throttlerStorage: ThrottlerStorage,
    private readonly flags: AttendanceFlagsService,
  ) {}

  /**
   * FR-ATT-018: the client's IP and coarse location. Cloudflare's CF-Connecting-IP and CF-IPCountry
   * are only trusted with TRUST_PROXY_HEADERS=cloudflare (the API must then be reachable only
   * through Cloudflare); otherwise anyone could forge them, so the socket address is used.
   */
  private network(client: Socket): { ip: string | undefined; country: string | null } {
    const address = client.handshake.address || undefined;
    if (process.env.TRUST_PROXY_HEADERS !== 'cloudflare') return { ip: address, country: null };
    const h = client.handshake.headers;
    const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim();
    const cfIp = one(h['cf-connecting-ip']);
    const cfCountry = one(h['cf-ipcountry'])?.toUpperCase();
    return { ip: cfIp && isIP(cfIp) ? cfIp : address, country: cfCountry && /^[A-Z0-9]{2}$/.test(cfCountry) && cfCountry !== 'XX' ? cfCountry : null };
  }

  async onModuleInit(): Promise<void> {
    await this.startListener();
    const sweepMs = Number.parseInt(process.env.SOCKET_REVALIDATE_MS || '60000', 10);
    this.sweepTimer = setInterval(() => void this.revalidateAll(), sweepMs);
    this.sweepTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.listenerRetry) clearTimeout(this.listenerRetry);
    for (const t of this.expiryTimers.values()) clearTimeout(t);
    this.expiryTimers.clear();
    const listener = this.listener;
    this.listener = null;
    await listener?.end().catch(() => undefined);
  }

  /**
   * Authenticate on handshake (FR-ATT-001, FR-AUTH-003). Runs as Socket.IO middleware so the
   * connection is only accepted once the token and session are verified; rejected clients
   * receive connect_error and no event handler ever sees an unauthenticated socket.
   */
  afterInit(server: Server): void {
    server.use((client, next) => {
      const token = this.extractToken(client);
      if (!token) {
        next(new Error('Unauthorized'));
        return;
      }
      this.authenticate(token)
        .then((auth) => {
          if (!auth) {
            next(new Error('Unauthorized'));
            return;
          }
          client.data.auth = auth;
          // ADR 015: the virtual office opens its own socket; it must not count as the
          // attendance connection that keeps a session open.
          client.data.purpose = client.handshake.auth?.purpose === 'office' ? 'office' : 'attendance';
          next();
        })
        .catch(() => next(new Error('Unauthorized')));
    });
  }

  handleConnection(client: Socket): void {
    const auth = client.data?.auth as SocketAuth | undefined;
    if (!auth) {
      client.disconnect(true);
      return;
    }
    this.applyAuth(client, auth);
    client.join(`org:${auth.user.orgId}`);
    client.join(`user:${auth.user.sub}`);
  }

  /** On disconnect, trigger the 120-second disconnect grace window (FR-ATT-002, Section 6.2 Row 10). */
  async handleDisconnect(client: Socket): Promise<void> {
    this.clearExpiry(client.id);
    const auth = client.data?.auth as SocketAuth | undefined;
    if (auth?.user.sub) {
      try {
        // Other tabs/devices of the same user may still be connected; only the last socket
        // leaving starts the grace window.
        const remaining = this.server ? await this.server.in(`user:${auth.user.sub}`).fetchSockets() : [];
        if (remaining.some((sock) => sock.data?.purpose !== 'office')) return;
        await this.attendanceService.onSocketDisconnect(auth.user.sub, undefined, auth.user.orgId);
        if (this.server) {
          this.publishPresence(auth.user.orgId, {
            userId: auth.user.sub,
            state: 'DISCONNECTED',
            statusMessage: 'Socket disconnected (grace window started)',
          });
        }
      } catch {
        // Ignored on teardown
      }
    }
  }

  /**
   * Extend the socket's lifetime with a newer access token (after /auth/refresh).
   * The token must belong to the same user and organisation.
   */
  @SubscribeMessage('auth:refresh')
  async handleAuthRefresh(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { token?: unknown },
  ) {
    const current = client.data?.auth as SocketAuth | undefined;
    if (!current || typeof body?.token !== 'string') {
      return { success: false, error: 'Unauthorized' };
    }
    try {
      const next = await this.authenticate(body.token);
      if (!next || next.user.sub !== current.user.sub || next.user.orgId !== current.user.orgId) {
        return { success: false, error: 'Token rejected' };
      }
      if (next.familyId !== current.familyId) {
        client.leave(`family:${current.familyId}`);
      }
      this.applyAuth(client, next);
      return { success: true, expiresAt: new Date(next.expiresAtMs).toISOString() };
    } catch {
      return { success: false, error: 'Token rejected' };
    }
  }

  /** Ingest signed presence heartbeat from client (FR-ATT-004, Section 6.2) */
  @SubscribeMessage('presence:heartbeat')
  async handleHeartbeat(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: HeartbeatPayload,
  ) {
    const auth = client.data?.auth as SocketAuth | undefined;
    if (!auth || auth.expiresAtMs <= Date.now()) {
      client.disconnect(true);
      return { success: false, error: 'Unauthorized' };
    }
    const user = auth.user;

    const { limit, ttl } = this.heartbeatLimit;
    const record = await this.throttlerStorage.increment(`heartbeat:${user.orgId}:${user.sub}`, ttl, limit, ttl, 'heartbeat');
    if (record.isBlocked) {
      // FR-ATT-017: repeated flooding is flagged for review (the heartbeat is simply refused).
      void this.flags.rejected(user.orgId, user.sub, 'FLOOD', new Date(), await this.attendanceService.timeZoneOf(user.orgId)).catch(() => undefined);
      return { success: false, error: 'Rate limit exceeded' };
    }

    // Ensure payload user and org match authenticated socket
    payload.userId = user.sub;
    payload.orgId = user.orgId;
    // ADR 018: an agent's device id comes from its pairing, never from the client.
    const agentDeviceId = auth.agentDeviceId;
    if (agentDeviceId) payload.deviceId = agentDeviceId;

    try {
      const where = this.network(client);
      const result = await this.attendanceService.ingestHeartbeat(payload, undefined, where.ip, agentDeviceId ? 'AGENT' : 'WEB', where.country);
      if (result.challenge) {
        // FR-ATT-023: every tab and the agent of this person show the question.
        this.server?.to(`user:${user.sub}`).emit('attendance:challenge', { id: result.challenge.id, expiresAt: result.challenge.expiresAt.toISOString() });
      }

      this.publishPresence(user.orgId, {
        userId: user.sub,
        state: result.currentState,
        actionTaken: result.actionTaken,
      });

      client.emit('attendance:event', {
        actionTaken: result.actionTaken,
        session: result.session,
        currentState: result.currentState,
      });

      if (agentDeviceId) {
        // FR-ATT-012: the anchor offline intervals are measured from (server time, signed).
        const serverTimeMs = result.session.lastHeartbeatAt.getTime();
        this.touchAgent(user.orgId, agentDeviceId);
        return {
          success: true,
          actionTaken: result.actionTaken,
          currentState: result.currentState,
          anchor: { serverTimeMs, signature: signAnchor(this.anchorKey, { orgId: user.orgId, userId: user.sub, deviceId: agentDeviceId }, serverTimeMs) },
        };
      }
      return {
        success: true,
        actionTaken: result.actionTaken,
        currentState: result.currentState,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Heartbeat rejected';
      // FR-ATT-017: forged, replayed or out-of-order signals are flagged once they repeat.
      if (/^(Heartbeat rejected|Unauthorized: No active session secret)/.test(message)) {
        void this.flags.rejected(user.orgId, user.sub, 'INVALID', new Date(), await this.attendanceService.timeZoneOf(user.orgId)).catch(() => undefined);
      }
      return { success: false, error: message };
    }
  }

  /** FR-ATT-023: the desktop agent answers the presence challenge over its socket. */
  @SubscribeMessage('attendance:challenge-response')
  async handleChallengeResponse(@ConnectedSocket() client: Socket, @MessageBody() body: { challengeId?: unknown }) {
    const auth = client.data?.auth as SocketAuth | undefined;
    if (!auth || typeof body?.challengeId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.challengeId)) return { success: false, error: 'Invalid request' };
    try {
      const result = await this.attendanceService.answerChallenge(auth.user.orgId, auth.user.sub, body.challengeId);
      this.broadcastTransition(auth.user.orgId, auth.user.sub, result);
      return { success: true, currentState: result.currentState };
    } catch {
      return { success: false, error: 'The question has expired. Any input resumes tracking.' };
    }
  }

  /** Verifies the JWT and that its session is live and its user ACTIVE. Returns null if not. */
  private async authenticate(token: string): Promise<SocketAuth | null> {
    const { payload } = verifyToken(token, ['access']);
    const sessionId = payload.sid as string;
    const familyId = await this.liveFamilyId(payload.orgId, payload.sub, sessionId);
    if (!familyId) return null;
    const agentDeviceId = await this.prisma.runWithTenantContext(payload.orgId, async (db) =>
      (await db.query<{ id: string }>(`SELECT id FROM agent_devices WHERE family_id = $1 AND revoked_at IS NULL`, [familyId])).rows[0]?.id ?? null);
    return {
      user: payload,
      sessionId,
      familyId,
      expiresAtMs: (payload.exp ?? 0) * 1000,
      agentDeviceId,
    };
  }

  /** Family id if the session is not revoked (rotation does not count) and the user is ACTIVE. */
  private async liveFamilyId(orgId: string, userId: string, sessionId: string): Promise<string | null> {
    return await this.prisma.runWithTenantContext(orgId, async (db) => {
      const res = await db.query<{ family_id: string; is_revoked: boolean; revoked_reason: string | null; status: string }>(
        `SELECT s.family_id, s.is_revoked, s.revoked_reason, u.status
         FROM auth_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = $1 AND s.user_id = $2 AND s.org_id = $3`,
        [sessionId, userId, orgId],
      );
      const row = res.rows[0];
      if (!row || row.status !== 'ACTIVE') return null;
      if (row.is_revoked && row.revoked_reason !== 'ROTATED') return null;
      return row.family_id;
    });
  }

  private applyAuth(client: Socket, auth: SocketAuth): void {
    client.data.auth = auth;
    client.join(`family:${auth.familyId}`);
    this.clearExpiry(client.id);
    const delay = Math.max(0, auth.expiresAtMs - Date.now());
    const timer = setTimeout(() => {
      this.expiryTimers.delete(client.id);
      client.emit('auth:expired', { reason: 'ACCESS_TOKEN_EXPIRED' });
      client.disconnect(true);
    }, delay);
    timer.unref();
    this.expiryTimers.set(client.id, timer);
  }

  private clearExpiry(socketId: string): void {
    const t = this.expiryTimers.get(socketId);
    if (t) {
      clearTimeout(t);
      this.expiryTimers.delete(socketId);
    }
  }

  private disconnectRoom(room: string, reason: string): void {
    if (!this.server) return;
    this.server.to(room).emit('auth:revoked', { reason });
    this.server.in(room).disconnectSockets(true);
  }

  /** Push a REST-initiated transition (e.g. break start/end) to the org board and the user's own sockets. */
  broadcastTransition(orgId: string, userId: string, result: StateMachineTransitionResult): void {
    if (!this.server) return;
    this.publishPresence(orgId, {
      userId,
      state: result.currentState,
      actionTaken: result.actionTaken,
    });
    this.server.to(`user:${userId}`).emit('attendance:event', {
      actionTaken: result.actionTaken,
      currentState: result.currentState,
      session: result.session,
    });
  }

  /** Push an event to every socket of one user (e.g. a new in-app notification). */
  notifyUser(userId: string, event: string, payload: Record<string, unknown>): void {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }

  /** Public for tests; applies one hrvo_auth_events notification. */
  handleAuthEvent(event: AuthEvent): void {
    if (event.type === 'session_revoked') {
      this.disconnectRoom(`family:${event.familyId}`, event.reason);
    } else if (event.type === 'user_deactivated') {
      this.disconnectRoom(`user:${event.userId}`, `USER_${event.status}`);
    }
  }

  private async startListener(): Promise<void> {
    if (this.shuttingDown) return;
    const listener = this.prisma.createListenerClient();
    listener.on('notification', (msg) => {
      if (msg.channel !== AUTH_EVENTS_CHANNEL || !msg.payload) return;
      try {
        this.handleAuthEvent(JSON.parse(msg.payload) as AuthEvent);
      } catch {
        // Malformed payloads are ignored; the sweep re-validates.
      }
    });
    listener.on('error', () => this.scheduleListenerRestart(listener));
    listener.on('end', () => this.scheduleListenerRestart(listener));
    try {
      await listener.connect();
      await listener.query(`LISTEN ${AUTH_EVENTS_CHANNEL}`);
      this.listener = listener;
      // Events may have been missed while not listening.
      void this.revalidateAll();
    } catch {
      this.scheduleListenerRestart(listener);
    }
  }

  private scheduleListenerRestart(failed: pg.Client): void {
    if (this.shuttingDown || this.listenerRetry) return;
    if (this.listener === failed) this.listener = null;
    failed.end().catch(() => undefined);
    this.listenerRetry = setTimeout(() => {
      this.listenerRetry = null;
      void this.startListener();
    }, 2000);
    this.listenerRetry.unref();
  }

  /** Safety net: re-check every connected socket's session and user status. */
  async revalidateAll(): Promise<void> {
    if (!this.server) return;
    const sockets = await this.server.fetchSockets();
    for (const s of sockets) {
      const auth = s.data?.auth as SocketAuth | undefined;
      if (!auth) continue;
      try {
        const familyId = await this.liveFamilyId(auth.user.orgId, auth.user.sub, auth.sessionId);
        if (!familyId) {
          s.emit('auth:revoked', { reason: 'SESSION_INVALID' });
          s.disconnect(true);
        }
      } catch {
        // Database unavailable: keep the socket; the next sweep retries.
      }
    }
  }

  private extractToken(client: Pick<Socket, 'handshake'>): string | null {
    // Cookies are deliberately not accepted: ambient credentials enable cross-site WebSocket hijacking.
    const authToken = client.handshake.auth?.token;
    if (typeof authToken === 'string' && authToken) {
      return authToken;
    }
    const authHeader = client.handshake.headers?.authorization;
    if (authHeader) {
      const [type, token] = authHeader.split(' ');
      if (type === 'Bearer' && token) {
        return token;
      }
    }
    return null;
  }
}
