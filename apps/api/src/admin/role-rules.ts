/**
 * FR-ADM-002 rules for custom roles and role assignment (ADR 011). Pure, unit-tested.
 *
 *  - A custom role is a built-in base role (never SUPER_ADMIN) plus added and removed permissions.
 *  - Nobody grants what they do not hold: a role's effective permissions, and an assignment's
 *    before and after permissions, must be within the admin's own (SUPER_ADMIN excepted;
 *    an x.all permission covers x.team). So only a super admin appoints HR managers, who hold
 *    vault.recover.
 *  - 2FA-grade permissions (MFA_SENSITIVE_PERMISSIONS) only on a base role that requires 2FA,
 *    so login always asks for 2FA when they are held.
 *  - SUPER_ADMIN is given and taken only by a SUPER_ADMIN.
 *  - Owners (ADR 037): org.owner is never part of a role; an owner is changed only by an owner;
 *    the last owner is never demoted, suspended or removed.
 */
import {
  effectivePermissions,
  isMfaRequiredRole,
  MFA_SENSITIVE_PERMISSIONS,
  Permission,
  ROLE_PERMISSIONS,
  UserRole,
} from '../../../../packages/shared/src/auth/types.ts';

/** Holding the organisation-wide form of a permission covers the team form (x.all covers x.team). */
export function covers(held: readonly Permission[], p: Permission): boolean {
  return held.includes(p) || (p.endsWith('.team') && (held as readonly string[]).includes(`${p.slice(0, -'.team'.length)}.all`));
}

export function checkRoleDefinition(input: {
  baseRole: UserRole;
  added: readonly Permission[];
  removed: readonly Permission[];
  grantable: readonly Permission[];
  actorIsSuperAdmin: boolean;
}): { added: Permission[]; removed: Permission[] } | { error: string } {
  if (input.baseRole === UserRole.SUPER_ADMIN) return { error: 'A custom role cannot be based on Owner (super admin)' };
  if (input.added.includes(Permission.ORG_OWNER)) return { error: 'Workspace ownership cannot be granted through a role' };
  const base = ROLE_PERMISSIONS[input.baseRole] ?? [];
  // Keep only changes that change something; a permission cannot be both added and removed.
  const added = [...new Set(input.added)].filter((p) => !base.includes(p)).sort();
  const removed = [...new Set(input.removed)].filter((p) => base.includes(p)).sort();
  if (input.added.some((p) => input.removed.includes(p))) return { error: 'A permission cannot be both added and removed' };
  if (!isMfaRequiredRole(input.baseRole)) {
    const sensitive = added.filter((p) => MFA_SENSITIVE_PERMISSIONS.includes(p));
    if (sensitive.length > 0) return { error: `${sensitive.join(', ')} need a base role that requires two-factor authentication (Admin, HR manager or HR)` };
  }
  if (!input.actorIsSuperAdmin) {
    const effective = effectivePermissions(input.baseRole, added, removed);
    const missing = effective.filter((p) => !covers(input.grantable, p));
    if (missing.length > 0) return { error: `You cannot grant permissions you do not hold: ${missing.join(', ')}` };
  }
  return { added, removed };
}

/** Null when allowed, otherwise the reason. */
export function mayAssign(input: {
  actor: { id: string; role: UserRole; permissions: readonly Permission[] };
  currentRole: UserRole;
  currentPermissions: readonly Permission[];
  newRole: UserRole;
  newPermissions: readonly Permission[];
}): string | null {
  const superAdmin = input.actor.role === UserRole.SUPER_ADMIN;
  if ((input.newRole === UserRole.SUPER_ADMIN || input.currentRole === UserRole.SUPER_ADMIN) && !superAdmin) return 'Only a super admin can give or change the super admin role';
  if (superAdmin) return null;
  if (input.currentPermissions.some((p) => !covers(input.actor.permissions, p))) return 'This user has permissions you do not hold';
  if (input.newPermissions.some((p) => !covers(input.actor.permissions, p))) return 'You cannot grant permissions you do not hold';
  return null;
}

/**
 * Owner protection (ADR 037). Null when allowed, otherwise the reason and the status to answer
 * with: 403 when the actor may not, 409 when the workspace would be left without an owner.
 */
export function ownerChangeProblem(input: {
  actorIsOwner: boolean;
  targetIsOwner: boolean;
  /** True when the target is the only active owner. */
  targetIsLastOwner: boolean;
  /** What the change does to the target's ownership. */
  change: 'ROLE' | 'STATUS' | 'REMOVE_OWNERSHIP';
  newRole?: UserRole;
  newStatus?: string;
}): { status: 403 | 409; error: string } | null {
  if (!input.targetIsOwner) return null;
  if (!input.actorIsOwner) return { status: 403, error: 'Only an owner can change an owner' };
  const losesOwnership = input.change === 'REMOVE_OWNERSHIP'
    || (input.change === 'ROLE' && input.newRole !== UserRole.SUPER_ADMIN)
    || (input.change === 'STATUS' && input.newStatus !== 'ACTIVE');
  if (losesOwnership && input.targetIsLastOwner) return { status: 409, error: 'The last owner cannot be removed or demoted. Transfer ownership first.' };
  return null;
}
