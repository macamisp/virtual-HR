import { SetMetadata } from '@nestjs/common';
import type { Permission } from '../../../../../packages/shared/src/index.ts';

export const PERMISSIONS_KEY = 'permissions';
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Passes when the user holds at least one of the permissions (checked after RequirePermissions). */
export const PERMISSIONS_ANY_KEY = 'permissions_any';
export const RequireAnyPermission = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_ANY_KEY, permissions);
