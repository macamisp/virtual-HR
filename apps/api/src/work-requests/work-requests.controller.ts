/**
 * ADR 049 §2 and §7 routes. Requesting needs timesheets.use; deciding needs a team or organisation
 * timesheet approval permission (the service checks the requester is in scope and is not the caller).
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequireAnyPermission, RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ReqContext } from '../common/decorators/request-context.decorator.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import {
  CancelRequestDtoSchema,
  OnsiteDecisionDtoSchema,
  OnsiteRequestDtoSchema,
  OvertimeDecisionDtoSchema,
  OvertimeRequestDtoSchema,
  Permission,
  RequestListQuerySchema,
} from '../../../../packages/shared/src/index.ts';
import type {
  AuthenticatedUser,
  CancelRequestDto,
  OnsiteDecisionDto,
  OnsiteRequestDto,
  OvertimeDecisionDto,
  OvertimeRequestDto,
  RequestListQuery,
} from '../../../../packages/shared/src/index.ts';
import { WorkRequestsService } from './work-requests.service.ts';

const id = new ParseUUIDPipe({ version: '4' });

@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class WorkRequestsController {
  constructor(private readonly requests: WorkRequestsService) {}

  // ---------------------------------------------------------------- overtime (FR-WT-007..012)

  @Get('overtime-requests')
  @RequireAnyPermission(Permission.TIMESHEETS_USE, Permission.TIMESHEETS_APPROVE_TEAM, Permission.TIMESHEETS_APPROVE_ALL)
  listOvertime(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(RequestListQuerySchema)) q: RequestListQuery) {
    return this.requests.listOvertime(user, q);
  }

  @Post('overtime-requests')
  @RequirePermissions(Permission.TIMESHEETS_USE)
  requestOvertime(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(OvertimeRequestDtoSchema)) dto: OvertimeRequestDto, @ReqContext() ctx: RequestContext) {
    return this.requests.requestOvertime(user, dto, ctx);
  }

  @Get('overtime-requests/:id')
  @RequireAnyPermission(Permission.TIMESHEETS_USE, Permission.TIMESHEETS_APPROVE_TEAM, Permission.TIMESHEETS_APPROVE_ALL)
  getOvertime(@CurrentUser() user: AuthenticatedUser, @Param('id', id) reqId: string) {
    return this.requests.getOvertime(user, reqId);
  }

  @Post('overtime-requests/:id/decide')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(Permission.TIMESHEETS_APPROVE_TEAM, Permission.TIMESHEETS_APPROVE_ALL)
  decideOvertime(@CurrentUser() user: AuthenticatedUser, @Param('id', id) reqId: string, @Body(new ZodValidationPipe(OvertimeDecisionDtoSchema)) dto: OvertimeDecisionDto, @ReqContext() ctx: RequestContext) {
    return this.requests.decideOvertime(user, reqId, dto, ctx);
  }

  @Post('overtime-requests/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(Permission.TIMESHEETS_USE, Permission.TIMESHEETS_APPROVE_ALL)
  cancelOvertime(@CurrentUser() user: AuthenticatedUser, @Param('id', id) reqId: string, @Body(new ZodValidationPipe(CancelRequestDtoSchema)) dto: CancelRequestDto, @ReqContext() ctx: RequestContext) {
    return this.requests.cancelOvertime(user, reqId, dto, ctx);
  }

  // ---------------------------------------------------------------- onsite work (FR-WT-023..024)

  @Get('onsite-requests')
  @RequireAnyPermission(Permission.TIMESHEETS_USE, Permission.TIMESHEETS_APPROVE_TEAM, Permission.TIMESHEETS_APPROVE_ALL)
  listOnsite(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(RequestListQuerySchema)) q: RequestListQuery) {
    return this.requests.listOnsite(user, q);
  }

  @Post('onsite-requests')
  @RequirePermissions(Permission.TIMESHEETS_USE)
  requestOnsite(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(OnsiteRequestDtoSchema)) dto: OnsiteRequestDto, @ReqContext() ctx: RequestContext) {
    return this.requests.requestOnsite(user, dto, ctx);
  }

  @Get('onsite-requests/:id')
  @RequireAnyPermission(Permission.TIMESHEETS_USE, Permission.TIMESHEETS_APPROVE_TEAM, Permission.TIMESHEETS_APPROVE_ALL)
  getOnsite(@CurrentUser() user: AuthenticatedUser, @Param('id', id) reqId: string) {
    return this.requests.getOnsite(user, reqId);
  }

  @Post('onsite-requests/:id/decide')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(Permission.TIMESHEETS_APPROVE_TEAM, Permission.TIMESHEETS_APPROVE_ALL)
  decideOnsite(@CurrentUser() user: AuthenticatedUser, @Param('id', id) reqId: string, @Body(new ZodValidationPipe(OnsiteDecisionDtoSchema)) dto: OnsiteDecisionDto, @ReqContext() ctx: RequestContext) {
    return this.requests.decideOnsite(user, reqId, dto, ctx);
  }

  @Post('onsite-requests/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.TIMESHEETS_USE)
  cancelOnsite(@CurrentUser() user: AuthenticatedUser, @Param('id', id) reqId: string, @ReqContext() ctx: RequestContext) {
    return this.requests.cancelOnsite(user, reqId, ctx);
  }
}
