'use client';

import { hasPermission, Permission } from '@hrvo/shared';
import { useAuthStore } from './auth-store';

export { Permission };

/** UI-only convenience; the API enforces every permission independently. */
export function useCan(permission: (typeof Permission)[keyof typeof Permission]): boolean {
  const role = useAuthStore((s) => s.user?.role);
  return !!role && hasPermission(role, permission);
}
