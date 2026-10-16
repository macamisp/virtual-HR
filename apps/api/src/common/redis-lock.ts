/**
 * Distributed lock on Redis (ADR 020): serialises updates to one person's attendance session across
 * API tasks (heartbeats on the realtime task, breaks and corrections on REST tasks, the reconciler
 * in the job runner). Single Redis node semantics (ElastiCache primary): SET NX PX with a random
 * token, compare-and-delete release, and renewal while the critical section runs.
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

export class LockTimeoutError extends Error {
  constructor(key: string) { super(`Timed out waiting for lock ${key}`); this.name = 'LockTimeoutError'; }
}

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

export interface RedisLockOptions {
  /** Lock lifetime; renewed every ttl/3 while held (unless renew is false). */
  ttlMs?: number;
  /** How long to wait for the lock before LockTimeoutError. */
  waitMs?: number;
  renew?: boolean;
}

export class RedisLock {
  private readonly ttlMs: number;
  private readonly waitMs: number;
  private readonly renew: boolean;

  constructor(private readonly redis: Redis, opts: RedisLockOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10_000;
    this.waitMs = opts.waitMs ?? 15_000;
    this.renew = opts.renew ?? true;
  }

  async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const key = `lock:${name}`;
    const token = randomUUID();
    const deadline = Date.now() + this.waitMs;
    let delay = 10;
    while ((await this.redis.set(key, token, 'PX', this.ttlMs, 'NX')) !== 'OK') {
      if (Date.now() >= deadline) throw new LockTimeoutError(name);
      await new Promise((r) => setTimeout(r, delay + Math.random() * delay));
      delay = Math.min(delay * 2, 200);
    }
    const timer = this.renew
      ? setInterval(() => { void this.redis.eval(RENEW, 1, key, token, String(this.ttlMs)).catch(() => undefined); }, Math.max(20, Math.floor(this.ttlMs / 3)))
      : null;
    timer?.unref();
    try {
      return await fn();
    } finally {
      if (timer) clearInterval(timer);
      await this.redis.eval(RELEASE, 1, key, token).catch(() => undefined);
    }
  }
}
