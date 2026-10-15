import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/auth/types.ts';
import {
  ManualEntryDtoSchema,
  TimeEntryListQuerySchema,
  UpdateEntryDtoSchema,
} from '../../../../packages/shared/src/timesheets/types.ts';
import type { ManualEntryDto, TimeEntryListQuery, UpdateEntryDto } from '../../../../packages/shared/src/timesheets/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { TimeEntriesService } from './time-entries.service.ts';

const id = new ParseUUIDPipe({ version: '4' });

/** FR-TS-003 task timers and FR-TS-004 manual time (SRS 8.x endpoint list). */
@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.TIMESHEETS_USE)
export class TimeEntriesController {
  constructor(private readonly time: TimeEntriesService) {}

  @Get('timer')
  timer(@CurrentUser() user: AuthenticatedUser) {
    return this.time.timerState(user);
  }

  @Post('tasks/:id/timer/start')
  @HttpCode(HttpStatus.OK)
  start(@CurrentUser() user: AuthenticatedUser, @Param('id', id) taskId: string) {
    return this.time.startTimer(user, taskId);
  }

  @Post('tasks/:id/timer/stop')
  @HttpCode(HttpStatus.OK)
  stopOnTask(@CurrentUser() user: AuthenticatedUser, @Param('id', id) taskId: string) {
    return this.time.stopTimer(user, taskId);
  }

  @Post('timer/stop')
  @HttpCode(HttpStatus.OK)
  stop(@CurrentUser() user: AuthenticatedUser) {
    return this.time.stopTimer(user);
  }

  @Get('time-entries')
  list(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(TimeEntryListQuerySchema)) q: TimeEntryListQuery) {
    return this.time.list(user, q);
  }

  @Post('time-entries')
  create(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(ManualEntryDtoSchema)) dto: ManualEntryDto) {
    return this.time.addManual(user, dto);
  }

  @Patch('time-entries/:id')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id', id) entryId: string, @Body(new ZodValidationPipe(UpdateEntryDtoSchema)) dto: UpdateEntryDto) {
    return this.time.update(user, entryId, dto);
  }

  @Delete('time-entries/:id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id', id) entryId: string) {
    return this.time.remove(user, entryId);
  }
}
