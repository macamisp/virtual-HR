import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { RateLimit } from '../common/rate-limit.ts';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/auth/types.ts';
import { NotificationListQuerySchema, NotificationPreferencesDtoSchema, UnsubscribeDtoSchema } from '../../../../packages/shared/src/notifications/types.ts';
import type { NotificationListQuery, NotificationPreferencesDto, UnsubscribeDto } from '../../../../packages/shared/src/notifications/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { NotificationsService } from './notifications.service.ts';
import { NotificationPreferencesService } from './notification-preferences.service.ts';
import { Public } from '../common/decorators/public.decorator.ts';

/** FR-NOTIF-001: the caller's own notifications only. */
@Controller('notifications')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.NOTIFICATIONS_READ_OWN)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly prefs: NotificationPreferencesService,
  ) {}

  /** FR-NOTIF-004. Declared before :id routes. */
  @Get('preferences')
  preferences(@CurrentUser() user: AuthenticatedUser) {
    return this.prefs.get(user);
  }

  @Put('preferences')
  updatePreferences(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(NotificationPreferencesDtoSchema)) dto: NotificationPreferencesDto) {
    return this.prefs.update(user, dto);
  }

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

/** FR-NOTIF-002: one-click unsubscribe from an email; no login, so it is rate-limited. */
@Controller('notifications')
@UseGuards(ThrottlerGuard)
export class PublicUnsubscribeController {
  constructor(private readonly preferences: NotificationPreferencesService) {}

  @Public()
  @Post('unsubscribe')
  @HttpCode(HttpStatus.OK)
  @RateLimit('unsubscribe')
  unsubscribe(@Body(new ZodValidationPipe(UnsubscribeDtoSchema)) dto: UnsubscribeDto) {
    return this.preferences.unsubscribe(dto.token);
  }
}
