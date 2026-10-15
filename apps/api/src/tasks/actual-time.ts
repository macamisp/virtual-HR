/**
 * FR-TASK-008 estimate vs actual. Actual minutes are the finished time entries (timers and
 * manual time, FR-TS-003/004) logged on each task.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';

export const ACTUAL_TIME_PROVIDER = Symbol('ACTUAL_TIME_PROVIDER');

export interface ActualTimeProvider {
  /** Logged minutes per task id; tasks without entries are absent from the map. */
  actualMinutes(orgId: string, taskIds: string[]): Promise<Map<string, number>>;
}

@Injectable()
export class TimeEntriesActualTime implements ActualTimeProvider {
  constructor(private readonly prisma: PrismaService) {}

  async actualMinutes(orgId: string, taskIds: string[]): Promise<Map<string, number>> {
    if (taskIds.length === 0) return new Map();
    return await this.prisma.runWithTenantContext(orgId, async (db) => {
      const res = await db.query<{ task_id: string; minutes: number }>(
        `SELECT task_id, SUM(minutes)::int AS minutes FROM time_entries
         WHERE task_id = ANY($1::uuid[]) AND ended_at IS NOT NULL GROUP BY task_id`,
        [taskIds],
      );
      return new Map(res.rows.map((r) => [r.task_id, r.minutes]));
    });
  }
}

export function isOverrun(estimateMinutes: number | null, actualMinutes: number | null): boolean {
  return estimateMinutes !== null && actualMinutes !== null && actualMinutes > estimateMinutes;
}
