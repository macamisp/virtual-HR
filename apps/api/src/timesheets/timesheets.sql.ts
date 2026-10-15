/**
 * Shared SQL fragments and row mappers for time entries and timesheets. The visibility
 * filter mirrors timesheet-policy.ts (covered by the e2e tests).
 */
import { ConflictException } from '@nestjs/common';
import { Permission, userCan } from '../../../../packages/shared/src/auth/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import type { EntrySource, TimeEntry, TimesheetStatus } from '../../../../packages/shared/src/timesheets/types.ts';
import { toIso } from '../tasks/tasks.sql.ts';
import { isEditable, TimesheetLockedError } from './timesheet-store.ts';
import type { TimesheetActor } from './timesheet-policy.ts';

export function actorOf(user: AuthenticatedUser): TimesheetActor {
  return { id: user.id, role: user.role, teamId: user.teamId ?? null, permissions: user.permissions };
}

export const ENTRY_SELECT = `
  SELECT e.id, e.user_id, e.timesheet_id, e.task_id, tk.title AS task_title, e.project_id, pr.name AS project_name,
         to_char(e.work_date, 'YYYY-MM-DD') AS work_date, e.started_at, e.ended_at, e.minutes, e.source, e.billable,
         e.note, e.manual_reason, e.flagged, e.flag_reason, e.auto_stopped, ts.status AS timesheet_status
  FROM time_entries e
  JOIN timesheets ts ON ts.id = e.timesheet_id
  LEFT JOIN tasks tk ON tk.id = e.task_id
  LEFT JOIN projects pr ON pr.id = e.project_id`;

export interface EntryRow {
  id: string;
  user_id: string;
  timesheet_id: string;
  task_id: string | null;
  task_title: string | null;
  project_id: string | null;
  project_name: string | null;
  work_date: string;
  started_at: Date | null;
  ended_at: Date | null;
  minutes: number;
  source: EntrySource;
  billable: boolean;
  note: string;
  manual_reason: string | null;
  flagged: boolean;
  flag_reason: string | null;
  auto_stopped: boolean;
  timesheet_status: TimesheetStatus;
}

export function mapEntry(r: EntryRow, viewerId: string): TimeEntry {
  return {
    id: r.id,
    userId: r.user_id,
    timesheetId: r.timesheet_id,
    taskId: r.task_id,
    taskTitle: r.task_title,
    projectId: r.project_id,
    projectName: r.project_name,
    workDate: r.work_date,
    startedAt: toIso(r.started_at),
    endedAt: toIso(r.ended_at),
    minutes: r.minutes,
    source: r.source,
    billable: r.billable,
    note: r.note,
    manualReason: r.manual_reason,
    flagged: r.flagged,
    flagReason: r.flag_reason,
    autoStopped: r.auto_stopped,
    running: r.ended_at === null,
    editable: r.user_id === viewerId && isEditable(r.timesheet_status),
  };
}

/**
 * Whose timesheets `user` may read beyond their own: `$n` placeholders are appended to
 * `params`. Returns a condition on the alias `u` (the owner).
 */
export function visibleOwnersSql(user: AuthenticatedUser, params: unknown[], scope: 'mine' | 'team' | 'all'): string {
  if (scope === 'mine') {
    params.push(user.id);
    return `u.id = $${params.length}`;
  }
  const all = userCan(user, Permission.TIMESHEETS_READ_ALL) || userCan(user, Permission.TIMESHEETS_APPROVE_ALL);
  if (scope === 'all' && all) return 'TRUE';
  if (!userCan(user, Permission.TIMESHEETS_APPROVE_TEAM) && !all) {
    params.push(user.id);
    return `u.id = $${params.length}`;
  }
  params.push(user.id);
  const me = `$${params.length}`;
  params.push(user.teamId ?? null);
  const team = `$${params.length}::uuid`;
  return `(u.id <> ${me} AND (u.manager_id = ${me} OR (${team} IS NOT NULL AND u.team_id = ${team})))`;
}

/** Turns lock-guard and constraint violations into HTTP 409s. */
export function mapTimeDbError(err: unknown): unknown {
  if (err instanceof TimesheetLockedError) return new ConflictException(err.message);
  const e = err as { code?: string; hint?: string; constraint?: string; message?: string };
  if (e?.hint === 'TIMESHEET_LOCKED') return new ConflictException(`This timesheet is locked: ${e.message ?? ''}`.trim());
  if (e?.code === '23505' && e.constraint === 'time_entries_one_running_timer') return new ConflictException('A timer is already running');
  return err;
}
