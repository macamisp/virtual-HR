/**
 * The real leave and holiday providers for the attendance engine (FR-ATT-022, ADR 027). Until
 * now the engine ran with none, so approved leave and holidays never reached attendance.
 * Query the tenant-scoped database on every read so approvals and HR calendar edits are
 * immediately visible on every API process (FR-ATT-022).
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import type { IHolidayProvider, ILeaveProvider } from '../../../../packages/shared/src/index.ts';

@Injectable()
export class PgHolidayProvider implements IHolidayProvider {
  constructor(private readonly prisma: PrismaService) {}

  async isHoliday(orgId: string, date: string): Promise<boolean> {
    const yes = await this.prisma.runWithTenantContext(orgId, async (db) =>
      (await db.query(`SELECT 1 FROM public_holidays WHERE date = $1::date`, [date])).rowCount === 1);
    return yes;
  }
}

@Injectable()
export class PgLeaveProvider implements ILeaveProvider {
  constructor(private readonly prisma: PrismaService) {}

  async isUserOnApprovedLeave(orgId: string, userId: string, date: string): Promise<boolean> {
    const yes = await this.prisma.runWithTenantContext(orgId, async (db) =>
      (await db.query(`SELECT 1 FROM leave_requests WHERE user_id = $1 AND status = 'APPROVED' AND $2::date BETWEEN start_date AND end_date`, [userId, date])).rowCount === 1);
    return yes;
  }
}
