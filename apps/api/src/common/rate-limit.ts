/**
 * Per-route rate limiting (NFR-SEC; login, refresh, password reset, heartbeat).
 *
 * One named throttler per bucket. A bucket only counts requests on handlers tagged
 * with @RateLimit('<bucket>'); every other route skips it. Limits come from env via
 * getRateLimits() and are read when the module initialises.
 *
 * Storage is the throttler's in-memory store, so limits are per API instance. A shared
 * Redis store is needed before running more than one instance (ADR 005).
 */
import { SetMetadata } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { getRateLimits } from './config.ts';

export type HttpRateLimitBucket = 'login' | 'refresh' | 'passwordReset';

const RATE_LIMIT_KEY = 'hrvo:rateLimitBucket';

export const RateLimit = (bucket: HttpRateLimitBucket) => SetMetadata(RATE_LIMIT_KEY, bucket);

export function rateLimitModule() {
  return ThrottlerModule.forRootAsync({
    useFactory: () => {
      const limits = getRateLimits();
      const buckets: HttpRateLimitBucket[] = ['login', 'refresh', 'passwordReset'];
      return {
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
