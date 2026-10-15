/**
 * SQL for the tasks module. All queries run inside runWithTenantContext (RLS enforces org_id);
 * the explicit org_id filters are defence in depth.
 *
 * VISIBLE_TO implements the same rule as task-policy.ts `canSeeTask` for a *parameterised*
 * viewer, so it can be used both for "what can I see" and "can user X see this task".
 */
import type pg from 'pg';
import { ROLE_PERMISSIONS, Permission } from '../../../../packages/shared/src/auth/types.ts';
import type { TaskSummary, UserRef } from '../../../../packages/shared/src/tasks/types.ts';
import type { TaskActor } from './task-policy.ts';

const rolesWith = (perm: string): string[] =>
  Object.entries(ROLE_PERMISSIONS)
    .filter(([, perms]) => (perms as string[]).includes(perm))
    .map(([role]) => role);

export const READ_ALL_ROLES = rolesWith(Permission.TASKS_READ_ALL);
export const READ_TEAM_ROLES = rolesWith(Permission.TASKS_READ_TEAM);

/** Columns for TaskSummary; expects aliases t (tasks), a (assignee), r (reporter), p (projects). */
export const SUMMARY_COLUMNS = `
  t.id, t.title, t.status, t.priority, t.project_id, p.code AS project_code, t.parent_task_id,
  t.assignee_id, a.display_name AS a_name, a.email AS a_email, a.role AS a_role,
  a.manager_id AS a_manager_id, a.team_id AS a_team_id,
  t.reporter_id, r.display_name AS r_name, r.email AS r_email, r.role AS r_role,
  t.acceptance_status, to_char(t.due_date, 'YYYY-MM-DD') AS due_date,
  to_char(t.planned_date, 'YYYY-MM-DD') AS planned_date, t.estimate_minutes, t.actual_minutes,
  t.labels, t.completed_at, t.updated_at, t.version,
  (SELECT count(*) FILTER (WHERE c.done) FROM task_checklist_items c WHERE c.task_id = t.id)::int AS checklist_done,
  (SELECT count(*) FROM task_checklist_items c WHERE c.task_id = t.id)::int AS checklist_total,
  (SELECT count(*) FROM tasks s WHERE s.parent_task_id = t.id AND s.deleted_at IS NULL)::int AS subtask_count`;

export const SUMMARY_FROM = `
  FROM tasks t
  JOIN users r ON r.id = t.reporter_id
  LEFT JOIN users a ON a.id = t.assignee_id
  LEFT JOIN projects p ON p.id = t.project_id`;

/**
 * Visibility predicate for a viewer given by four SQL expressions (user id, team id, sees-all,
 * team-scope). Use viewerParams() to bind them for the calling actor.
 */
export function visibleTo(v: { id: string; teamId: string; all: string; team: string }): string {
  return `(
    ${v.all}
    OR t.assignee_id = ${v.id} OR t.reporter_id = ${v.id}
    OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = ${v.id})
    OR p.manager_id = ${v.id}
    OR (${v.team} AND t.assignee_id IS NOT NULL
        AND (a.manager_id = ${v.id} OR (${v.teamId} IS NOT NULL AND a.team_id = ${v.teamId})))
  )`;
}

/** Binds the actor as viewer at parameter positions start..start+3. */
export function viewerParams(actor: TaskActor, start: number): { sql: string; params: unknown[] } {
  const [id, team, all, scope] = [start, start + 1, start + 2, start + 3].map((n) => `$${n}`);
  return {
    sql: visibleTo({ id: `${id}::uuid`, teamId: `${team}::uuid`, all: `${all}::boolean`, team: `${scope}::boolean` }),
    params: [actor.id, actor.teamId, READ_ALL_ROLES.includes(actor.role), READ_TEAM_ROLES.includes(actor.role)],
  };
}

/** Team-scope predicate alone (for the "team" list filter and workload). */
export function teamScopeSql(idParam: string, teamParam: string): string {
  return `(t.assignee_id IS NOT NULL AND (a.manager_id = ${idParam}::uuid OR (${teamParam}::uuid IS NOT NULL AND a.team_id = ${teamParam}::uuid)))`;
}

type Row = pg.QueryResultRow;

export function userRef(id: string, name: unknown, email: unknown, role: unknown): UserRef {
  return { id, displayName: (name as string | null) ?? null, email: String(email), role: String(role) };
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? new Date(String(v)).toISOString() : null);

export function mapSummary(row: Row, actualMinutes: number | null = null): TaskSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    projectId: row.project_id ?? null,
    projectCode: row.project_code ?? null,
    parentTaskId: row.parent_task_id ?? null,
    assignee: row.assignee_id ? userRef(row.assignee_id, row.a_name, row.a_email, row.a_role) : null,
    reporter: userRef(row.reporter_id, row.r_name, row.r_email, row.r_role),
    acceptanceStatus: row.acceptance_status,
    dueDate: row.due_date ?? null,
    plannedDate: row.planned_date ?? null,
    estimateMinutes: row.estimate_minutes ?? null,
    actualMinutes: actualMinutes ?? row.actual_minutes ?? null,
    labels: row.labels ?? [],
    checklistDone: row.checklist_done ?? 0,
    checklistTotal: row.checklist_total ?? 0,
    subtaskCount: row.subtask_count ?? 0,
    completedAt: iso(row.completed_at),
    updatedAt: iso(row.updated_at)!,
    version: row.version,
  };
}

export const toIso = iso;
