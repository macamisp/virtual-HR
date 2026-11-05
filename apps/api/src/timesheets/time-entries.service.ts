import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import type pg from 'pg';
import { fromZonedTime } from 'date-fns-tz';
import { PrismaService } from '../common/prisma.service.ts';
import { PostgresAttendanceRepository } from '../attendance/attendance-repository.ts';
import { TasksService } from '../tasks/tasks.service.ts';
import { Permission, userCan } from '../../../../packages/shared/src/auth/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import type { AttendanceSession } from '../../../../packages/shared/src/attendance/types.ts';
import type {
  ManualEntryDto,
  StartTimerDto,
  TimeEntry,
  TimeEntryListQuery,
  TimerState,
  UpdateEntryDto,
} from '../../../../packages/shared/src/timesheets/types.ts';
import type { TaskDetail } from '../../../../packages/shared/src/tasks/types.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { addDaysIso } from '../planning/planning-rules.ts';
import { localDate } from '../notifications/reminder-rules.ts';
import { ensureTimesheet, isEditable, orgSettings, refreshDay, TimesheetLockedError } from './timesheet-store.ts';
import type { OrgTimesheetSettings } from './timesheet-store.ts';
import { inApprovalScope } from './timesheet-policy.ts';
import { ENTRY_SELECT, actorOf, mapEntry, mapTimeDbError } from './timesheets.sql.ts';
import { TimesheetEvents } from './timesheet-events.ts';
import { weeklyCapStatus } from './weekly-cap.ts';
import type { WeeklyCap } from '../../../../packages/shared/src/index.ts';
import type { EntryRow } from './timesheets.sql.ts';

type Db = pg.PoolClient;

const MAX_LIST_DAYS = 62;

/**
 * FR-TS-003 task timers and FR-TS-004 manual entries. All times come from the server clock;
 * the client never sends a timestamp (AGENTS.md).
 */
@Injectable()
export class TimeEntriesService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly attendance: PostgresAttendanceRepository,
    private readonly events: TimesheetEvents,
  ) {}

  /** FR-ORG-004 (ADR 034): after commit, so the weekly cap check sees the new time. */
  private logged(orgId: string, userId: string, workDate: string | null): void {
    this.events.emit('time.logged', { orgId, userId, workDate });
  }

  /** FR-ORG-004: this week's logged hours against the caller's weekly cap. */
  async weeklyCap(user: AuthenticatedUser): Promise<WeeklyCap> {
    return this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const { name: _name, ...status } = await weeklyCapStatus(db, user.orgId, user.id, null, this.now());
      return status;
    });
  }

  onModuleInit(): void {
    // FR-TS-003: the running timer stops automatically at clock-out.
    this.attendance.onSessionClosed((session) => this.autoStop(session));
  }

  /** Server clock; a seam for tests. */
  protected now(): Date {
    return new Date();
  }

  // ---------------------------------------------------------------- timers

  async timerState(user: AuthenticatedUser): Promise<TimerState> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => ({
      running: await this.runningEntry(db, user.id, user.id),
      serverNow: this.now().toISOString(),
    }));
  }

  /**
   * FR-TS-003, ADR 049 §3 (FR-WT-013): a timer on a task, or on a project and/or the person's own
   * title without a task. Starting one stops the running one (one timer at a time).
   */
  async startTimer(user: AuthenticatedUser, dto: StartTimerDto): Promise<TimerState> {
    let task: TaskDetail | null = null;
    let projectId = dto.projectId ?? null;
    if (dto.taskId) {
      task = await this.tasks.get(user, dto.taskId);
      this.assertMayLogOn(user, task);
      if (projectId && task.projectId !== projectId) throw new BadRequestException('The task belongs to another project');
      projectId = task.projectId;
    }
    const taskId = dto.taskId ?? null;
    const title = dto.title ?? null;
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext('timer:' || $1::text))`, [user.id]);
      const open = await db.query(
        `SELECT 1 FROM attendance_sessions WHERE org_id = $1 AND user_id = $2 AND status = 'OPEN' AND clock_out_at IS NULL LIMIT 1`,
        [user.orgId, user.id],
      );
      if (open.rowCount === 0) throw new ConflictException('Clock in before starting a timer: you are not tracked as online');
      if (projectId && !task) await this.assertProjectAccess(db, user, projectId);
      const current = await this.runningEntry(db, user.id, user.id);
      if (current && current.taskId === taskId && current.title === title && current.projectId === projectId) {
        return { running: current, serverNow: this.now().toISOString(), stopped: null };
      }

      const now = this.now();
      // FR-TS-003: only one timer at a time; starting another stops the current one.
      const stoppedId = current ? await this.stopRunning(db, user.orgId, user.id, now, false) : null;
      const settings = await orgSettings(db, user.orgId);
      const date = localDate(now, settings.timezone);
      const sheet = await ensureTimesheet(db, user.orgId, user.id, date, settings);
      if (!isEditable(sheet.status)) throw new TimesheetLockedError(sheet.status);
      try {
        await db.query(
          `INSERT INTO time_entries (org_id, user_id, timesheet_id, project_id, task_id, work_date, started_at, source,
             title, work_type, category, task_title, project_name)
           VALUES ($1, $2, $3, $4, $5, $6::date, $7, 'TIMER', $8, $9, $10, $11, $12)`,
          [user.orgId, user.id, sheet.id, projectId, taskId, date, now, title, dto.workType ?? null, dto.category ?? null,
            task?.title ?? null, await this.projectName(db, projectId)],
        );
      } catch (err) {
        throw mapTimeDbError(err);
      }
      return {
        running: await this.runningEntry(db, user.id, user.id),
        serverNow: now.toISOString(),
        stopped: stoppedId ? await this.entryById(db, stoppedId, user.id) : null,
      };
    }).catch((err: unknown) => {
      throw mapTimeDbError(err);
    });
  }

  /**
   * ADR 049 §3: "Resume" continues the person's last timer of today (same task, project, title,
   * work type and category) as a new entry; the paused gap is not counted.
   */
  async resumeTimer(user: AuthenticatedUser): Promise<TimerState> {
    const last = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const settings = await orgSettings(db, user.orgId);
      const res = await db.query<{ task_id: string | null; project_id: string | null; title: string | null; work_type: StartTimerDto['workType'] | null; category: StartTimerDto['category'] | null }>(
        `SELECT task_id, project_id, title, work_type, category FROM time_entries
         WHERE org_id = $1 AND user_id = $2 AND source = 'TIMER' AND ended_at IS NOT NULL AND work_date = $3::date
         ORDER BY ended_at DESC LIMIT 1`,
        [user.orgId, user.id, localDate(this.now(), settings.timezone)],
      );
      return res.rows[0] ?? null;
    });
    if (!last) throw new NotFoundException('Nothing to resume today: start a timer');
    return await this.startTimer(user, {
      ...(last.task_id ? { taskId: last.task_id } : {}),
      ...(last.project_id && !last.task_id ? { projectId: last.project_id } : {}),
      ...(last.title ? { title: last.title } : {}),
      ...(last.work_type ? { workType: last.work_type } : {}),
      ...(last.category ? { category: last.category } : {}),
    });
  }

  /** Stops the running timer; with `taskId`, only if it runs on that task. */
  async stopTimer(user: AuthenticatedUser, taskId?: string): Promise<TimerState> {
    const state = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext('timer:' || $1::text))`, [user.id]);
      const current = await this.runningEntry(db, user.id, user.id);
      if (!current || (taskId && current.taskId !== taskId)) throw new NotFoundException('No timer is running on this task');
      const now = this.now();
      const id = await this.stopRunning(db, user.orgId, user.id, now, false);
      return { running: null, serverNow: now.toISOString(), stopped: id ? await this.entryById(db, id, user.id) : null };
    }).catch((err: unknown) => {
      throw mapTimeDbError(err);
    });
    this.logged(user.orgId, user.id, null);
    return state;
  }

  /**
   * Closes the user's running timer at `at`. A timer that crossed local midnight is split
   * into one entry per day, so every day's reconciliation sees its own minutes.
   * Returns the id of the first (original) entry, or null when nothing was running.
   */
  private async stopRunning(db: Db, orgId: string, userId: string, at: Date, auto: boolean): Promise<string | null> {
    const res = await db.query<{ id: string; started_at: Date; project_id: string | null; task_id: string | null; billable: boolean; note: string;
      title: string | null; work_type: string | null; category: string | null; task_title: string | null; project_name: string | null }>(
      `SELECT id, started_at, project_id, task_id, billable, note, title, work_type, category, task_title, project_name FROM time_entries
       WHERE org_id = $1 AND user_id = $2 AND ended_at IS NULL FOR UPDATE`,
      [orgId, userId],
    );
    const run = res.rows[0];
    if (!run) return null;
    const settings = await orgSettings(db, orgId);
    const end = at.getTime() < run.started_at.getTime() ? run.started_at : at;
    const pieces = splitAtMidnight(run.started_at, end, settings.timezone);
    const first = pieces[0]!;
    await db.query(
      `UPDATE time_entries SET ended_at = $2, minutes = $3, auto_stopped = $4, updated_at = now() WHERE id = $1`,
      [run.id, first.end, minutesBetween(first.start, first.end), auto],
    );
    for (const p of pieces.slice(1)) {
      const sheet = await ensureTimesheet(db, orgId, userId, p.date, settings);
      if (!isEditable(sheet.status)) continue; // never write into a submitted period
      await db.query(
        `INSERT INTO time_entries (org_id, user_id, timesheet_id, project_id, task_id, work_date, started_at, ended_at, minutes, source, billable, note, auto_stopped,
           title, work_type, category, task_title, project_name)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, 'TIMER', $10, $11, $12, $13, $14, $15, $16, $17)`,
        [orgId, userId, sheet.id, run.project_id, run.task_id, p.date, p.start, p.end, minutesBetween(p.start, p.end), run.billable, run.note, auto,
          run.title, run.work_type, run.category, run.task_title, run.project_name],
      );
    }
    for (const p of pieces) await refreshDay(db, orgId, userId, p.date, settings);
    return run.id;
  }

  /** FR-TS-003: invoked by the attendance repository after a real clock-out. */
  async autoStop(session: AttendanceSession): Promise<void> {
    if (!session.clockOutAt) return;
    const clockOut = session.clockOutAt;
    await this.prisma.runWithTenantContext(session.orgId, async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext('timer:' || $1::text))`, [session.userId]);
      const otherOpen = await db.query(
        `SELECT 1 FROM attendance_sessions WHERE org_id = $1 AND user_id = $2 AND id <> $3 AND status = 'OPEN' AND clock_out_at IS NULL LIMIT 1`,
        [session.orgId, session.userId, session.id],
      );
      if ((otherOpen.rowCount ?? 0) > 0) return; // still online on another device
      // Ends at the clock-out time (last valid heartbeat); a timer started after it gets 0 minutes.
      await this.stopRunning(db, session.orgId, session.userId, clockOut, true);
    });
    this.logged(session.orgId, session.userId, null);
  }

  // ---------------------------------------------------------------- manual entries

  async addManual(user: AuthenticatedUser, dto: ManualEntryDto): Promise<TimeEntry> {
    let projectId = dto.projectId ?? null;
    let task: TaskDetail | null = null;
    if (dto.taskId) {
      task = await this.tasks.get(user, dto.taskId);
      this.assertMayLogOn(user, task);
      if (projectId && task.projectId !== projectId) throw new BadRequestException('The task belongs to another project');
      projectId = task.projectId;
    }
    const entry = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await this.lockUserTime(db, user.id);
      const settings = await orgSettings(db, user.orgId);
      this.assertNotFuture(dto.workDate, settings);
      if (projectId && !dto.taskId) await this.assertProjectAccess(db, user, projectId);
      // ADR 049 §4 (FR-WT-018): declared times are org-local on the work date; they must have
      // ended and must not overlap the person's other timed entries.
      let start: Date | null = null;
      let end: Date | null = null;
      let minutes = dto.minutes ?? 0;
      if (dto.startTime && dto.endTime) {
        start = fromZonedTime(`${dto.workDate}T${dto.startTime}:00`, settings.timezone);
        end = fromZonedTime(`${dto.workDate}T${dto.endTime}:00`, settings.timezone);
        if (end.getTime() > this.now().getTime()) throw new BadRequestException('The work must have ended: the end time is in the future');
        minutes = minutesBetween(start, end);
        await this.assertNoOverlap(db, user, start, end, null);
      }
      const sheet = await ensureTimesheet(db, user.orgId, user.id, dto.workDate, settings);
      if (!isEditable(sheet.status)) throw new TimesheetLockedError(sheet.status);
      await this.assertDayFits(db, user, dto.workDate, minutes, null);
      const res = await db.query<{ id: string }>(
        `INSERT INTO time_entries (org_id, user_id, timesheet_id, project_id, task_id, work_date, minutes, source, billable, note, manual_reason,
           started_at, ended_at, title, work_type, category, task_title, project_name)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7, 'MANUAL', $8, $9, $10, $11, COALESCE($12, now()), $13, $14, $15, $16, $17) RETURNING id`,
        [user.orgId, user.id, sheet.id, projectId, dto.taskId ?? null, dto.workDate, minutes, dto.billable, dto.note, dto.reason,
          start, end, dto.title ?? null, dto.workType ?? null, dto.category ?? null, task?.title ?? null, await this.projectName(db, projectId)],
      );
      await this.auditEntry(db, user, 'TIME_ENTRY_MANUAL_ADDED', res.rows[0]!.id, { workDate: dto.workDate, minutes, projectId, taskId: dto.taskId ?? null, declaredTimes: !!start });
      await refreshDay(db, user.orgId, user.id, dto.workDate, settings);
      return (await this.entryById(db, res.rows[0]!.id, user.id))!;
    }).catch((err: unknown) => {
      throw mapTimeDbError(err);
    });
    this.logged(user.orgId, user.id, dto.workDate);
    return entry;
  }

  async update(user: AuthenticatedUser, entryId: string, dto: UpdateEntryDto): Promise<TimeEntry> {
    let workDate = '';
    // ADR 049 §4: linking a named entry to a task follows the task's own rules (visible, accepted,
    // and not someone else's task unless the person manages it).
    const task = dto.taskId ? await this.tasks.get(user, dto.taskId) : null;
    if (task) this.assertMayLogOn(user, task);
    const entry = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await this.lockUserTime(db, user.id);
      const e = await this.ownEditableEntry(db, user, entryId);
      if (e.source !== 'MANUAL' && (dto.minutes !== undefined || dto.reason !== undefined)) {
        throw new BadRequestException('Only manual entries can change their minutes or reason');
      }
      if (dto.minutes !== undefined && e.started_at !== null && e.source === 'MANUAL') {
        throw new BadRequestException('This entry has start and end times: delete it and add it again to change them');
      }
      if (task && e.task_id) throw new BadRequestException('This entry already belongs to a task');
      if (task && e.project_id && task.projectId !== e.project_id) throw new BadRequestException('The task belongs to another project');
      if (dto.minutes !== undefined) await this.assertDayFits(db, user, e.work_date, dto.minutes, e.id);
      const sets: string[] = [];
      const params: unknown[] = [entryId];
      const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
      if (dto.minutes !== undefined) set('minutes', dto.minutes);
      if (dto.note !== undefined) set('note', dto.note);
      if (dto.reason !== undefined) set('manual_reason', dto.reason);
      if (dto.billable !== undefined) set('billable', dto.billable);
      if (dto.title !== undefined) set('title', dto.title);
      if (dto.workType !== undefined) set('work_type', dto.workType);
      if (dto.category !== undefined) set('category', dto.category);
      if (task) {
        set('task_id', task.id);
        set('task_title', task.title);
        if (!e.project_id && task.projectId) {
          set('project_id', task.projectId);
          set('project_name', await this.projectName(db, task.projectId));
        }
      }
      await db.query(`UPDATE time_entries SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
      if (e.source === 'MANUAL' || task) {
        await this.auditEntry(db, user, 'TIME_ENTRY_MANUAL_UPDATED', entryId, { fields: Object.keys(dto).filter((k) => k !== 'note'), noteChanged: dto.note !== undefined });
      }
      await refreshDay(db, user.orgId, user.id, e.work_date);
      workDate = e.work_date;
      return (await this.entryById(db, entryId, user.id))!;
    }).catch((err: unknown) => {
      throw mapTimeDbError(err);
    });
    this.logged(user.orgId, user.id, workDate);
    return entry;
  }

  async remove(user: AuthenticatedUser, entryId: string): Promise<{ deleted: true }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const e = await this.ownEditableEntry(db, user, entryId);
      await db.query(`DELETE FROM time_entries WHERE id = $1`, [entryId]);
      if (e.source === 'MANUAL') await this.auditEntry(db, user, 'TIME_ENTRY_MANUAL_DELETED', entryId, { workDate: e.work_date, minutes: e.minutes });
      await refreshDay(db, user.orgId, user.id, e.work_date);
      return { deleted: true as const };
    }).catch((err: unknown) => {
      throw mapTimeDbError(err);
    });
  }

  async list(user: AuthenticatedUser, q: TimeEntryListQuery): Promise<{ items: TimeEntry[] }> {
    if (q.to < q.from) throw new BadRequestException('"to" is before "from"');
    if (addDaysIso(q.from, MAX_LIST_DAYS) < q.to) throw new BadRequestException(`At most ${MAX_LIST_DAYS} days at a time`);
    const ownerId = q.userId ?? user.id;
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      if (ownerId !== user.id) await this.assertMaySeeUser(db, user, ownerId);
      const res = await db.query<EntryRow>(
        `${ENTRY_SELECT} WHERE e.org_id = $1 AND e.user_id = $2 AND e.work_date BETWEEN $3::date AND $4::date
         ORDER BY e.work_date, e.started_at NULLS LAST, e.created_at`,
        [user.orgId, ownerId, q.from, q.to],
      );
      return { items: res.rows.map((r) => mapEntry(r, user.id)) };
    });
  }

  // ---------------------------------------------------------------- helpers

  /**
   * FR-TASK-007: an assignee who has not accepted a task cannot log time on it.
   * ADR 049 §3 (FR-WT-016): a task assigned to someone else takes time only from people who
   * manage it; everyone else records the work under their own title.
   */
  private assertMayLogOn(user: AuthenticatedUser, task: TaskDetail): void {
    const assigneeId = task.assignee?.id ?? null;
    if (assigneeId === user.id && (task.acceptanceStatus === 'PENDING' || task.acceptanceStatus === 'DECLINED')) {
      throw new ConflictException('Accept the task before logging time on it');
    }
    if (assigneeId && assigneeId !== user.id && !task.permissions.canEdit) {
      throw new ForbiddenException('This task is assigned to someone else: record the work under your own title instead');
    }
  }

  /** ADR 049 §4 (FR-WT-018): declared intervals never overlap the person's other timed entries. */
  private async assertNoOverlap(db: Db, user: AuthenticatedUser, start: Date, end: Date, excludeId: string | null): Promise<void> {
    const res = await db.query(
      `SELECT 1 FROM time_entries
       WHERE org_id = $1 AND user_id = $2 AND started_at IS NOT NULL AND ($5::uuid IS NULL OR id <> $5)
         AND tstzrange(started_at, COALESCE(ended_at, now())) && tstzrange($3, $4) LIMIT 1`,
      [user.orgId, user.id, start, end, excludeId],
    );
    if ((res.rowCount ?? 0) > 0) throw new ConflictException('This overlaps time you have already recorded');
  }

  private async projectName(db: Db, projectId: string | null): Promise<string | null> {
    if (!projectId) return null;
    const r = await db.query<{ name: string }>(`SELECT name FROM projects WHERE id = $1`, [projectId]);
    return r.rows[0]?.name ?? null;
  }

  /** ADR 049 §4: manual time is audited (metadata only, never the notes). */
  private async auditEntry(db: Db, user: AuthenticatedUser, action: string, entryId: string, after: Record<string, unknown>): Promise<void> {
    await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action, entityType: 'TIME_ENTRY', entityId: entryId, after });
  }

  private assertNotFuture(date: string, settings: OrgTimesheetSettings): void {
    if (date > localDate(this.now(), settings.timezone)) throw new BadRequestException('Time cannot be logged for a future day');
  }

  /**
   * Serialises everything that changes one person's logged time (the timer uses the same lock), so
   * the 24-hour check below and the write that follows it cannot interleave with another request.
   */
  private async lockUserTime(db: Db, userId: string): Promise<void> {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('timer:' || $1::text))`, [userId]);
  }

  private async assertDayFits(db: Db, user: AuthenticatedUser, date: string, minutes: number, excludeId: string | null): Promise<void> {
    const res = await db.query<{ total: number }>(
      `SELECT COALESCE(SUM(minutes), 0)::int AS total FROM time_entries
       WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date AND ($4::uuid IS NULL OR id <> $4)`,
      [user.orgId, user.id, date, excludeId],
    );
    if ((res.rows[0]?.total ?? 0) + minutes > 24 * 60) throw new BadRequestException('A day cannot hold more than 24 hours of time');
  }

  private async assertProjectAccess(db: Db, user: AuthenticatedUser, projectId: string): Promise<void> {
    const res = await db.query(
      `SELECT 1 FROM projects p WHERE p.id = $1 AND (
         $3 OR p.manager_id = $2 OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = $2))`,
      [projectId, user.id, userCan(user, Permission.TASKS_READ_ALL)],
    );
    if (res.rowCount === 0) throw new NotFoundException('Project not found');
  }

  private async ownEditableEntry(db: Db, user: AuthenticatedUser, entryId: string): Promise<EntryRow> {
    const res = await db.query<EntryRow>(`${ENTRY_SELECT} WHERE e.id = $1 FOR UPDATE OF e`, [entryId]);
    const e = res.rows[0];
    if (!e || e.user_id !== user.id) throw new NotFoundException('Time entry not found');
    if (!isEditable(e.timesheet_status)) throw new TimesheetLockedError(e.timesheet_status);
    if (e.ended_at === null) throw new ConflictException('Stop the timer first');
    return e;
  }

  private async assertMaySeeUser(db: Db, user: AuthenticatedUser, ownerId: string): Promise<void> {
    const res = await db.query<{ id: string; manager_id: string | null; team_id: string | null }>(
      `SELECT id, manager_id, team_id FROM users WHERE id = $1`,
      [ownerId],
    );
    const owner = res.rows[0];
    const ok = owner && (userCan(user, Permission.TIMESHEETS_READ_ALL) || inApprovalScope(actorOf(user), { id: owner.id, managerId: owner.manager_id, teamId: owner.team_id }));
    if (!ok) throw new ForbiddenException('You cannot see this person\'s time');
  }

  private async runningEntry(db: Db, userId: string, viewerId: string): Promise<TimeEntry | null> {
    const res = await db.query<EntryRow>(`${ENTRY_SELECT} WHERE e.user_id = $1 AND e.ended_at IS NULL`, [userId]);
    return res.rows[0] ? mapEntry(res.rows[0], viewerId) : null;
  }

  private async entryById(db: Db, id: string, viewerId: string): Promise<TimeEntry | null> {
    const res = await db.query<EntryRow>(`${ENTRY_SELECT} WHERE e.id = $1`, [id]);
    return res.rows[0] ? mapEntry(res.rows[0], viewerId) : null;
  }

  /** Used by the timesheet service for a timesheet's entries. */
  async entriesOf(db: Db, timesheetId: string, viewerId: string): Promise<TimeEntry[]> {
    const res = await db.query<EntryRow>(
      `${ENTRY_SELECT} WHERE e.timesheet_id = $1 ORDER BY e.work_date, e.started_at NULLS LAST, e.created_at`,
      [timesheetId],
    );
    return res.rows.map((r) => mapEntry(r, viewerId));
  }
}

interface Piece {
  date: string;
  start: Date;
  end: Date;
}

/** Splits [start, end] at each org-local midnight. */
export function splitAtMidnight(start: Date, end: Date, timezone: string): Piece[] {
  const pieces: Piece[] = [];
  let from = start;
  let date = localDate(start, timezone);
  for (let guard = 0; guard < 400; guard += 1) {
    const nextMidnight = fromZonedTime(`${addDaysIso(date, 1)}T00:00:00`, timezone);
    if (end.getTime() <= nextMidnight.getTime()) {
      pieces.push({ date, start: from, end });
      return pieces;
    }
    pieces.push({ date, start: from, end: nextMidnight });
    from = nextMidnight;
    date = addDaysIso(date, 1);
  }
  throw new Error('Timer spans too many days');
}

function minutesBetween(a: Date, b: Date): number {
  return Math.min(24 * 60, Math.floor((b.getTime() - a.getTime()) / 60_000));
}
