import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/auth/types.ts';
import {
  ConfirmPlanDtoSchema,
  EodReportDtoSchema,
  SavedViewDtoSchema,
  WeeklyPlanDtoSchema,
} from '../../../../packages/shared/src/tasks/planning.ts';
import type { ConfirmPlanDto, EodReportDto, SavedViewDto, WeeklyPlanDto } from '../../../../packages/shared/src/tasks/planning.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { PlanningService } from './planning.service.ts';

const dateParam = new ZodValidationPipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'));
const optionalDate = new ZodValidationPipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional());

/** FR-TASK-003 (Today, daily plan, EOD report), FR-TASK-004 (weekly planner), FR-TASK-005 (workload, saved views). */
@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.TASKS_USE)
export class PlanningController {
  constructor(private readonly planning: PlanningService) {}

  @Get('planning/today')
  today(@CurrentUser() user: AuthenticatedUser, @Query('date', optionalDate) date?: string) {
    return this.planning.today(user, date);
  }

  @Post('planning/daily/:date/confirm')
  confirm(@CurrentUser() user: AuthenticatedUser, @Param('date', dateParam) date: string, @Body(new ZodValidationPipe(ConfirmPlanDtoSchema)) dto: ConfirmPlanDto) {
    return this.planning.confirmPlan(user, date, dto);
  }

  @Post('planning/daily/:date/report')
  report(@CurrentUser() user: AuthenticatedUser, @Param('date', dateParam) date: string, @Body(new ZodValidationPipe(EodReportDtoSchema)) dto: EodReportDto) {
    return this.planning.submitReport(user, date, dto);
  }

  @Get('planning/week')
  week(@CurrentUser() user: AuthenticatedUser, @Query('start', optionalDate) start?: string) {
    return this.planning.week(user, start);
  }

  @Put('planning/week/:start')
  saveWeek(@CurrentUser() user: AuthenticatedUser, @Param('start', dateParam) start: string, @Body(new ZodValidationPipe(WeeklyPlanDtoSchema)) dto: WeeklyPlanDto) {
    return this.planning.saveWeek(user, start, dto);
  }

  @Get('planning/workload')
  @RequirePermissions(Permission.TASKS_USE, Permission.TASKS_READ_TEAM)
  workload(
    @CurrentUser() user: AuthenticatedUser,
    @Query('start', optionalDate) start?: string,
    @Query('teamId', new ParseUUIDPipe({ version: '4', optional: true })) teamId?: string,
  ) {
    return this.planning.workload(user, start, teamId);
  }

  @Get('task-views')
  views(@CurrentUser() user: AuthenticatedUser) {
    return this.planning.views(user);
  }

  @Post('task-views')
  saveView(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(SavedViewDtoSchema)) dto: SavedViewDto) {
    return this.planning.saveView(user, dto);
  }

  @Delete('task-views/:id')
  deleteView(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.planning.deleteView(user, id);
  }
}
