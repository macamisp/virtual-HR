/**
 * ADR 049 §2 overtime requests (FR-WT-007..012) and §7 onsite work requests (FR-WT-023..024).
 *
 * Both follow the leave workflow (ADR 027): the requester submits; the requester's manager, a team
 * approver of a requester without a manager, or HR decides once (row lock, 409 afterwards); never
 * the requester. Decisions are audited in the same transaction and notified after commit.
 * Overtime requests change pay only through the organisation's approval rule (money.ts). Approved
 * onsite work becomes an ONSITE time entry in the timesheet; it never creates attendance.
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { lockUsersForWrite } from '../common/lock-order.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import { NotificationsService } from '../notifications/notifications.service.ts';
import { approversFor } from '../timesheets/timesheets.service.ts';
import { ensureTimesheet, isEditable, orgSettings, refreshDay } from '../timesheets/timesheet-store.ts';
import { TasksService } from '../tasks/tasks.service.ts';
import { addDaysIso } from '../planning/planning-rules.ts';
import {
  NotificationType,
  ONSITE_MAX_MINUTES_PER_DAY,
  ONSITE_PAST_DAYS,
  OVERTIME_FUTURE_DAYS,
  OVERTIME_PAST_DAYS,
  Permission,
  userCan,
} from '../../../../packages/shared/src/index.ts';
import type {
  AuthenticatedUser,
  CancelRequestDto,
  OnsiteDecisionDto,
  OnsiteRequest,
  OnsiteRequestDto,
  OvertimeDecisionDto,
  OvertimeRequest,
  OvertimeRequestDto,
  RequestListQuery,
  RequestStatus,
} from '../../../../packages/shared/src/index.ts';

type Db = pg.PoolClient;
interface Requester { id: string; manager_id: string | null; team_id: string | null }

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

interface OvertimeRow {
  id: string; user_id: string; work_date: string; planned_start: string | null; planned_end: string | null; requested_minutes: number;
  approved_minutes: number | null; project_id: string | null; project_name: string | null; task_id: string | null; task_title: string | null;
  work_description: string; reason: string; notes: string; status: RequestStatus; decided_by: string | null; decided_at: Date | null;
  decision_comment: string | null; cancelled_at: Date | null; created_at: Date; worked: number | null;
  user_name: string | null; user_email: string; user_manager_id: string | null; user_team_id: string | null;
  decider_name: string | null; decider_email: string | null; sheet_status: string | null;
}
const OT_SELECT = `
  SELECT r.id, r.user_id, to_char(r.work_date, 'YYYY-MM-DD') AS work_date, r.planned_start::text, r.planned_end::text, r.requested_minutes,
         r.approved_minutes, r.project_id, p.name AS project_name, r.task_id, t.title AS task_title, r.work_description, r.reason, r.notes,
         r.status, r.decided_by, r.decided_at, r.decision_comment, r.cancelled_at, r.created_at,
         ad.overtime_minutes AS worked,
         u.display_name AS user_name, u.email AS user_email, u.manager_id AS user_manager_id, u.team_id AS user_team_id,
         d.display_name AS decider_name, d.email AS decider_email,
         (SELECT ts.status FROM timesheets ts WHERE ts.user_id = r.user_id AND r.work_date BETWEEN ts.period_start AND ts.period_end LIMIT 1) AS sheet_status
  FROM overtime_requests r
  JOIN users u ON u.id = r.user_id
  LEFT JOIN users d ON d.id = r.decided_by
  LEFT JOIN projects p ON p.id = r.project_id
  LEFT JOIN tasks t ON t.id = r.task_id
  LEFT JOIN attendance_daily ad ON ad.user_id = r.user_id AND ad.work_date = to_char(r.work_date, 'YYYY-MM-DD')`;

interface OnsiteRow {
  id: string; user_id: string; work_date: string; started_at: Date; ended_at: Date; minutes: number; location: string;
  project_id: string | null; project_name: string | null; task_id: string | null; task_title: string | null; description: string; reason: string;
  status: RequestStatus; decided_by: string | null; decided_at: Date | null; decision_comment: string | null; time_entry_id: string | null;
  cancelled_at: Date | null; created_at: Date;
  user_name: string | null; user_email: string; user_manager_id: string | null; user_team_id: string | null;
  decider_name: string | null; decider_email: string | null;
}
const ONSITE_SELECT = `
  SELECT r.id, r.user_id, to_char(r.work_date, 'YYYY-MM-DD') AS work_date, r.started_at, r.ended_at, r.minutes, r.location,
         r.project_id, p.name AS project_name, r.task_id, t.title AS task_title, r.description, r.reason,
         r.status, r.decided_by, r.decided_at, r.decision_comment, r.time_entry_id, r.cancelled_at, r.created_at,
         u.display_name AS user_name, u.email AS user_email, u.manager_id AS user_manager_id, u.team_id AS user_team_id,
         d.display_name AS decider_name, d.email AS decider_email
  FROM onsite_work_requests r
  JOIN users u ON u.id = r.user_id
  LEFT JOIN users d ON d.id = r.decided_by
  LEFT JOIN projects p ON p.id = r.project_id
  LEFT JOIN tasks t ON t.id = r.task_id`;

@Injectable()
export class WorkRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly tasks: TasksService,
  ) {}

  /** Server clock; a seam for tests. */
  protected now(): Date {
    return new Date();
  }

  // ------------------------------------------------------------------ shared rules

  /** HR (approve.all) for everyone; a team approver for direct reports, or their team's members without a manager. */
  private decides(user: AuthenticatedUser, r: Requester): boolean {
    if (r.id === user.id) return false;
    if (userCan(user, Permission.TIMESHEETS_APPROVE_ALL)) return true;
    if (!userCan(user, Permission.TIMESHEETS_APPROVE_TEAM)) return false;
    if (r.manager_id) return r.manager_id === user.id;
    return !!r.team_id && r.team_id === (user.teamId ?? null);
  }

  private scopeSql(user: AuthenticatedUser, q: RequestListQuery, params: unknown[]): string {
    if (q.scope === 'mine') {
      params.push(user.id);
      return `r.user_id = $${params.length}`;
    }
    if (userCan(user, Permission.TIMESHEETS_APPROVE_ALL)) {
      params.push(user.id);
      return `r.user_id <> $${params.length}`;
    }
    if (!userCan(user, Permission.TIMESHEETS_APPROVE_TEAM)) throw new ForbiddenException('You do not review these requests');
    params.push(user.id, user.teamId ?? null);
    const me = `$${params.length - 1}`;
    const team = `$${params.length}::uuid`;
    return `r.user_id <> ${me} AND (u.manager_id = ${me} OR (u.manager_id IS NULL AND ${team} IS NOT NULL AND u.team_id = ${team}))`;
  }

  private filters(q: RequestListQuery, params: unknown[]): string {
    let where = '';
    if (q.status) { params.push(q.status); where += ` AND r.status = $${params.length}`; }
    if (q.from) { params.push(q.from); where += ` AND r.work_date >= $${params.length}::date`; }
    if (q.to) { params.push(q.to); where += ` AND r.work_date <= $${params.length}::date`; }
    return where;
  }

  private async today(db: Db, orgId: string): Promise<{ today: string; tz: string }> {
    const tz = (await orgSettings(db, orgId)).timezone;
    return { today: formatInTimeZone(this.now(), tz, 'yyyy-MM-dd'), tz };
  }

  /** The project must be one the person may log time to; the task visible and theirs to log on. */
  private async resolveWork(user: AuthenticatedUser, dto: { projectId?: string | undefined; taskId?: string | undefined }): Promise<{ projectId: string | null; taskId: string | null }> {
    let projectId = dto.projectId ?? null;
    if (dto.taskId) {
      const task = await this.tasks.get(user, dto.taskId);
      if (task.assignee && task.assignee.id !== user.id && !task.permissions.canEdit) throw new ForbiddenException('This task is assigned to someone else');
      if (projectId && task.projectId !== projectId) throw new BadRequestException('The task belongs to another project');
      projectId = task.projectId;
    }
    if (projectId && !dto.taskId) {
      const ok = await this.prisma.runWithTenantContext(user.orgId, (db) => db.query(
        `SELECT 1 FROM projects p WHERE p.id = $1 AND ($3 OR p.manager_id = $2 OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = $2))`,
        [projectId, user.id, userCan(user, Permission.TASKS_READ_ALL)]));
      if (!ok.rowCount) throw new NotFoundException('Project not found');
    }
    return { projectId, taskId: dto.taskId ?? null };
  }

  private audit(db: Db, user: AuthenticatedUser, ctx: RequestContext, action: string, entityType: string, entityId: string, before: Record<string, unknown> | undefined, after: Record<string, unknown>) {
    return appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action, entityType, entityId, ...(before ? { before } : {}), after, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
  }

  // ------------------------------------------------------------------ overtime

  private otDto(user: AuthenticatedUser, r: OvertimeRow): OvertimeRequest {
    const requester = { id: r.user_id, manager_id: r.user_manager_id, team_id: r.user_team_id };
    const sheetOpen = r.sheet_status === null || r.sheet_status === 'DRAFT' || r.sheet_status === 'REJECTED';
    return {
      id: r.id, user: { id: r.user_id, displayName: r.user_name, email: r.user_email }, workDate: r.work_date,
      plannedStart: hhmm(r.planned_start), plannedEnd: hhmm(r.planned_end), requestedMinutes: r.requested_minutes, approvedMinutes: r.approved_minutes,
      workedOvertimeMinutes: r.worked ?? null,
      project: r.project_id && r.project_name ? { id: r.project_id, name: r.project_name } : null,
      task: r.task_id && r.task_title ? { id: r.task_id, title: r.task_title } : null,
      workDescription: r.work_description, reason: r.reason, notes: r.notes, status: r.status,
      decidedBy: r.decided_by ? { id: r.decided_by, displayName: r.decider_name, email: r.decider_email ?? '' } : null,
      decidedAt: iso(r.decided_at), decisionComment: r.decision_comment, cancelledAt: iso(r.cancelled_at), createdAt: r.created_at.toISOString(),
      // The owner withdraws a pending request; HR withdraws an approved one while the timesheet is open.
      canCancel: (r.user_id === user.id && r.status === 'PENDING') ||
        (r.status === 'APPROVED' && sheetOpen && r.user_id !== user.id && userCan(user, Permission.TIMESHEETS_APPROVE_ALL)),
      canDecide: r.status === 'PENDING' && this.decides(user, requester),
    };
  }

  private async otRow(db: Db, id: string, lock = false): Promise<OvertimeRow> {
    const r = (await db.query<OvertimeRow>(`${OT_SELECT} WHERE r.id = $1${lock ? ' FOR UPDATE OF r' : ''}`, [id])).rows[0];
    if (!r) throw new NotFoundException('Overtime request not found');
    return r;
  }

  private visibleOt(user: AuthenticatedUser, r: OvertimeRow): boolean {
    return r.user_id === user.id || this.decides(user, { id: r.user_id, manager_id: r.user_manager_id, team_id: r.user_team_id });
  }

  async listOvertime(user: AuthenticatedUser, q: RequestListQuery): Promise<{ items: OvertimeRequest[] }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const params: unknown[] = [];
      const where = this.scopeSql(user, q, params) + this.filters(q, params);
      const rows = (await db.query<OvertimeRow>(`${OT_SELECT} WHERE ${where} ORDER BY (r.status = 'PENDING') DESC, r.work_date DESC, r.created_at DESC LIMIT 200`, params)).rows;
      return { items: rows.map((r) => this.otDto(user, r)) };
    });
  }

  async getOvertime(user: AuthenticatedUser, id: string): Promise<OvertimeRequest> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.otRow(db, id);
      if (!this.visibleOt(user, r)) throw new NotFoundException('Overtime request not found');
      return this.otDto(user, r);
    });
  }

  async requestOvertime(user: AuthenticatedUser, dto: OvertimeRequestDto, ctx: RequestContext): Promise<OvertimeRequest> {
    const minutes = dto.plannedStart && dto.plannedEnd ? minutesOf(dto.plannedEnd) - minutesOf(dto.plannedStart) : dto.minutes!;
    if (minutes < 15 || minutes > 720) throw new BadRequestException('Overtime requests are between 15 minutes and 12 hours');
    const work = await this.resolveWork(user, dto);
    const out = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const { today } = await this.today(db, user.orgId);
      if (dto.workDate < addDaysIso(today, -OVERTIME_PAST_DAYS)) throw new BadRequestException(`Overtime can be requested up to ${OVERTIME_PAST_DAYS} days back`);
      if (dto.workDate > addDaysIso(today, OVERTIME_FUTURE_DAYS)) throw new BadRequestException(`Overtime can be requested up to ${OVERTIME_FUTURE_DAYS} days ahead`);
      await lockUsersForWrite(db, [user.id]);
      // FR-WT-010: one pending or approved claim per day (the partial unique index enforces it too).
      const dup = await db.query(`SELECT 1 FROM overtime_requests WHERE user_id = $1 AND work_date = $2::date AND status IN ('PENDING', 'APPROVED')`, [user.id, dto.workDate]);
      if (dup.rowCount) throw new ConflictException('You already have an overtime request for this day: cancel it to change it');
      const id = (await db.query<{ id: string }>(
        `INSERT INTO overtime_requests (org_id, user_id, work_date, planned_start, planned_end, requested_minutes, project_id, task_id, work_description, reason, notes)
         VALUES ($1, $2, $3::date, $4::time, $5::time, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [user.orgId, user.id, dto.workDate, dto.plannedStart ?? null, dto.plannedEnd ?? null, minutes, work.projectId, work.taskId, dto.workDescription, dto.reason, dto.notes],
      ).catch((err: { code?: string }) => { if (err.code === '23505') throw new ConflictException('You already have an overtime request for this day'); throw err; })).rows[0]!.id;
      await this.audit(db, user, ctx, 'OVERTIME_REQUESTED', 'OVERTIME_REQUEST', id, undefined, { workDate: dto.workDate, minutes, projectId: work.projectId, taskId: work.taskId });
      return { id, approvers: await approversFor(db, user.id) };
    });
    const name = user.displayName ?? user.email;
    await this.notifications.notify(user.orgId, out.approvers.map((a) => ({
      userId: a, type: NotificationType.OVERTIME_REQUESTED, title: `${name} requests ${Math.round((minutes / 60) * 100) / 100} h of overtime on ${dto.workDate}`,
      body: 'Approve or reject it under Work time > Review requests.', link: '/work-time/review', entityType: 'OVERTIME_REQUEST', entityId: out.id, dedupeKey: `ot:${out.id}:${a}`,
    })));
    return await this.getOvertime(user, out.id);
  }

  async decideOvertime(user: AuthenticatedUser, id: string, dto: OvertimeDecisionDto, ctx: RequestContext): Promise<OvertimeRequest> {
    if (!dto.approved && !dto.comment) throw new BadRequestException('Say why the request is rejected');
    const out = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.otRow(db, id, true);
      if (!this.decides(user, { id: r.user_id, manager_id: r.user_manager_id, team_id: r.user_team_id })) {
        if (r.user_id === user.id) throw new ForbiddenException('You cannot decide your own overtime request');
        throw new ForbiddenException('Only the requester\'s manager or HR decides this request');
      }
      if (r.status !== 'PENDING') throw new ConflictException('This request was already decided');
      const approvedMinutes = dto.approved ? (dto.approvedMinutes ?? r.requested_minutes) : null;
      if (approvedMinutes !== null && approvedMinutes > r.requested_minutes) throw new BadRequestException('Approve at most the requested minutes');
      const status = dto.approved ? 'APPROVED' : 'REJECTED';
      await db.query(
        `UPDATE overtime_requests SET status = $2, approved_minutes = $3, decided_by = $4, decided_at = now(), decision_comment = $5, updated_at = now() WHERE id = $1`,
        [id, status, approvedMinutes, user.id, dto.comment || null]);
      await this.audit(db, user, ctx, dto.approved ? 'OVERTIME_APPROVED' : 'OVERTIME_REJECTED', 'OVERTIME_REQUEST', id, { status: r.status },
        { status, approvedMinutes, requestedMinutes: r.requested_minutes, userId: r.user_id, workDate: r.work_date, comment: dto.comment || null });
      return { r, approvedMinutes };
    });
    await this.notifications.notify(user.orgId, [{
      userId: out.r.user_id, type: NotificationType.OVERTIME_DECIDED,
      title: dto.approved
        ? `Your overtime on ${out.r.work_date} was approved${out.approvedMinutes !== out.r.requested_minutes ? ` (${Math.round(((out.approvedMinutes ?? 0) / 60) * 100) / 100} h)` : ''}`
        : `Your overtime on ${out.r.work_date} was not approved`,
      body: dto.comment || '', link: '/work-time/overtime', entityType: 'OVERTIME_REQUEST', entityId: id, dedupeKey: `ot-decided:${id}`,
    }]);
    return await this.getOvertime(user, id);
  }

  async cancelOvertime(user: AuthenticatedUser, id: string, dto: CancelRequestDto, ctx: RequestContext): Promise<OvertimeRequest> {
    const out = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.otRow(db, id, true);
      if (!this.visibleOt(user, r) && !userCan(user, Permission.TIMESHEETS_APPROVE_ALL)) throw new NotFoundException('Overtime request not found');
      if (!this.otDto(user, r).canCancel) {
        if (r.status === 'APPROVED') throw new ConflictException('Approved overtime is withdrawn by HR, and only while the timesheet is open');
        throw new ConflictException('Only pending requests can be cancelled');
      }
      if (r.status === 'APPROVED' && !dto.comment) throw new BadRequestException('Say why approved overtime is withdrawn');
      await db.query(`UPDATE overtime_requests SET status = 'CANCELLED', cancelled_by = $2, cancelled_at = now(), decision_comment = COALESCE($3, decision_comment), updated_at = now() WHERE id = $1`, [id, user.id, dto.comment || null]);
      await this.audit(db, user, ctx, 'OVERTIME_CANCELLED', 'OVERTIME_REQUEST', id, { status: r.status }, { status: 'CANCELLED', userId: r.user_id, workDate: r.work_date, comment: dto.comment || null });
      return r;
    });
    if (out.user_id !== user.id) {
      await this.notifications.notify(user.orgId, [{ userId: out.user_id, type: NotificationType.OVERTIME_DECIDED, title: `Your approved overtime on ${out.work_date} was withdrawn`, body: dto.comment || '', link: '/work-time/overtime', entityType: 'OVERTIME_REQUEST', entityId: id, dedupeKey: `ot-cancelled:${id}` }]);
    }
    return await this.getOvertime(user, id);
  }

  // ------------------------------------------------------------------ onsite work

  private onsiteDto(user: AuthenticatedUser, r: OnsiteRow): OnsiteRequest {
    return {
      id: r.id, user: { id: r.user_id, displayName: r.user_name, email: r.user_email }, workDate: r.work_date,
      startedAt: r.started_at.toISOString(), endedAt: r.ended_at.toISOString(), minutes: r.minutes, location: r.location,
      project: r.project_id && r.project_name ? { id: r.project_id, name: r.project_name } : null,
      task: r.task_id && r.task_title ? { id: r.task_id, title: r.task_title } : null,
      description: r.description, reason: r.reason, status: r.status,
      decidedBy: r.decided_by ? { id: r.decided_by, displayName: r.decider_name, email: r.decider_email ?? '' } : null,
      decidedAt: iso(r.decided_at), decisionComment: r.decision_comment, timeEntryId: r.time_entry_id, cancelledAt: iso(r.cancelled_at), createdAt: r.created_at.toISOString(),
      canCancel: r.user_id === user.id && r.status === 'PENDING',
      canDecide: r.status === 'PENDING' && this.decides(user, { id: r.user_id, manager_id: r.user_manager_id, team_id: r.user_team_id }),
    };
  }

  private async onsiteRow(db: Db, id: string, lock = false): Promise<OnsiteRow> {
    const r = (await db.query<OnsiteRow>(`${ONSITE_SELECT} WHERE r.id = $1${lock ? ' FOR UPDATE OF r' : ''}`, [id])).rows[0];
    if (!r) throw new NotFoundException('Onsite request not found');
    return r;
  }

  async listOnsite(user: AuthenticatedUser, q: RequestListQuery): Promise<{ items: OnsiteRequest[] }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const params: unknown[] = [];
      const where = this.scopeSql(user, q, params) + this.filters(q, params);
      const rows = (await db.query<OnsiteRow>(`${ONSITE_SELECT} WHERE ${where} ORDER BY (r.status = 'PENDING') DESC, r.work_date DESC, r.started_at DESC LIMIT 200`, params)).rows;
      return { items: rows.map((r) => this.onsiteDto(user, r)) };
    });
  }

  async getOnsite(user: AuthenticatedUser, id: string): Promise<OnsiteRequest> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.onsiteRow(db, id);
      if (r.user_id !== user.id && !this.decides(user, { id: r.user_id, manager_id: r.user_manager_id, team_id: r.user_team_id })) throw new NotFoundException('Onsite request not found');
      return this.onsiteDto(user, r);
    });
  }

  /** FR-WT-024: no overlap with other onsite claims, timed entries or attendance; at most 16 h a day. */
  private async assertOnsiteFits(db: Db, userId: string, workDate: string, start: Date, end: Date, minutes: number, excludeId: string | null): Promise<void> {
    const same = await db.query<{ overlap: boolean; total: number }>(
      `SELECT COALESCE(bool_or(tstzrange(started_at, ended_at) && tstzrange($3, $4)), false) AS overlap, COALESCE(SUM(minutes), 0)::int AS total
       FROM onsite_work_requests WHERE user_id = $1 AND work_date = $2::date AND status IN ('PENDING', 'APPROVED') AND ($5::uuid IS NULL OR id <> $5)`,
      [userId, workDate, start, end, excludeId]);
    if (same.rows[0]?.overlap) throw new ConflictException('This overlaps onsite work you have already submitted');
    if ((same.rows[0]?.total ?? 0) + minutes > ONSITE_MAX_MINUTES_PER_DAY) throw new BadRequestException(`At most ${ONSITE_MAX_MINUTES_PER_DAY / 60} hours of onsite work a day`);
    const entries = await db.query(
      `SELECT 1 FROM time_entries WHERE user_id = $1 AND started_at IS NOT NULL AND tstzrange(started_at, COALESCE(ended_at, now())) && tstzrange($2, $3) LIMIT 1`,
      [userId, start, end]);
    if (entries.rowCount) throw new ConflictException('This overlaps time you have already recorded');
    const att = await db.query(
      `SELECT 1 FROM attendance_sessions WHERE user_id = $1 AND status NOT IN ('CANCELLED', 'ADJUSTED')
         AND tstzrange(clock_in_at, COALESCE(clock_out_at, last_heartbeat_at)) && tstzrange($2, $3) LIMIT 1`,
      [userId, start, end]);
    if (att.rowCount) throw new ConflictException('You were clocked in to Virtual-HR during this time: log the work as a task entry, or ask for an attendance correction');
  }

  async requestOnsite(user: AuthenticatedUser, dto: OnsiteRequestDto, ctx: RequestContext): Promise<OnsiteRequest> {
    const work = await this.resolveWork(user, dto);
    const out = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const { today, tz } = await this.today(db, user.orgId);
      if (dto.workDate > today) throw new BadRequestException('Report onsite work after it happened');
      if (dto.workDate < addDaysIso(today, -ONSITE_PAST_DAYS)) throw new BadRequestException(`Onsite work can be reported up to ${ONSITE_PAST_DAYS} days back`);
      const start = fromZonedTime(`${dto.workDate}T${dto.startTime}:00`, tz);
      const end = fromZonedTime(`${dto.workDate}T${dto.endTime}:00`, tz);
      if (end.getTime() > this.now().getTime()) throw new BadRequestException('The work must have ended: the end time is in the future');
      const minutes = Math.floor((end.getTime() - start.getTime()) / 60_000);
      if (minutes < 1 || minutes > ONSITE_MAX_MINUTES_PER_DAY) throw new BadRequestException(`One request covers at most ${ONSITE_MAX_MINUTES_PER_DAY / 60} hours`);
      await lockUsersForWrite(db, [user.id]);
      await this.assertOnsiteFits(db, user.id, dto.workDate, start, end, minutes, null);
      const id = (await db.query<{ id: string }>(
        `INSERT INTO onsite_work_requests (org_id, user_id, work_date, started_at, ended_at, minutes, location, project_id, task_id, description, reason)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [user.orgId, user.id, dto.workDate, start, end, minutes, dto.location, work.projectId, work.taskId, dto.description, dto.reason])).rows[0]!.id;
      await this.audit(db, user, ctx, 'ONSITE_WORK_REQUESTED', 'ONSITE_WORK_REQUEST', id, undefined, { workDate: dto.workDate, minutes, projectId: work.projectId, taskId: work.taskId });
      return { id, minutes, approvers: await approversFor(db, user.id) };
    });
    const name = user.displayName ?? user.email;
    await this.notifications.notify(user.orgId, out.approvers.map((a) => ({
      userId: a, type: NotificationType.ONSITE_REQUESTED, title: `${name} reports ${Math.round((out.minutes / 60) * 100) / 100} h of onsite work on ${dto.workDate}`,
      body: 'Review it under Work time > Review requests.', link: '/work-time/review', entityType: 'ONSITE_WORK_REQUEST', entityId: out.id, dedupeKey: `onsite:${out.id}:${a}`,
    })));
    return await this.getOnsite(user, out.id);
  }

  async decideOnsite(user: AuthenticatedUser, id: string, dto: OnsiteDecisionDto, ctx: RequestContext): Promise<OnsiteRequest> {
    if (!dto.approved && !dto.comment) throw new BadRequestException('Say why the work is not accepted');
    const out = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.onsiteRow(db, id, true);
      if (!this.decides(user, { id: r.user_id, manager_id: r.user_manager_id, team_id: r.user_team_id })) {
        if (r.user_id === user.id) throw new ForbiddenException('You cannot review your own onsite work');
        throw new ForbiddenException('Only the requester\'s manager or HR reviews this request');
      }
      if (r.status !== 'PENDING') throw new ConflictException('This request was already decided');
      let entryId: string | null = null;
      if (dto.approved) {
        await lockUsersForWrite(db, [r.user_id]);
        await db.query(`SELECT pg_advisory_xact_lock(hashtext('timer:' || $1::text))`, [r.user_id]);
        // Time recorded since the request must not overlap it (attendance cannot change in the past).
        const clash = await db.query(`SELECT 1 FROM time_entries WHERE user_id = $1 AND started_at IS NOT NULL AND tstzrange(started_at, COALESCE(ended_at, now())) && tstzrange($2, $3) LIMIT 1`, [r.user_id, r.started_at, r.ended_at]);
        if (clash.rowCount) throw new ConflictException('The person has since recorded time that overlaps this work');
        const settings = await orgSettings(db, user.orgId);
        const sheet = await ensureTimesheet(db, user.orgId, r.user_id, r.work_date, settings);
        if (!isEditable(sheet.status)) throw new ConflictException('The timesheet for this day is submitted or approved: return or reopen it first');
        entryId = (await db.query<{ id: string }>(
          `INSERT INTO time_entries (org_id, user_id, timesheet_id, project_id, task_id, work_date, started_at, ended_at, minutes, source, billable, note,
             title, work_type, task_title, project_name)
           VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, 'ONSITE', true, $10, $11, 'ONSITE', $12, $13) RETURNING id`,
          [user.orgId, r.user_id, sheet.id, r.project_id, r.task_id, r.work_date, r.started_at, r.ended_at, r.minutes, r.description,
            `Onsite: ${r.location}`.slice(0, 200), r.task_title, r.project_name])).rows[0]!.id;
        await refreshDay(db, user.orgId, r.user_id, r.work_date, settings);
      }
      const status = dto.approved ? 'APPROVED' : 'REJECTED';
      await db.query(`UPDATE onsite_work_requests SET status = $2, decided_by = $3, decided_at = now(), decision_comment = $4, time_entry_id = $5, updated_at = now() WHERE id = $1`,
        [id, status, user.id, dto.comment || null, entryId]);
      await this.audit(db, user, ctx, dto.approved ? 'ONSITE_WORK_APPROVED' : 'ONSITE_WORK_REJECTED', 'ONSITE_WORK_REQUEST', id, { status: r.status },
        { status, userId: r.user_id, workDate: r.work_date, minutes: r.minutes, timeEntryId: entryId, comment: dto.comment || null });
      return r;
    });
    await this.notifications.notify(user.orgId, [{
      userId: out.user_id, type: NotificationType.ONSITE_DECIDED,
      title: dto.approved ? `Your onsite work on ${out.work_date} was approved and added to your timesheet` : `Your onsite work on ${out.work_date} was not accepted`,
      body: dto.comment || '', link: '/work-time/onsite', entityType: 'ONSITE_WORK_REQUEST', entityId: id, dedupeKey: `onsite-decided:${id}`,
    }]);
    return await this.getOnsite(user, id);
  }

  async cancelOnsite(user: AuthenticatedUser, id: string, ctx: RequestContext): Promise<OnsiteRequest> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.onsiteRow(db, id, true);
      if (r.user_id !== user.id) throw new NotFoundException('Onsite request not found');
      if (r.status !== 'PENDING') throw new ConflictException('Only pending requests can be cancelled');
      await db.query(`UPDATE onsite_work_requests SET status = 'CANCELLED', cancelled_at = now(), updated_at = now() WHERE id = $1`, [id]);
      await this.audit(db, user, ctx, 'ONSITE_WORK_CANCELLED', 'ONSITE_WORK_REQUEST', id, { status: r.status }, { status: 'CANCELLED', workDate: r.work_date });
    });
    return await this.getOnsite(user, id);
  }
}
