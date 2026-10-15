/**
 * Who may see and act on a task. Pure functions so the rules are unit-tested; the SQL list
 * filter in tasks.repository.ts implements the same visibility rule (covered by e2e).
 *
 * Visibility (agreed for the TASK slice):
 *  - assignee and reporter;
 *  - members and the manager of the task's project (employees and subcontractors alike);
 *  - managers/team leads for tasks assigned to their team or direct reports;
 *  - HR and admins: everything in the organisation.
 */
import { Permission, userCan } from '../../../../packages/shared/src/auth/types.ts';
import type { AcceptanceStatus, TaskPermissions } from '../../../../packages/shared/src/tasks/types.ts';

export interface TaskActor {
  id: string;
  role: string;
  teamId: string | null;
  /** Effective permissions (custom roles, FR-ADM-002); absent = the role's defaults. */
  permissions?: readonly string[];
}

export interface TaskFacts {
  reporterId: string;
  assigneeId: string | null;
  assigneeManagerId: string | null;
  assigneeTeamId: string | null;
  actorIsProjectMember: boolean;
  actorIsProjectManager: boolean;
  acceptanceStatus: AcceptanceStatus;
}

export function seesAllTasks(actor: TaskActor): boolean {
  return userCan(actor, Permission.TASKS_READ_ALL);
}

/** Team scope: tasks whose assignee reports to the actor or sits in the actor's team. */
function inTeamScope(actor: TaskActor, f: TaskFacts): boolean {
  if (!userCan(actor, Permission.TASKS_READ_TEAM) || !f.assigneeId) return false;
  return f.assigneeManagerId === actor.id || (!!actor.teamId && f.assigneeTeamId === actor.teamId);
}

export function canSeeTask(actor: TaskActor, f: TaskFacts): boolean {
  return (
    seesAllTasks(actor) ||
    f.reporterId === actor.id ||
    f.assigneeId === actor.id ||
    f.actorIsProjectMember ||
    f.actorIsProjectManager ||
    inTeamScope(actor, f)
  );
}

/** Managing a task = editing its fields, (re)assigning it and moving it regardless of acceptance. */
function managesTask(actor: TaskActor, f: TaskFacts): boolean {
  return seesAllTasks(actor) || f.reporterId === actor.id || f.actorIsProjectManager || inTeamScope(actor, f);
}

export function taskPermissions(actor: TaskActor, f: TaskFacts): TaskPermissions {
  if (!canSeeTask(actor, f)) {
    return { canEdit: false, canChangeStatus: false, canAssign: false, canRespond: false, canDelete: false, canComment: false };
  }
  const manages = managesTask(actor, f);
  const isAssignee = f.assigneeId === actor.id;
  const awaitingAcceptance = f.acceptanceStatus === 'PENDING' || f.acceptanceStatus === 'DECLINED';
  return {
    canEdit: manages,
    // FR-TASK-007: a subcontractor works on a task only after accepting it.
    canChangeStatus: manages || (isAssignee && !awaitingAcceptance),
    canAssign: manages,
    canRespond: isAssignee && f.acceptanceStatus === 'PENDING',
    canDelete: seesAllTasks(actor) || f.reporterId === actor.id,
    canComment: true,
  };
}

/**
 * May `actor` assign a task to `target`? Everyone may assign to themselves. Others need
 * tasks.assign and the target in scope: anyone (HR/admin), own team or direct reports
 * (leads/managers), or members of a project the actor manages.
 */
export function canAssignTo(
  actor: TaskActor,
  target: { id: string; managerId: string | null; teamId: string | null },
  ctx: { actorManagesProject: boolean; targetIsProjectMember: boolean },
): boolean {
  if (target.id === actor.id) return true;
  if (!userCan(actor, Permission.TASKS_ASSIGN)) return false;
  if (seesAllTasks(actor)) return true;
  if (target.managerId === actor.id) return true;
  if (actor.teamId && target.teamId === actor.teamId) return true;
  return ctx.actorManagesProject && ctx.targetIsProjectMember;
}

/** FR-TASK-007 (agreed): only subcontractors accept, and only tasks assigned by someone else. */
export function requiresAcceptance(actor: TaskActor, assignee: { id: string; role: string }): boolean {
  return assignee.role === 'SUBCONTRACTOR' && assignee.id !== actor.id;
}
