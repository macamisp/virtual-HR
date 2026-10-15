import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator.ts';
import { hasPermission } from '../../../../../packages/shared/src/index.ts';
import type { Permission, AuthenticatedUser } from '../../../../../packages/shared/src/index.ts';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;

    if (!user) {
      throw new ForbiddenException('User context missing');
    }

    const hasAll = requiredPermissions.every((perm) =>
      hasPermission(user.role, perm),
    );

    if (!hasAll) {
      throw new ForbiddenException(
        `Insufficient permissions: required [${requiredPermissions.join(', ')}]`,
      );
    }

    return true;
  }
}
