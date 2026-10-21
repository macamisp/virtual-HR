import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service.ts';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { Permission } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { SelfService } from '../common/decorators/self-service.decorator.ts';

@Controller('users')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @SelfService()
  @Get('me')
  async getMe(@CurrentUser() user: AuthenticatedUser) {
    return await this.usersService.getProfile(user.id, user.orgId);
  }

  @Get()
  @RequirePermissions(Permission.USERS_MANAGE)
  async listUsers(
    @CurrentUser() user: AuthenticatedUser,
    @Query('teamId') teamId?: string,
  ) {
    return await this.usersService.findAll(user.orgId, teamId);
  }
}
