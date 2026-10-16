/**
 * Rate-limit counters shared by every API task (ADR 020), for @nestjs/throttler (HTTP buckets and
 * the heartbeat limit). Fixed window per key and bucket; once over the limit the key is blocked for
 * the block duration. Atomic in one Lua script. Times in, milliseconds; times out, seconds (as the
 * in-memory store reports them).
 */
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

interface ThrottlerStorageRecord { totalHits: number; timeToExpire: number; isBlocked: boolean; timeToBlockExpire: number }

// KEYS: hits, block. ARGV: ttl ms, limit, block ms. Returns {hits, hitsTtlMs, blocked, blockTtlMs}.
const INCREMENT = `
local blockTtl = redis.call('pttl', KEYS[2])
if blockTtl > 0 then
  local hits = tonumber(redis.call('get', KEYS[1]) or '0')
  return {hits + 1, redis.call('pttl', KEYS[1]), 1, blockTtl}
end
local hits = redis.call('incr', KEYS[1])
if hits == 1 then redis.call('pexpire', KEYS[1], ARGV[1]) end
local ttl = redis.call('pttl', KEYS[1])
if ttl < 0 then redis.call('pexpire', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
if hits > tonumber(ARGV[2]) then
  local block = tonumber(ARGV[3])
  if block <= 0 then block = ttl end
  redis.call('set', KEYS[2], '1', 'PX', block)
  return {hits, ttl, 1, block}
end
return {hits, ttl, 0, 0}`;

export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis, private readonly prefix = 'rl') {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    const base = `${this.prefix}:${throttlerName}:${key}`;
    const [hits, hitsTtl, blocked, blockTtl] = (await this.redis.eval(INCREMENT, 2, `${base}:hits`, `${base}:block`, String(ttl), String(limit), String(blockDuration))) as [number, number, number, number];
    const sec = (ms: number) => Math.max(0, Math.ceil(ms / 1000));
    return { totalHits: hits, timeToExpire: sec(hitsTtl), isBlocked: blocked === 1, timeToBlockExpire: blocked === 1 ? sec(blockTtl) : 0 };
  }
}
