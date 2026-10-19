/** FR-ORG-005 routes (ADR 032): the work schedule editor, for schedules.manage (HR, admins). */
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ReqContext } from '../common/decorators/request-context.decorator.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/auth/types.ts';
import { ScheduleDtoSchema, ScheduleEndDtoSchema } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser, ScheduleDto, ScheduleEndDto } from '../../../../packages/shared/src/index.ts';
import { SchedulesService } from './schedules.service.ts';

@Controller('schedules')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  @RequirePermissions(Permission.SCHEDULES_MANAGE)
  overview(@CurrentUser() user: AuthenticatedUser) {
    return this.schedules.overview(user);
  }

  @Put()
  @RequirePermissions(Permission.SCHEDULES_MANAGE)
  set(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(ScheduleDtoSchema)) dto: ScheduleDto, @ReqContext() ctx: RequestContext) {
    return this.schedules.set(user, dto, ctx);
  }

  @Post('end')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.SCHEDULES_MANAGE)
  end(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(ScheduleEndDtoSchema)) dto: ScheduleEndDto, @ReqContext() ctx: RequestContext) {
    return this.schedules.end(user, dto, ctx);
  }
}
