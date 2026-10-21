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
  TimeEntry,
  TimeEntryListQuery,
  TimerState,
  UpdateEntryDto,
} from '../../../../packages/shared/src/timesheets/types.ts';
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

  async startTimer(user: AuthenticatedUser, taskId: string): Promise<TimerState> {
    const task = await this.tasks.get(user, taskId);
    this.assertMayLogOn(user, task.assignee?.id ?? null, task.acceptanceStatus);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext('timer:' || $1::text))`, [user.id]);
      const open = await db.query(
        `SELECT 1 FROM attendance_sessions WHERE org_id = $1 AND user_id = $2 AND status = 'OPEN' AND clock_out_at IS NULL LIMIT 1`,
        [user.orgId, user.id],
      );
      if (open.rowCount === 0) throw new ConflictException('Clock in before starting a timer: you are not tracked as online');
      const current = await this.runningEntry(db, user.id, user.id);
      if (current?.taskId === taskId) return { running: current, serverNow: this.now().toISOString(), stopped: null };

      const now = this.now();
      // FR-TS-003: only one timer at a time; starting another stops the current one.
      const stoppedId = current ? await this.stopRunning(db, user.orgId, user.id, now, false) : null;
      const settings = await orgSettings(db, user.orgId);
      const date = localDate(now, settings.timezone);
      const sheet = await ensureTimesheet(db, user.orgId, user.id, date, settings);
      if (!isEditable(sheet.status)) throw new TimesheetLockedError(sheet.status);
      try {
        await db.query(
          `INSERT INTO time_entries (org_id, user_id, timesheet_id, project_id, task_id, work_date, started_at, source)
           VALUES ($1, $2, $3, $4, $5, $6::date, $7, 'TIMER')`,
          [user.orgId, user.id, sheet.id, task.projectId, taskId, date, now],
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
    const res = await db.query<{ id: string; started_at: Date; project_id: string | null; task_id: string | null; billable: boolean; note: string }>(
      `SELECT id, started_at, project_id, task_id, billable, note FROM time_entries
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
        `INSERT INTO time_entries (org_id, user_id, timesheet_id, project_id, task_id, work_date, started_at, ended_at, minutes, source, billable, note, auto_stopped)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, 'TIMER', $10, $11, $12)`,
        [orgId, userId, sheet.id, run.project_id, run.task_id, p.date, p.start, p.end, minutesBetween(p.start, p.end), run.billable, run.note, auto],
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
    if (dto.taskId) {
      const task = await this.tasks.get(user, dto.taskId);
      this.assertMayLogOn(user, task.assignee?.id ?? null, task.acceptanceStatus);
      if (projectId && task.projectId !== projectId) throw new BadRequestException('The task belongs to another project');
      projectId = task.projectId;
    }
    const entry = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await this.lockUserTime(db, user.id);
      const settings = await orgSettings(db, user.orgId);
      this.assertNotFuture(dto.workDate, settings);
      if (projectId && !dto.taskId) await this.assertProjectAccess(db, user, projectId);
      const sheet = await ensureTimesheet(db, user.orgId, user.id, dto.workDate, settings);
      if (!isEditable(sheet.status)) throw new TimesheetLockedError(sheet.status);
      await this.assertDayFits(db, user, dto.workDate, dto.minutes, null);
      const res = await db.query<{ id: string }>(
        `INSERT INTO time_entries (org_id, user_id, timesheet_id, project_id, task_id, work_date, minutes, source, billable, note, manual_reason, ended_at)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7, 'MANUAL', $8, $9, $10, now()) RETURNING id`,
        [user.orgId, user.id, sheet.id, projectId, dto.taskId ?? null, dto.workDate, dto.minutes, dto.billable, dto.note, dto.reason],
      );
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
    const entry = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await this.lockUserTime(db, user.id);
      const e = await this.ownEditableEntry(db, user, entryId);
      if (e.source !== 'MANUAL' && (dto.minutes !== undefined || dto.reason !== undefined)) {
        throw new BadRequestException('Only manual entries can change their minutes or reason');
      }
      if (dto.minutes !== undefined) await this.assertDayFits(db, user, e.work_date, dto.minutes, e.id);
      await db.query(
        `UPDATE time_entries SET
           minutes = COALESCE($2, minutes), note = COALESCE($3, note), manual_reason = COALESCE($4, manual_reason),
           billable = COALESCE($5, billable), updated_at = now()
         WHERE id = $1`,
        [entryId, dto.minutes ?? null, dto.note ?? null, dto.reason ?? null, dto.billable ?? null],
      );
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

  /** FR-TASK-007: an assignee who has not accepted a task cannot log time on it. */
  private assertMayLogOn(user: AuthenticatedUser, assigneeId: string | null, acceptance: string): void {
    if (assigneeId === user.id && (acceptance === 'PENDING' || acceptance === 'DECLINED')) {
      throw new ConflictException('Accept the task before logging time on it');
    }
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
