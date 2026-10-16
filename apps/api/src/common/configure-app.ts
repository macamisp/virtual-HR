/**
 * HTTP + WebSocket security baseline shared by main.ts and the e2e tests (ADR 005).
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createAdapter } from '@socket.io/redis-adapter';
import { coordinationEnabled, newRedis } from './coordination.ts';
import type { Redis } from 'ioredis';
import type { Server } from 'socket.io';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { CSRF_HEADER, getCorsOrigins, isOriginAllowed, isProduction } from './config.ts';

/** Socket.IO adapter with the same origin allow-list as HTTP CORS. */
export class ConfiguredIoAdapter extends IoAdapter {
  override createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, {
      ...(options as ServerOptions),
      cors: { origin: getCorsOrigins(), credentials: true },
      // CORS does not apply to the websocket transport; reject disallowed browser
      // origins explicitly to prevent cross-site WebSocket hijacking.
      allowRequest: (req, callback) => callback(null, isOriginAllowed(req.headers.origin)),
    });
    // ADR 020: rooms (user:, org:, family:) span every API task, so a REST task can reach a socket
    // held by the realtime task (notifications, revocations, chat, meeting rings).
    if (coordinationEnabled()) {
      const pub = newRedis();
      const sub = newRedis();
      this.redisClients.push(pub, sub);
      server.adapter(createAdapter(pub, sub));
    }
    return server;
  }

  private readonly redisClients: Redis[] = [];

  /** Close the adapter's connections only after the Socket.IO server (it unsubscribes on close). */
  override async close(server: Server): Promise<void> {
    await super.close(server);
    await Promise.all(this.redisClients.splice(0).map((c) => c.quit().catch(() => c.disconnect())));
  }
}

export function configureApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  if (process.env.TRUST_PROXY) {
    // Needed behind a load balancer so rate limits key on the client IP, not the proxy's.
    express.set('trust proxy', process.env.TRUST_PROXY);
  }

  app.use(
    helmet({
      // JSON API: nothing may be loaded, framed or submitted from its responses.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: isProduction() ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );
  app.use(cookieParser());
  // ADR 016: LiveKit webhooks are signed over the exact bytes, so keep them raw. The content type
  // (application/webhook+json) is not one Nest's JSON parser consumes.
  app.use((req: { url?: string; method?: string; rawBody?: Buffer; on: (e: string, cb: (c?: Buffer) => void) => void }, _res: unknown, next: (err?: unknown) => void) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/media/livekit/webhook')) { next(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c?: Buffer) => { if (!c) return; size += c.length; if (size > 1_000_000) { next(new Error('Webhook too large')); return; } chunks.push(c); });
    req.on('end', () => { req.rawBody = Buffer.concat(chunks); next(); });
    req.on('error', (e) => next(e));
  });

  const origins = getCorsOrigins();
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      callback(null, isOriginAllowed(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', CSRF_HEADER],
    // Lets the web app read the server's filename for exports.
    exposedHeaders: ['Content-Disposition', 'X-View-Only'],
    maxAge: 600,
  });
  if (origins.length === 0) {
    throw new Error('No CORS origins configured');
  }

  app.useWebSocketAdapter(new ConfiguredIoAdapter(app));
}
