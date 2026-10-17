/**
 * FR-ORG-010 / FR-ORG-011 routes (ADR 027). Requesting needs leave.use; deciding needs a team or
 * organisation approval permission (the service checks the requester is in scope); the holiday
 * calendar is readable by anyone signed in and edited with holidays.manage.
 */
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequireAnyPermission, RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ReqContext } from '../common/decorators/request-context.decorator.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/auth/types.ts';
import { HolidayDefaultsDtoSchema, HolidayDtoSchema, HolidayYearSchema, LeaveDecisionDtoSchema, LeaveListQuerySchema, LeaveRequestDtoSchema } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser, HolidayDto, LeaveDecisionDto, LeaveListQuery, LeaveRequestDto } from '../../../../packages/shared/src/index.ts';
import { LeaveService } from './leave.service.ts';

const id = new ParseUUIDPipe({ version: '4' });

@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  @Get('leave/requests')
  @RequirePermissions(Permission.LEAVE_USE)
  list(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(LeaveListQuerySchema)) q: LeaveListQuery) {
    return this.leave.list(user, q);
  }

  @Post('leave/requests')
  @RequirePermissions(Permission.LEAVE_USE)
  create(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(LeaveRequestDtoSchema)) dto: LeaveRequestDto, @ReqContext() ctx: RequestContext) {
    return this.leave.create(user, dto, ctx);
  }

  @Get('leave/requests/:id')
  @RequirePermissions(Permission.LEAVE_USE)
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', id) reqId: string) {
    return this.leave.get(user, reqId);
  }

  @Post('leave/requests/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.LEAVE_USE)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', id) reqId: string, @ReqContext() ctx: RequestContext) {
    return this.leave.cancel(user, reqId, ctx);
  }

  @Post('leave/requests/:id/decide')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(Permission.LEAVE_APPROVE_TEAM, Permission.LEAVE_APPROVE_ALL)
  decide(@CurrentUser() user: AuthenticatedUser, @Param('id', id) reqId: string, @Body(new ZodValidationPipe(LeaveDecisionDtoSchema)) dto: LeaveDecisionDto, @ReqContext() ctx: RequestContext) {
    return this.leave.decide(user, reqId, dto, ctx);
  }

  /** The calendar is public inside the organisation: anyone who takes leave or reads attendance. */
  @Get('holidays')
  @RequireAnyPermission(Permission.LEAVE_USE, Permission.ATTENDANCE_READ_ALL)
  holidays(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(HolidayYearSchema)) q: { year: number }) {
    return this.leave.holidays(user, q.year);
  }

  @Post('holidays')
  @RequirePermissions(Permission.HOLIDAYS_MANAGE)
  addHoliday(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(HolidayDtoSchema)) dto: HolidayDto, @ReqContext() ctx: RequestContext) {
    return this.leave.addHoliday(user, dto, ctx);
  }

  @Post('holidays/defaults')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.HOLIDAYS_MANAGE)
  loadDefaults(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(HolidayDefaultsDtoSchema)) dto: { year: number }, @ReqContext() ctx: RequestContext) {
    return this.leave.loadDefaults(user, dto.year, ctx);
  }

  @Delete('holidays/:id')
  @RequirePermissions(Permission.HOLIDAYS_MANAGE)
  removeHoliday(@CurrentUser() user: AuthenticatedUser, @Param('id', id) holidayId: string, @ReqContext() ctx: RequestContext) {
    return this.leave.removeHoliday(user, holidayId, ctx);
  }
}
