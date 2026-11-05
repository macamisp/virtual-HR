import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequireAnyPermission, RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { MyDaysQuerySchema, Permission } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser, MeetingIntervalList, MyDaysQuery } from '../../../../packages/shared/src/index.ts';
import { MeetingTimeService } from './meeting-time.service.ts';

/** ADR 049 §1g (FR-WT-005): meeting intervals (from, to: work dates, at most 62 days). */
@Controller('attendance')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MeetingTimeController {
  constructor(private readonly meetings: MeetingTimeService) {}

  @Get('me/meetings')
  @RequirePermissions(Permission.ATTENDANCE_READ_OWN)
  async mine(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(MyDaysQuerySchema)) q: MyDaysQuery): Promise<MeetingIntervalList> {
    return await this.meetings.mine(user, q.from, q.to);
  }

  @Get('users/:userId/meetings')
  @RequireAnyPermission(Permission.ATTENDANCE_READ_TEAM, Permission.ATTENDANCE_READ_ALL)
  async forUser(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Query(new ZodValidationPipe(MyDaysQuerySchema)) q: MyDaysQuery,
  ): Promise<MeetingIntervalList> {
    return await this.meetings.forUser(user, userId, q.from, q.to);
  }
}
