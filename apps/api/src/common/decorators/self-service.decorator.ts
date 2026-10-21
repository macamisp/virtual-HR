import { SetMetadata } from '@nestjs/common';

/**
 * Marks a signed-in route that needs no permission because it only acts on the caller's own data
 * (/me, own consent, own 2FA, logout). Every route must carry a permission decorator, @Public()
 * or this one; the route audit test (route-guards.test.ts) and PermissionsGuard enforce it.
 */
export const SELF_SERVICE_KEY = 'selfService';
export const SelfService = () => SetMetadata(SELF_SERVICE_KEY, true);
