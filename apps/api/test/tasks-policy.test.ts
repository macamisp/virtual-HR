/**
 * Task visibility / authority policy and default workflow (FR-TASK-002, 007; visibility rules
 * agreed for the TASK slice). Written before the implementation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canAssignTo,
  canSeeTask,
  requiresAcceptance,
  taskPermissions,
} from '../src/tasks/task-policy.ts';
import type { TaskActor, TaskFacts } from '../src/tasks/task-policy.ts';
import { canTransition, TASK_STATUSES } from '../../../packages/shared/src/tasks/types.ts';

const TEAM = 'team-1';
const actor = (id: string, role: string, teamId: string | null = null): TaskActor => ({ id, role, teamId });
const facts = (over: Partial<TaskFacts> = {}): TaskFacts => ({
  reporterId: 'reporter',
  assigneeId: 'assignee',
  assigneeManagerId: null,
  assigneeTeamId: null,
  actorIsProjectMember: false,
  actorIsProjectManager: false,
  acceptanceStatus: 'NOT_REQUIRED',
  ...over,
});

describe('Task visibility', () => {
  it('assignee and reporter see the task', () => {
    assert.equal(canSeeTask(actor('assignee', 'EMPLOYEE'), facts()), true);
    assert.equal(canSeeTask(actor('reporter', 'EMPLOYEE'), facts()), true);
  });

  it('an unrelated employee or subcontractor does not', () => {
    assert.equal(canSeeTask(actor('x', 'EMPLOYEE'), facts()), false);
    assert.equal(canSeeTask(actor('x', 'SUBCONTRACTOR'), facts()), false);
  });

  it("project members (employees and subcontractors) see their project's tasks", () => {
    assert.equal(canSeeTask(actor('x', 'SUBCONTRACTOR'), facts({ actorIsProjectMember: true })), true);
    assert.equal(canSeeTask(actor('x', 'EMPLOYEE'), facts({ actorIsProjectMember: true })), true);
  });

  it('managers see tasks of their team (team or direct report), not other teams', () => {
    const lead = actor('lead', 'TEAM_LEAD', TEAM);
    assert.equal(canSeeTask(lead, facts({ assigneeTeamId: TEAM })), true);
    assert.equal(canSeeTask(actor('mgr', 'MANAGER'), facts({ assigneeManagerId: 'mgr' })), true);
    assert.equal(canSeeTask(lead, facts({ assigneeTeamId: 'other-team' })), false);
  });

  it('HR and admins see everything; auditors do not get task access', () => {
    for (const role of ['HR', 'HR_MANAGER', 'ADMIN', 'SUPER_ADMIN']) {
      assert.equal(canSeeTask(actor('x', role), facts()), true, role);
    }
    assert.equal(canSeeTask(actor('x', 'AUDITOR'), facts()), false);
  });

  it('the project manager sees project tasks', () => {
    assert.equal(canSeeTask(actor('pm', 'EMPLOYEE'), facts({ actorIsProjectManager: true })), true);
  });
});

describe('Task permissions', () => {
  it('assignee may change status and comment but not edit fields or delete', () => {
    const p = taskPermissions(actor('assignee', 'EMPLOYEE'), facts());
    assert.deepEqual(p, { canEdit: false, canChangeStatus: true, canAssign: false, canRespond: false, canDelete: false, canComment: true });
  });

  it('reporter manages the task', () => {
    const p = taskPermissions(actor('reporter', 'TEAM_LEAD', TEAM), facts());
    assert.equal(p.canEdit, true);
    assert.equal(p.canAssign, true);
    assert.equal(p.canDelete, true);
  });

  it('a pending or declined subcontractor cannot move the task until it is accepted', () => {
    for (const acceptanceStatus of ['PENDING', 'DECLINED'] as const) {
      const p = taskPermissions(actor('assignee', 'SUBCONTRACTOR'), facts({ acceptanceStatus }));
      assert.equal(p.canChangeStatus, false, acceptanceStatus);
    }
    assert.equal(taskPermissions(actor('assignee', 'SUBCONTRACTOR'), facts({ acceptanceStatus: 'PENDING' })).canRespond, true);
    assert.equal(taskPermissions(actor('assignee', 'SUBCONTRACTOR'), facts({ acceptanceStatus: 'ACCEPTED' })).canRespond, false);
  });

  it('a project member who is neither reporter nor assignee can only view and comment', () => {
    const p = taskPermissions(actor('x', 'SUBCONTRACTOR'), facts({ actorIsProjectMember: true }));
    assert.deepEqual(p, { canEdit: false, canChangeStatus: false, canAssign: false, canRespond: false, canDelete: false, canComment: true });
  });

  it('someone who cannot see the task gets no permissions at all', () => {
    const p = taskPermissions(actor('x', 'EMPLOYEE'), facts());
    assert.ok(Object.values(p).every((v) => v === false));
  });
});

describe('Assignment scope (FR-TASK-007)', () => {
  const target = (over: Partial<{ id: string; managerId: string | null; teamId: string | null }> = {}) => ({
    id: 'target',
    managerId: null,
    teamId: null,
    ...over,
  });

  it('anyone may assign to themselves', () => {
    assert.equal(canAssignTo(actor('target', 'SUBCONTRACTOR'), target(), { actorManagesProject: false, targetIsProjectMember: false }), true);
  });

  it('employees cannot assign to others', () => {
    assert.equal(canAssignTo(actor('e', 'EMPLOYEE'), target(), { actorManagesProject: false, targetIsProjectMember: false }), false);
  });

  it('leads assign within their team or direct reports, or to members of a project they manage', () => {
    const lead = actor('lead', 'TEAM_LEAD', TEAM);
    const none = { actorManagesProject: false, targetIsProjectMember: false };
    assert.equal(canAssignTo(lead, target({ teamId: TEAM }), none), true);
    assert.equal(canAssignTo(lead, target({ managerId: 'lead' }), none), true);
    assert.equal(canAssignTo(lead, target({ teamId: 'other' }), none), false);
    assert.equal(canAssignTo(lead, target({ teamId: 'other' }), { actorManagesProject: true, targetIsProjectMember: true }), true);
  });

  it('HR assigns to anyone', () => {
    assert.equal(canAssignTo(actor('hr', 'HR'), target({ teamId: 'other' }), { actorManagesProject: false, targetIsProjectMember: false }), true);
  });

  it('subcontractors assigned by someone else must accept; self-assigned or employees do not', () => {
    assert.equal(requiresAcceptance(actor('lead', 'TEAM_LEAD'), { id: 's', role: 'SUBCONTRACTOR' }), true);
    assert.equal(requiresAcceptance(actor('s', 'SUBCONTRACTOR'), { id: 's', role: 'SUBCONTRACTOR' }), false);
    assert.equal(requiresAcceptance(actor('lead', 'TEAM_LEAD'), { id: 'e', role: 'EMPLOYEE' }), false);
  });
});

describe('Default workflow (FR-TASK-002)', () => {
  it('allows the documented moves and staying put', () => {
    assert.equal(canTransition('TODO', 'IN_PROGRESS'), true);
    assert.equal(canTransition('IN_PROGRESS', 'IN_REVIEW'), true);
    assert.equal(canTransition('IN_REVIEW', 'DONE'), true);
    assert.equal(canTransition('DONE', 'IN_PROGRESS'), true);
    for (const s of TASK_STATUSES) assert.equal(canTransition(s, s), true);
  });

  it('rejects skipping review back to TODO from DONE or IN_REVIEW', () => {
    assert.equal(canTransition('DONE', 'TODO'), false);
    assert.equal(canTransition('IN_REVIEW', 'TODO'), false);
    assert.equal(canTransition('BLOCKED', 'DONE'), false);
  });
});
