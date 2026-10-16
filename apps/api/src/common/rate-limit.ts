/**
 * Per-route rate limiting (NFR-SEC; login, refresh, password reset, heartbeat).
 *
 * One named throttler per bucket. A bucket only counts requests on handlers tagged
 * with @RateLimit('<bucket>'); every other route skips it. Limits come from env via
 * getRateLimits() and are read when the module initialises.
 *
 * Storage: in memory for a single process; with COORDINATION=redis the counters are shared by
 * every API task (RedisThrottlerStorage, ADR 020).
 */
import { SetMetadata } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { getRateLimits } from './config.ts';
import { coordinationEnabled, sharedRedis } from './coordination.ts';
import { RedisThrottlerStorage } from './redis-throttler-storage.ts';

export type HttpRateLimitBucket = 'login' | 'refresh' | 'passwordReset' | 'vault' | 'share' | 'unsubscribe' | 'agentPair' | 'agentToken';

const RATE_LIMIT_KEY = 'hrvo:rateLimitBucket';

export const RateLimit = (bucket: HttpRateLimitBucket) => SetMetadata(RATE_LIMIT_KEY, bucket);

export function rateLimitModule() {
  return ThrottlerModule.forRootAsync({
    useFactory: () => {
      const limits = getRateLimits();
      const buckets: HttpRateLimitBucket[] = ['login', 'refresh', 'passwordReset', 'vault', 'share', 'unsubscribe', 'agentPair', 'agentToken'];
      return {
        // ADR 020: one set of counters for every API task (in memory when running alone).
        ...(coordinationEnabled() ? { storage: new RedisThrottlerStorage(sharedRedis()) } : {}),
        errorMessage: 'Too many requests; please slow down',
        throttlers: buckets.map((name) => ({
          name,
          limit: limits[name].limit,
          ttl: limits[name].ttl,
          skipIf: (context: ExecutionContext) =>
            Reflect.getMetadata(RATE_LIMIT_KEY, context.getHandler()) !== name,
        })),
      };
    },
  });
}
