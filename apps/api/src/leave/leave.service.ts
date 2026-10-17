/**
 * Leave requests and the public holiday calendar (FR-ORG-010, FR-ORG-011; FR-ATT-022; ADR 027).
 *
 * Whole days in the organisation's calendar. A request is decided once, by the requester's
 * manager (or the leads and managers of their team when they have no manager) or by HR; never by
 * the requester. Approved leave and holidays reach attendance through PgLeaveProvider and
 * PgHolidayProvider, which read the committed database on every evaluation.
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import { NotificationsService } from '../notifications/notifications.service.ts';
import { approversFor } from '../timesheets/timesheets.service.ts';
import { addDaysIso } from '../planning/planning-rules.ts';
import { defaultHolidaysFor } from './sri-lanka-holidays.ts';
import { LEAVE_MAX_DAYS, LEAVE_MAX_PAST_DAYS, LEAVE_TYPE_LABEL, NotificationType, Permission, userCan } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser, HolidayDto, HolidayList, LeaveDecisionDto, LeaveListQuery, LeaveRequest, LeaveRequestDto, LeaveStatus, LeaveType } from '../../../../packages/shared/src/index.ts';
import { formatInTimeZone } from 'date-fns-tz';

interface Row {
  id: string; user_id: string; type: LeaveType; start_date: string; end_date: string; reason: string; status: LeaveStatus;
  decided_by: string | null; decided_at: Date | null; decision_note: string | null; created_at: Date;
  user_name: string | null; user_email: string; user_manager_id: string | null; user_team_id: string | null;
  decider_name: string | null; decider_email: string | null;
}
const SELECT = `SELECT r.id, r.user_id, r.type, to_char(r.start_date, 'YYYY-MM-DD') AS start_date, to_char(r.end_date, 'YYYY-MM-DD') AS end_date, r.reason, r.status,
    r.decided_by, r.decided_at, r.decision_note, r.created_at,
    u.display_name AS user_name, u.email AS user_email, u.manager_id AS user_manager_id, u.team_id AS user_team_id,
    d.display_name AS decider_name, d.email AS decider_email
  FROM leave_requests r JOIN users u ON u.id = r.user_id LEFT JOIN users d ON d.id = r.decided_by`;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

@Injectable()
export class LeaveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  private async today(db: pg.PoolClient, orgId: string): Promise<string> {
    const tz = (await db.query<{ timezone: string }>(`SELECT timezone FROM organizations WHERE id = $1`, [orgId])).rows[0]?.timezone ?? 'UTC';
    return formatInTimeZone(new Date(), tz, 'yyyy-MM-dd');
  }

  /** Who may decide: HR and admins for everyone; a team approver for their reports (same rule as timesheets). */
  private decides(user: AuthenticatedUser, requester: { id: string; manager_id: string | null; team_id: string | null }): boolean {
    if (requester.id === user.id) return false;
    if (userCan(user, Permission.LEAVE_APPROVE_ALL)) return true;
    if (!userCan(user, Permission.LEAVE_APPROVE_TEAM)) return false;
    if (requester.manager_id) return requester.manager_id === user.id;
    return !!requester.team_id && requester.team_id === (user.teamId ?? null);
  }

  private toDto(user: AuthenticatedUser, r: Row, today: string): LeaveRequest {
    const requester = { id: r.user_id, manager_id: r.user_manager_id, team_id: r.user_team_id };
    return {
      id: r.id, user: { id: r.user_id, displayName: r.user_name, email: r.user_email }, type: r.type, startDate: r.start_date, endDate: r.end_date,
      days: daysBetween(r.start_date, r.end_date), reason: r.reason, status: r.status,
      decidedBy: r.decided_by ? { id: r.decided_by, displayName: r.decider_name, email: r.decider_email ?? '' } : null,
      decidedAt: r.decided_at?.toISOString() ?? null, decisionNote: r.decision_note, createdAt: r.created_at.toISOString(),
      canCancel: r.user_id === user.id && (r.status === 'PENDING' || (r.status === 'APPROVED' && r.end_date >= today)),
      canDecide: r.status === 'PENDING' && this.decides(user, requester),
    };
  }

  private async row(db: pg.PoolClient, id: string, lock = false): Promise<Row> {
    const r = (await db.query<Row>(`${SELECT} WHERE r.id = $1${lock ? ' FOR UPDATE OF r' : ''}`, [id])).rows[0];
    if (!r) throw new NotFoundException('Leave request not found');
    return r;
  }

  async list(user: AuthenticatedUser, q: LeaveListQuery): Promise<{ items: LeaveRequest[] }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const today = await this.today(db, user.orgId);
      const params: unknown[] = [];
      let where: string;
      if (q.scope === 'mine') {
        params.push(user.id);
        where = `r.user_id = $1`;
      } else if (userCan(user, Permission.LEAVE_APPROVE_ALL)) {
        where = `r.user_id <> '${user.id}'::uuid`;
      } else if (userCan(user, Permission.LEAVE_APPROVE_TEAM)) {
        params.push(user.id, user.teamId ?? null);
        // Direct reports; else the team of someone without a manager.
        where = `r.user_id <> $1 AND (u.manager_id = $1 OR (u.manager_id IS NULL AND $2::uuid IS NOT NULL AND u.team_id = $2::uuid))`;
      } else {
        throw new ForbiddenException('You do not decide leave requests');
      }
      if (q.status) {
        params.push(q.status);
        where += ` AND r.status = $${params.length}`;
      }
      const rows = (await db.query<Row>(`${SELECT} WHERE ${where} ORDER BY (r.status = 'PENDING') DESC, r.start_date DESC, r.created_at DESC LIMIT 200`, params)).rows;
      return { items: rows.map((r) => this.toDto(user, r, today)) };
    });
  }

  async create(user: AuthenticatedUser, dto: LeaveRequestDto, ctx: RequestContext): Promise<LeaveRequest> {
    if (daysBetween(dto.startDate, dto.endDate) > LEAVE_MAX_DAYS) throw new BadRequestException(`A request covers at most ${LEAVE_MAX_DAYS} days`);
    const out = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const today = await this.today(db, user.orgId);
      if (dto.startDate < addDaysIso(today, -LEAVE_MAX_PAST_DAYS)) throw new BadRequestException(`Leave can be reported up to ${LEAVE_MAX_PAST_DAYS} days back`);
      // One open or approved request per day and person.
      await db.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [user.id]);
      const overlap = await db.query(`SELECT 1 FROM leave_requests WHERE user_id = $1 AND status IN ('PENDING', 'APPROVED') AND start_date <= $3::date AND end_date >= $2::date`, [user.id, dto.startDate, dto.endDate]);
      if (overlap.rowCount) throw new ConflictException('You already have a request covering some of these days');
      const id = (await db.query<{ id: string }>(
        `INSERT INTO leave_requests (org_id, user_id, type, start_date, end_date, reason) VALUES ($1, $2, $3, $4::date, $5::date, $6) RETURNING id`,
        [user.orgId, user.id, dto.type, dto.startDate, dto.endDate, dto.reason ?? ''])).rows[0]!.id;
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'LEAVE_REQUESTED', entityType: 'LEAVE_REQUEST', entityId: id, after: { type: dto.type, startDate: dto.startDate, endDate: dto.endDate }, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
      return { id, approvers: await approversFor(db, user.id), name: user.displayName ?? user.email };
    });
    await this.notifications.notify(user.orgId, out.approvers.map((a) => ({
      userId: a, type: NotificationType.LEAVE_REQUESTED, title: `${out.name} requests ${LEAVE_TYPE_LABEL[dto.type].toLowerCase()}`,
      body: `${dto.startDate} to ${dto.endDate}${dto.reason ? `: ${dto.reason}` : ''}. Approve or reject it under Leave requests.`,
      link: '/attendance/leave/review', entityType: 'LEAVE_REQUEST', entityId: out.id, dedupeKey: `leave:${out.id}:${a}`,
    })));
    return await this.get(user, out.id);
  }

  async get(user: AuthenticatedUser, id: string): Promise<LeaveRequest> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.row(db, id);
      const today = await this.today(db, user.orgId);
      const dto = this.toDto(user, r, today);
      if (r.user_id !== user.id && !this.decides(user, { id: r.user_id, manager_id: r.user_manager_id, team_id: r.user_team_id }) && !userCan(user, Permission.LEAVE_APPROVE_ALL)) {
        throw new NotFoundException('Leave request not found');
      }
      return dto;
    });
  }

  async decide(user: AuthenticatedUser, id: string, dto: LeaveDecisionDto, ctx: RequestContext): Promise<LeaveRequest> {
    if (!dto.approved && !dto.note) throw new BadRequestException('Say why the request is rejected');
    const out = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.row(db, id, true);
      if (!this.decides(user, { id: r.user_id, manager_id: r.user_manager_id, team_id: r.user_team_id })) throw new ForbiddenException('Only the requester\'s manager or HR decides this request');
      if (r.status !== 'PENDING') throw new ConflictException('This request was already decided');
      const status = dto.approved ? 'APPROVED' : 'REJECTED';
      await db.query(`UPDATE leave_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, updated_at = now() WHERE id = $1`, [id, status, user.id, dto.note || null]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: dto.approved ? 'LEAVE_APPROVED' : 'LEAVE_REJECTED', entityType: 'LEAVE_REQUEST', entityId: id,
        before: { status: r.status }, after: { status, note: dto.note || null, userId: r.user_id, startDate: r.start_date, endDate: r.end_date }, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
      return r;
    });
    await this.notifications.notify(user.orgId, [{
      userId: out.user_id, type: dto.approved ? NotificationType.LEAVE_APPROVED : NotificationType.LEAVE_REJECTED,
      title: dto.approved ? `Your ${LEAVE_TYPE_LABEL[out.type].toLowerCase()} (${out.start_date} to ${out.end_date}) was approved` : `Your ${LEAVE_TYPE_LABEL[out.type].toLowerCase()} (${out.start_date} to ${out.end_date}) was rejected`,
      body: dto.note || (dto.approved ? 'Enjoy your time off.' : ''), link: '/attendance/leave', entityType: 'LEAVE_REQUEST', entityId: id, dedupeKey: `leave-decided:${id}`,
    }]);
    return await this.get(user, id);
  }

  async cancel(user: AuthenticatedUser, id: string, ctx: RequestContext): Promise<LeaveRequest> {
    const out = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.row(db, id, true);
      if (r.user_id !== user.id) throw new ForbiddenException('Only the requester can cancel a request');
      const today = await this.today(db, user.orgId);
      if (!(r.status === 'PENDING' || (r.status === 'APPROVED' && r.end_date >= today))) throw new ConflictException('Only pending requests, or approved leave that has not ended, can be cancelled');
      await db.query(`UPDATE leave_requests SET status = 'CANCELLED', updated_at = now() WHERE id = $1`, [id]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'LEAVE_CANCELLED', entityType: 'LEAVE_REQUEST', entityId: id, before: { status: r.status }, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
      return r;
    });
    if (out.status === 'APPROVED' && out.decided_by) {
      await this.notifications.notify(user.orgId, [{ userId: out.decided_by, type: NotificationType.LEAVE_REQUESTED, title: `${user.displayName ?? user.email} cancelled approved leave (${out.start_date} to ${out.end_date})`, body: 'No action is needed.', link: '/attendance/leave/review', entityType: 'LEAVE_REQUEST', entityId: id, dedupeKey: `leave-cancelled:${id}` }]);
    }
    return await this.get(user, id);
  }

  // ------------------------------------------------------------------ holidays (FR-ORG-011)

  async holidays(user: AuthenticatedUser, year: number): Promise<HolidayList> {
    return await this.prisma.runWithTenantContext(user.orgId, (db) => this.holidayList(db, year));
  }

  private async holidayList(db: pg.PoolClient, year: number): Promise<HolidayList> {
    const rows = (await db.query<{ id: string; date: string; name: string }>(
      `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, name FROM public_holidays WHERE date >= make_date($1, 1, 1) AND date < make_date($1 + 1, 1, 1) ORDER BY date`, [year])).rows;
    return { year, items: rows, defaultsAvailable: defaultHolidaysFor(year) !== null };
  }

  async addHoliday(user: AuthenticatedUser, dto: HolidayDto, ctx: RequestContext): Promise<HolidayList> {
    const year = Number(dto.date.slice(0, 4));
    const out = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`INSERT INTO public_holidays (org_id, date, name, created_by) VALUES ($1, $2::date, $3, $4) ON CONFLICT (org_id, date) DO UPDATE SET name = EXCLUDED.name`, [user.orgId, dto.date, dto.name, user.id]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'HOLIDAY_ADDED', entityType: 'ORGANIZATION', entityId: user.orgId, after: { date: dto.date, name: dto.name }, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
      return await this.holidayList(db, year);
    });
    return out;
  }

  async removeHoliday(user: AuthenticatedUser, id: string, ctx: RequestContext): Promise<HolidayList> {
    const out = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const gone = (await db.query<{ date: string; name: string }>(`DELETE FROM public_holidays WHERE id = $1 RETURNING to_char(date, 'YYYY-MM-DD') AS date, name`, [id])).rows[0];
      if (!gone) throw new NotFoundException('Holiday not found');
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'HOLIDAY_REMOVED', entityType: 'ORGANIZATION', entityId: user.orgId, before: gone, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
      return await this.holidayList(db, Number(gone.date.slice(0, 4)));
    });
    return out;
  }

  /** Loads the built-in national calendar for a year; existing dates are kept as HR left them. */
  async loadDefaults(user: AuthenticatedUser, year: number, ctx: RequestContext): Promise<HolidayList> {
    const defaults = defaultHolidaysFor(year);
    if (!defaults) throw new NotFoundException(`No built-in holiday calendar for ${year}; add the days by hand`);
    const out = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      let added = 0;
      for (const h of defaults) {
        const r = await db.query(`INSERT INTO public_holidays (org_id, date, name, created_by) VALUES ($1, $2::date, $3, $4) ON CONFLICT (org_id, date) DO NOTHING`, [user.orgId, h.date, h.name, user.id]);
        added += r.rowCount ?? 0;
      }
      if (added) await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'HOLIDAYS_DEFAULTS_LOADED', entityType: 'ORGANIZATION', entityId: user.orgId, after: { year, calendar: 'Sri Lanka', added }, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
      return await this.holidayList(db, year);
    });
    return out;
  }
}
