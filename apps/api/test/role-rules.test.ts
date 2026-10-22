/**
 * FR-ADM-002 custom roles and assignment rules (ADR 011). Pure.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkRoleDefinition, mayAssign, ownerChangeProblem } from '../src/admin/role-rules.ts';
import { effectivePermissions, Permission, requiresMfa, ROLE_PERMISSIONS, UserRole } from '../../../packages/shared/src/auth/types.ts';

const ADMIN_PERMS = ROLE_PERMISSIONS[UserRole.ADMIN];

describe('Custom role definitions (FR-ADM-002)', () => {
  it('a custom role = base role + additions - removals; no-op changes are dropped', () => {
    const r = checkRoleDefinition({
      baseRole: UserRole.EMPLOYEE,
      added: [Permission.TIMESHEETS_READ_ALL, Permission.TASKS_USE /* already in EMPLOYEE */],
      removed: [Permission.DOCUMENTS_USE, Permission.AUDIT_READ /* not in EMPLOYEE */],
      grantable: ADMIN_PERMS,
      actorIsSuperAdmin: false,
    });
    assert.ok(!('error' in r));
    assert.deepEqual(r.added, [Permission.TIMESHEETS_READ_ALL]);
    assert.deepEqual(r.removed, [Permission.DOCUMENTS_USE]);
    const eff = effectivePermissions(UserRole.EMPLOYEE, r.added, r.removed);
    assert.ok(eff.includes(Permission.TIMESHEETS_READ_ALL));
    assert.ok(!eff.includes(Permission.DOCUMENTS_USE));
    assert.ok(eff.includes(Permission.TASKS_USE));
  });

  it('cannot be based on SUPER_ADMIN', () => {
    const r = checkRoleDefinition({ baseRole: UserRole.SUPER_ADMIN, added: [], removed: [], grantable: ADMIN_PERMS, actorIsSuperAdmin: true });
    assert.match((r as { error: string }).error, /super admin/i);
  });

  it('a permission cannot be added and removed at once', () => {
    const r = checkRoleDefinition({ baseRole: UserRole.HR, added: [Permission.AUDIT_READ], removed: [Permission.AUDIT_READ], grantable: ADMIN_PERMS, actorIsSuperAdmin: false });
    assert.ok('error' in r);
  });

  it('2FA-grade permissions need a base role that requires 2FA', () => {
    for (const p of [Permission.ORG_MANAGE, Permission.USERS_MANAGE, Permission.ROLES_MANAGE, Permission.PRIVACY_MANAGE]) {
      const r = checkRoleDefinition({ baseRole: UserRole.MANAGER, added: [p], removed: [], grantable: ADMIN_PERMS, actorIsSuperAdmin: false });
      assert.match((r as { error: string }).error, /two-factor/i, p);
    }
    const ok = checkRoleDefinition({ baseRole: UserRole.HR, added: [Permission.ROLES_MANAGE], removed: [], grantable: ADMIN_PERMS, actorIsSuperAdmin: false });
    assert.ok(!('error' in ok));
    assert.equal(requiresMfa(UserRole.MANAGER, [Permission.ROLES_MANAGE]), true);
    assert.equal(requiresMfa(UserRole.MANAGER, ROLE_PERMISSIONS[UserRole.MANAGER]), false);
  });

  it('nobody grants what they do not hold (SUPER_ADMIN excepted)', () => {
    const hrPerms = ROLE_PERMISSIONS[UserRole.HR];
    const r = checkRoleDefinition({ baseRole: UserRole.HR, added: [Permission.ROLES_MANAGE], removed: [], grantable: hrPerms, actorIsSuperAdmin: false });
    assert.match((r as { error: string }).error, /roles\.manage/);
    // Even through the base role: an HR admin cannot mint an ADMIN-based role.
    const viaBase = checkRoleDefinition({ baseRole: UserRole.ADMIN, added: [], removed: [], grantable: hrPerms, actorIsSuperAdmin: false });
    assert.ok('error' in viaBase);
    const superAdmin = checkRoleDefinition({ baseRole: UserRole.HR_MANAGER, added: [], removed: [], grantable: [], actorIsSuperAdmin: true });
    assert.ok(!('error' in superAdmin));
  });
});

describe('Role assignment (FR-ADM-002)', () => {
  const admin = { id: 'a', role: UserRole.ADMIN, permissions: ADMIN_PERMS };
  const base = { currentRole: UserRole.EMPLOYEE as UserRole, currentPermissions: ROLE_PERMISSIONS[UserRole.EMPLOYEE] };

  it('within the admin\'s own permissions is allowed', () => {
    assert.equal(mayAssign({ actor: admin, ...base, newRole: UserRole.MANAGER, newPermissions: ROLE_PERMISSIONS[UserRole.MANAGER] }), null);
  });

  it('SUPER_ADMIN is given and taken only by a super admin', () => {
    assert.match(mayAssign({ actor: admin, ...base, newRole: UserRole.SUPER_ADMIN, newPermissions: ROLE_PERMISSIONS[UserRole.SUPER_ADMIN] })!, /super admin/i);
    assert.match(mayAssign({ actor: admin, currentRole: UserRole.SUPER_ADMIN, currentPermissions: ROLE_PERMISSIONS[UserRole.SUPER_ADMIN], newRole: UserRole.EMPLOYEE, newPermissions: [] })!, /super admin/i);
    const sa = { id: 's', role: UserRole.SUPER_ADMIN, permissions: ROLE_PERMISSIONS[UserRole.SUPER_ADMIN] };
    assert.equal(mayAssign({ actor: sa, ...base, newRole: UserRole.SUPER_ADMIN, newPermissions: ROLE_PERMISSIONS[UserRole.SUPER_ADMIN] }), null);
  });

  it('cannot grant beyond, or demote someone holding more than, the admin', () => {
    const narrow = { id: 'n', role: UserRole.ADMIN, permissions: ADMIN_PERMS.filter((p) => p !== Permission.TIMESHEETS_READ_ALL) };
    assert.match(mayAssign({ actor: narrow, ...base, newRole: UserRole.EMPLOYEE, newPermissions: [...base.currentPermissions, Permission.TIMESHEETS_READ_ALL] })!, /do not hold/);
    assert.match(mayAssign({ actor: narrow, currentRole: UserRole.AUDITOR, currentPermissions: ROLE_PERMISSIONS[UserRole.AUDITOR], newRole: UserRole.EMPLOYEE, newPermissions: base.currentPermissions })!, /do not hold/);
  });
});

describe('Coverage of team permissions', () => {
  it('an organisation-wide permission covers its team form, not the reverse', async () => {
    const { covers } = await import('../src/admin/role-rules.ts');
    assert.equal(covers([Permission.TIMESHEETS_APPROVE_ALL], Permission.TIMESHEETS_APPROVE_TEAM), true);
    assert.equal(covers([Permission.TIMESHEETS_APPROVE_TEAM], Permission.TIMESHEETS_APPROVE_ALL), false);
    assert.equal(covers([Permission.TIMESHEETS_APPROVE_ALL], Permission.ATTENDANCE_READ_TEAM), false);
  });
});

describe('Owner protection (ADR 037)', () => {
  it('org.owner is never part of a custom role', () => {
    const r = checkRoleDefinition({ baseRole: UserRole.ADMIN, added: [Permission.ORG_OWNER], removed: [], grantable: [], actorIsSuperAdmin: true });
    assert.ok('error' in r && /ownership/i.test(r.error));
  });

  it('non-owners are untouched by the owner rules; only an owner changes an owner', () => {
    assert.equal(ownerChangeProblem({ actorIsOwner: false, targetIsOwner: false, targetIsLastOwner: false, change: 'ROLE', newRole: UserRole.EMPLOYEE }), null);
    assert.equal(ownerChangeProblem({ actorIsOwner: false, targetIsOwner: true, targetIsLastOwner: false, change: 'STATUS', newStatus: 'SUSPENDED' })?.status, 403);
    assert.equal(ownerChangeProblem({ actorIsOwner: true, targetIsOwner: true, targetIsLastOwner: false, change: 'ROLE', newRole: UserRole.ADMIN }), null, 'one of several owners may be demoted by an owner');
  });

  it('the last owner is never demoted, suspended, offboarded or stripped of ownership', () => {
    for (const change of [
      { change: 'ROLE' as const, newRole: UserRole.ADMIN },
      { change: 'STATUS' as const, newStatus: 'SUSPENDED' },
      { change: 'STATUS' as const, newStatus: 'OFFBOARDED' },
      { change: 'REMOVE_OWNERSHIP' as const },
    ]) {
      const p = ownerChangeProblem({ actorIsOwner: true, targetIsOwner: true, targetIsLastOwner: true, ...change });
      assert.equal(p?.status, 409, JSON.stringify(change));
    }
    assert.equal(ownerChangeProblem({ actorIsOwner: true, targetIsOwner: true, targetIsLastOwner: true, change: 'ROLE', newRole: UserRole.SUPER_ADMIN }), null, 'keeping the owner role is fine');
    assert.equal(ownerChangeProblem({ actorIsOwner: true, targetIsOwner: true, targetIsLastOwner: true, change: 'STATUS', newStatus: 'ACTIVE' }), null);
  });
});
