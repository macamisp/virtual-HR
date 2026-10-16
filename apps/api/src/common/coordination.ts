/**
 * Multi-instance coordination (ADR 020). With COORDINATION=redis (AWS), API tasks share Socket.IO
 * rooms (Redis adapter), rate-limit counters and the attendance session lock through Redis. Off by
 * default (one process: local development, tests).
 */
import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';

export const coordinationEnabled = (): boolean => process.env.COORDINATION === 'redis';

/** Same settings as BullMQ's connection; REDIS_TLS=true for ElastiCache in-transit encryption. */
export function redisOptions(): RedisOptions {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number.parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number.parseInt(process.env.REDIS_DB || '0', 10),
    ...(process.env.REDIS_TLS === 'true' ? { tls: {} } : {}),
  };
}

const clients: Redis[] = [];
let shared: Redis | null = null;

/** One shared client for locks and rate limits (commands only). */
export function sharedRedis(): Redis {
  shared ??= track(new Redis({ ...redisOptions(), maxRetriesPerRequest: 3 }));
  return shared;
}

/**
 * A dedicated connection (the Socket.IO adapter needs separate publish and subscribe clients).
 * Its owner closes it (ConfiguredIoAdapter, after the Socket.IO server has closed).
 */
export function newRedis(): Redis {
  const r = new Redis({ ...redisOptions(), maxRetriesPerRequest: null });
  r.on('error', (e: Error) => console.error('Redis error:', e.message));
  return r;
}

function track(r: Redis): Redis {
  // Never log the password: ioredis errors carry only the host and the reason.
  r.on('error', (e: Error) => console.error('Redis error:', e.message));
  clients.push(r);
  return r;
}

export async function closeCoordination(): Promise<void> {
  const all = clients.splice(0);
  shared = null;
  await Promise.all(all.map((c) => c.quit().catch(() => c.disconnect())));
}

/** Apps in this process using the shared connections (normally one; tests start two). */
let apps = 0;

@Injectable()
export class CoordinationShutdown implements OnModuleInit, OnApplicationShutdown {
  onModuleInit(): void {
    apps += 1;
  }

  /** The last app to stop closes the connections, so another app's adapter never writes to a closed one. */
  async onApplicationShutdown(): Promise<void> {
    apps = Math.max(0, apps - 1);
    if (apps === 0) await closeCoordination();
  }
}
