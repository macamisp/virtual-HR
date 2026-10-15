import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { AttendanceService } from './attendance.service.ts';
import type { JwtPayload, HeartbeatPayload } from '../../../../packages/shared/src/index.ts';

@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class AttendanceGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private jwtSecret: string;

  constructor(private readonly attendanceService: AttendanceService) {
    this.jwtSecret =
      process.env.JWT_SECRET ||
      'super-secret-jwt-access-key-change-in-production-min-32-chars';
  }

  /**
   * Authenticate WebSocket on handshake (FR-ATT-001, FR-AUTH-003)
   * Rejects unauthenticated connections immediately.
   */
  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = this.extractToken(client);
      if (!token) {
        client.disconnect(true);
        return;
      }

      const decoded = jwt.verify(token, this.jwtSecret) as JwtPayload;
      if (!decoded || !decoded.sub || !decoded.orgId) {
        client.disconnect(true);
        return;
      }

      client.data.user = decoded;
      client.join(`org:${decoded.orgId}`);
      client.join(`user:${decoded.sub}`);
    } catch (_err) {
      client.disconnect(true);
    }
  }

  /**
   * On disconnect, trigger the 120-second disconnect grace window (FR-ATT-002, Section 6.2 Row 10)
   */
  async handleDisconnect(client: Socket): Promise<void> {
    const user = client.data?.user as JwtPayload | undefined;
    if (user?.sub) {
      try {
        await this.attendanceService.onSocketDisconnect(user.sub);
        if (this.server) {
          this.server.to(`org:${user.orgId}`).emit('presence:update', {
            userId: user.sub,
            state: 'DISCONNECTED',
            statusMessage: 'Socket disconnected (grace window started)',
          });
        }
      } catch (_err) {
        // Ignored on teardown
      }
    }
  }

  /**
   * Ingest signed presence heartbeat from client (FR-ATT-004, Section 6.2)
   */
  @SubscribeMessage('presence:heartbeat')
  async handleHeartbeat(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: HeartbeatPayload,
  ) {
    const user = client.data?.user as JwtPayload | undefined;
    if (!user) {
      client.disconnect(true);
      return { success: false, error: 'Unauthorized' };
    }

    // Ensure payload user and org match authenticated socket
    payload.userId = user.sub;
    payload.orgId = user.orgId;

    try {
      const result = await this.attendanceService.ingestHeartbeat(payload);

      // 1. Broadcast presence update to the organisation room
      this.server.to(`org:${user.orgId}`).emit('presence:update', {
        userId: user.sub,
        state: result.currentState,
        actionTaken: result.actionTaken,
      });

      // 2. Emit attendance:event to the client socket
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
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Heartbeat rejected',
      };
    }
  }

  private extractToken(client: Socket): string | null {
    // 1. Check handshake.auth.token
    if (client.handshake.auth?.token) {
      return client.handshake.auth.token;
    }

    // 2. Check Authorization header
    const authHeader = client.handshake.headers?.authorization;
    if (authHeader) {
      const [type, token] = authHeader.split(' ');
      if (type === 'Bearer' && token) {
        return token;
      }
    }

    // 3. Check cookies
    const cookieHeader = client.handshake.headers?.cookie;
    if (cookieHeader) {
      const match = cookieHeader.match(/accessToken=([^;]+)/);
      if (match) {
        return match[1];
      }
    }

    return null;
  }
}
