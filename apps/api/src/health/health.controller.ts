import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator.ts';
import { PrismaService } from '../common/prisma.service.ts';
import { coordinationEnabled, sharedRedis } from '../common/coordination.ts';

/**
 * Load-balancer health check (ADR 020): the database and, when coordinating, Redis. Public by
 * design; it reveals only "ok" or "unavailable" per dependency, never versions or errors.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async check(): Promise<{ status: 'ok'; db: 'ok'; redis: 'ok' | 'off' }> {
    const timeout = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]);
    let db = false;
    let redis: boolean | null = null;
    try { await timeout(this.prisma.getPool().query('SELECT 1')); db = true; } catch { db = false; }
    if (coordinationEnabled()) {
      try { redis = (await timeout(sharedRedis().ping())) === 'PONG'; } catch { redis = false; }
    }
    if (!db || redis === false) {
      throw new HttpException({ status: 'unavailable', db: db ? 'ok' : 'unavailable', redis: redis === null ? 'off' : redis ? 'ok' : 'unavailable' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { status: 'ok', db: 'ok', redis: redis ? 'ok' : 'off' };
  }
}
