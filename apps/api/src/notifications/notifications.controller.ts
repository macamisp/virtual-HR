import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/auth/types.ts';
import { NotificationListQuerySchema } from '../../../../packages/shared/src/notifications/types.ts';
import type { NotificationListQuery } from '../../../../packages/shared/src/notifications/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { NotificationsService } from './notifications.service.ts';

/** FR-NOTIF-001: the caller's own notifications only. */
@Controller('notifications')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.NOTIFICATIONS_READ_OWN)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(NotificationListQuerySchema)) q: NotificationListQuery) {
    return this.notifications.list(user, q);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  readAll(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markAllRead(user);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  read(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.notifications.markRead(user, id);
  }
}
