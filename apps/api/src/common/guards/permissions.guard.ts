import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_ANY_KEY, PERMISSIONS_KEY } from '../decorators/permissions.decorator.ts';
import { userCan } from '../../../../../packages/shared/src/index.ts';
import type { Permission, AuthenticatedUser } from '../../../../../packages/shared/src/index.ts';
import { PermissionResolver } from '../permission-resolver.ts';

/**
 * Route permissions (every route has one). Before checking, the signed-in user's effective
 * permissions, role and team are resolved from the database (FR-ADM-002), so services that call
 * userCan(user, …) see the same answer as the route check.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private resolver: PermissionResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;

    if (user && user.tokenType !== 'mfa_enroll') {
      const access = await this.resolver.resolve(user);
      user.role = access.role;
      user.teamId = access.teamId;
      user.permissions = access.permissions;
      user.customRoleId = access.customRoleId;
    }

    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    const anyPermissions = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_ANY_KEY,
      [context.getHandler(), context.getClass()],
    );

    if ((!requiredPermissions || requiredPermissions.length === 0) && (!anyPermissions || anyPermissions.length === 0)) {
      return true;
    }

    if (!user) {
      throw new ForbiddenException('User context missing');
    }

    const hasAll = (requiredPermissions ?? []).every((perm) => userCan(user, perm));
    if (!hasAll) {
      throw new ForbiddenException(
        `Insufficient permissions: required [${(requiredPermissions ?? []).join(', ')}]`,
      );
    }

    if (anyPermissions && anyPermissions.length > 0 && !anyPermissions.some((perm) => userCan(user, perm))) {
      throw new ForbiddenException(
        `Insufficient permissions: required one of [${anyPermissions.join(', ')}]`,
      );
    }

    return true;
  }
}
