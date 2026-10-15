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
import { getRateLimits } from '../common/config.ts';
import { verifyToken } from '../auth/tokens.ts';
import type { JwtPayload, HeartbeatPayload } from '../../../../packages/shared/src/index.ts';

const AUTH_EVENTS_CHANNEL = 'hrvo_auth_events';

/** Per-socket auth state. Never contains the raw token. */
interface SocketAuth {
  user: JwtPayload;
  sessionId: string;
  familyId: string;
  expiresAtMs: number;
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

  constructor(
    private readonly attendanceService: AttendanceService,
    private readonly prisma: PrismaService,
    @InjectThrottlerStorage() private readonly throttlerStorage: ThrottlerStorage,
  ) {}

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
        await this.attendanceService.onSocketDisconnect(auth.user.sub);
        if (this.server) {
          this.server.to(`org:${auth.user.orgId}`).emit('presence:update', {
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
      return { success: false, error: 'Rate limit exceeded' };
    }

    // Ensure payload user and org match authenticated socket
    payload.userId = user.sub;
    payload.orgId = user.orgId;

    try {
      const result = await this.attendanceService.ingestHeartbeat(payload);

      this.server.to(`org:${user.orgId}`).emit('presence:update', {
        userId: user.sub,
        state: result.currentState,
        actionTaken: result.actionTaken,
      });

      client.emit('attendance:event', {
        actionTaken: result.actionTaken,
        session: result.session,
        currentState: result.currentState,
      });

      return {
        success: true,
        actionTaken: result.actionTaken,
        currentState: result.currentState,
      };
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Heartbeat rejected',
      };
    }
  }

  /** Verifies the JWT and that its session is live and its user ACTIVE. Returns null if not. */
  private async authenticate(token: string): Promise<SocketAuth | null> {
    const { payload } = verifyToken(token, ['access']);
    const sessionId = payload.sid as string;
    const familyId = await this.liveFamilyId(payload.orgId, payload.sub, sessionId);
    if (!familyId) return null;
    return {
      user: payload,
      sessionId,
      familyId,
      expiresAtMs: (payload.exp ?? 0) * 1000,
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
