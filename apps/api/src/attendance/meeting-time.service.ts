import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { Permission, userCan } from '../../../../packages/shared/src/auth/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import type { MeetingInterval, MeetingIntervalList } from '../../../../packages/shared/src/attendance/api.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ADR 049 §1g (FR-WT-005): meeting intervals for a person, from the server-recorded IN_MEETING
 * segments. Adjusted (replaced by a correction) and cancelled sessions are left out.
 */
@Injectable()
export class MeetingTimeService {
  constructor(private readonly prisma: PrismaService) {}

  async mine(user: AuthenticatedUser, from: string, to: string): Promise<MeetingIntervalList> {
    return await this.list(user.orgId, user.id, from, to, true);
  }

  /** In scope: HR / org-wide readers; team readers for their direct reports and their own team. */
  async forUser(user: AuthenticatedUser, userId: string, from: string, to: string): Promise<MeetingIntervalList> {
    if (!UUID.test(userId)) throw new NotFoundException('Person not found');
    if (userId === user.id) return await this.mine(user, from, to);
    const target = await this.prisma.runWithTenantContext(user.orgId, (db) => db.query<{ manager_id: string | null; team_id: string | null }>(
      `SELECT manager_id, team_id FROM users WHERE id = $1`, [userId]));
    const t = target.rows[0];
    if (!t) throw new NotFoundException('Person not found');
    const all = userCan(user, Permission.ATTENDANCE_READ_ALL);
    const team = userCan(user, Permission.ATTENDANCE_READ_TEAM) && (t.manager_id === user.id || (!!user.teamId && t.team_id === user.teamId));
    // Invisible and missing look the same.
    if (!all && !team) throw new NotFoundException('Person not found');
    return await this.list(user.orgId, userId, from, to, false);
  }

  private async list(orgId: string, userId: string, from: string, to: string, withTitles: boolean): Promise<MeetingIntervalList> {
    if (to < from) throw new BadRequestException('from must not be after to');
    const res = await this.prisma.runWithTenantContext(orgId, (db) => db.query<{
      id: string; work_date: string; started_at: Date; ended_at: Date | null; duration_seconds: number; elapsed: number;
      call_kind: MeetingInterval['kind']; meeting: string | null; title: string | null;
    }>(
      `SELECT seg.id, s.work_date, seg.started_at, seg.ended_at, seg.duration_seconds,
              GREATEST(0, EXTRACT(EPOCH FROM (now() - seg.started_at)))::int AS elapsed,
              seg.call_kind, COALESCE(seg.call_meeting_id::text, seg.meeting_id) AS meeting, m.title
       FROM attendance_segments seg
       JOIN attendance_sessions s ON s.id = seg.session_id
       LEFT JOIN meetings m ON m.id::text = COALESCE(seg.call_meeting_id::text, seg.meeting_id)
       WHERE s.user_id = $1 AND s.work_date BETWEEN $2 AND $3 AND seg.state = 'IN_MEETING'
         AND s.status NOT IN ('ADJUSTED', 'CANCELLED')
         AND (seg.ended_at IS NOT NULL OR s.status = 'OPEN')
       ORDER BY seg.started_at`,
      [userId, from, to],
    ));
    const intervals: MeetingInterval[] = res.rows.map((r) => ({
      id: r.id,
      workDate: r.work_date,
      startedAt: r.started_at.toISOString(),
      endedAt: r.ended_at ? r.ended_at.toISOString() : null,
      durationSeconds: r.ended_at ? r.duration_seconds : r.elapsed,
      kind: r.call_kind ?? null,
      meetingId: r.meeting && UUID.test(r.meeting) ? r.meeting : null,
      title: withTitles ? r.title ?? null : null,
    }));
    return { from, to, totalSeconds: intervals.reduce((n, i) => n + i.durationSeconds, 0), intervals };
  }
}
