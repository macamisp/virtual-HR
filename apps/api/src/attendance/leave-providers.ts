/**
 * The real leave and holiday providers for the attendance engine (FR-ATT-022, ADR 027). Until
 * now the engine ran with none, so approved leave and holidays never reached attendance.
 * Answers are cached briefly per organisation; a decision or a calendar change clears the cache
 * on the task that made it, and the others catch up within the TTL.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import type { IHolidayProvider, ILeaveProvider } from '../../../../packages/shared/src/index.ts';

const TTL_MS = 10_000;

class OrgCache<T> {
  private readonly entries = new Map<string, { at: number; value: T }>();
  get(orgId: string, key: string): T | undefined {
    const e = this.entries.get(`${orgId}|${key}`);
    if (!e || Date.now() - e.at > TTL_MS) return undefined;
    return e.value;
  }
  set(orgId: string, key: string, value: T): void {
    if (this.entries.size > 5000) this.entries.clear();
    this.entries.set(`${orgId}|${key}`, { at: Date.now(), value });
  }
  clear(orgId: string): void {
    for (const k of this.entries.keys()) if (k.startsWith(`${orgId}|`)) this.entries.delete(k);
  }
}

@Injectable()
export class PgHolidayProvider implements IHolidayProvider {
  private readonly cache = new OrgCache<boolean>();
  constructor(private readonly prisma: PrismaService) {}

  async isHoliday(orgId: string, date: string): Promise<boolean> {
    const hit = this.cache.get(orgId, date);
    if (hit !== undefined) return hit;
    const yes = await this.prisma.runWithTenantContext(orgId, async (db) =>
      (await db.query(`SELECT 1 FROM public_holidays WHERE date = $1::date`, [date])).rowCount === 1);
    this.cache.set(orgId, date, yes);
    return yes;
  }

  invalidate(orgId: string): void {
    this.cache.clear(orgId);
  }
}

@Injectable()
export class PgLeaveProvider implements ILeaveProvider {
  private readonly cache = new OrgCache<boolean>();
  constructor(private readonly prisma: PrismaService) {}

  async isUserOnApprovedLeave(orgId: string, userId: string, date: string): Promise<boolean> {
    const key = `${userId}|${date}`;
    const hit = this.cache.get(orgId, key);
    if (hit !== undefined) return hit;
    const yes = await this.prisma.runWithTenantContext(orgId, async (db) =>
      (await db.query(`SELECT 1 FROM leave_requests WHERE user_id = $1 AND status = 'APPROVED' AND $2::date BETWEEN start_date AND end_date`, [userId, date])).rowCount === 1);
    this.cache.set(orgId, key, yes);
    return yes;
  }

  invalidate(orgId: string): void {
    this.cache.clear(orgId);
  }
}
