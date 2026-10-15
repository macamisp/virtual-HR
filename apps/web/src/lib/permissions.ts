'use client';

import { hasPermission, Permission } from '@hrvo/shared';
import { useAuthStore } from './auth-store';
import { useMyAccess } from './admin-queries';

export { Permission };

/**
 * UI-only convenience; the API enforces every permission independently. Uses the effective
 * permissions the API resolved (custom roles, FR-ADM-002), falling back to the role's
 * defaults until they have loaded.
 */
export function useCan(permission: (typeof Permission)[keyof typeof Permission]): boolean {
  const role = useAuthStore((s) => s.user?.role);
  const access = useMyAccess();
  if (access.data) return access.data.permissions.includes(permission);
  return !!role && hasPermission(role, permission);
}
