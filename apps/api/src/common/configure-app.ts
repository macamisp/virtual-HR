/**
 * HTTP + WebSocket security baseline shared by main.ts and the e2e tests (ADR 005).
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { CSRF_HEADER, getCorsOrigins, isOriginAllowed, isProduction } from './config.ts';

/** Socket.IO adapter with the same origin allow-list as HTTP CORS. */
export class ConfiguredIoAdapter extends IoAdapter {
  override createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...(options as ServerOptions),
      cors: { origin: getCorsOrigins(), credentials: true },
      // CORS does not apply to the websocket transport; reject disallowed browser
      // origins explicitly to prevent cross-site WebSocket hijacking.
      allowRequest: (req, callback) => callback(null, isOriginAllowed(req.headers.origin)),
    });
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

  const origins = getCorsOrigins();
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      callback(null, isOriginAllowed(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', CSRF_HEADER],
    maxAge: 600,
  });
  if (origins.length === 0) {
    throw new Error('No CORS origins configured');
  }

  app.useWebSocketAdapter(new ConfiguredIoAdapter(app));
}
