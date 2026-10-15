/**
 * Who may see and act on a timesheet (FR-TS-006, 011). Pure, unit-tested; the SQL list
 * filter in timesheets.sql.ts implements the same visibility.
 *
 *  - The owner sees their own and edits / submits while DRAFT or REJECTED.
 *  - Team leads and managers (timesheets.approve.team) see and approve direct reports and
 *    their own team; HR and admins (timesheets.approve.all) everyone.
 *  - timesheets.read.all (incl. the Finance/Auditor role) is read-only.
 *  - Nobody approves their own timesheet. Approved = locked; only timesheet.reopen reopens.
 *  - Subcontractors hold none of the wider permissions, so they only ever see their own.
 */
import { Permission, userCan } from '../../../../packages/shared/src/auth/types.ts';
import { EDITABLE_TIMESHEET_STATUSES } from '../../../../packages/shared/src/timesheets/types.ts';
import type { TimesheetPermissions, TimesheetStatus } from '../../../../packages/shared/src/timesheets/types.ts';

export interface TimesheetActor {
  id: string;
  role: string;
  teamId: string | null;
  /** Effective permissions (custom roles, FR-ADM-002); absent = the role's defaults. */
  permissions?: readonly string[];
}

export interface TimesheetFacts {
  ownerId: string;
  ownerManagerId: string | null;
  ownerTeamId: string | null;
  status: TimesheetStatus;
}

export function inApprovalScope(actor: TimesheetActor, owner: { id: string; managerId: string | null; teamId: string | null }): boolean {
  if (owner.id === actor.id) return false;
  if (userCan(actor, Permission.TIMESHEETS_APPROVE_ALL)) return true;
  if (!userCan(actor, Permission.TIMESHEETS_APPROVE_TEAM)) return false;
  return owner.managerId === actor.id || (!!actor.teamId && owner.teamId === actor.teamId);
}

export function timesheetPermissions(actor: TimesheetActor, f: TimesheetFacts): TimesheetPermissions {
  const isOwner = f.ownerId === actor.id;
  const approver = inApprovalScope(actor, { id: f.ownerId, managerId: f.ownerManagerId, teamId: f.ownerTeamId });
  const canView = isOwner || approver || userCan(actor, Permission.TIMESHEETS_READ_ALL);
  if (!canView) return { canView: false, canEdit: false, canSubmit: false, canApprove: false, canReopen: false };
  const editable = EDITABLE_TIMESHEET_STATUSES.includes(f.status);
  const ownerMayUse = isOwner && userCan(actor, Permission.TIMESHEETS_USE);
  return {
    canView,
    canEdit: ownerMayUse && editable,
    canSubmit: ownerMayUse && editable,
    canApprove: approver && f.status === 'SUBMITTED',
    canReopen: !isOwner && f.status === 'APPROVED' && userCan(actor, Permission.TIMESHEET_REOPEN),
  };
}
