/**
 * FR-ORG-002 routes (ADR 033). /me/subcontractor-profile acts only on the caller; the
 * /subcontractors routes need subcontractors.read, .manage or .sensitive.read. Responses that
 * can carry personal or sensitive data are marked no-store.
 */
import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ReqContext } from '../common/decorators/request-context.decorator.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/auth/types.ts';
import { SubcontractorProfileDtoSchema } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser, SubcontractorProfileDto } from '../../../../packages/shared/src/index.ts';
import { SubcontractorsService } from './subcontractors.service.ts';

const id = new ParseUUIDPipe({ version: '4' });
const dto = new ZodValidationPipe(SubcontractorProfileDtoSchema);

@Controller('me')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MySubcontractorProfileController {
  constructor(private readonly subcontractors: SubcontractorsService) {}

  @Get('subcontractor-profile')
  @Header('Cache-Control', 'no-store')
  mine(@CurrentUser() user: AuthenticatedUser, @ReqContext() ctx: RequestContext) {
    return this.subcontractors.profile(user, user.id, ctx);
  }

  @Put('subcontractor-profile')
  @Header('Cache-Control', 'no-store')
  updateMine(@CurrentUser() user: AuthenticatedUser, @Body(dto) body: SubcontractorProfileDto, @ReqContext() ctx: RequestContext) {
    return this.subcontractors.update(user, user.id, body, ctx);
  }

  @Post('subcontractor-profile/reveal')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  revealMine(@CurrentUser() user: AuthenticatedUser, @ReqContext() ctx: RequestContext) {
    return this.subcontractors.reveal(user, user.id, ctx);
  }
}

@Controller('subcontractors')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SubcontractorsController {
  constructor(private readonly subcontractors: SubcontractorsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(Permission.SUBCONTRACTORS_READ)
  list(@CurrentUser() user: AuthenticatedUser, @ReqContext() ctx: RequestContext) {
    return this.subcontractors.list(user, ctx);
  }

  @Get(':id/profile')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(Permission.SUBCONTRACTORS_READ)
  profile(@CurrentUser() user: AuthenticatedUser, @Param('id', id) userId: string, @ReqContext() ctx: RequestContext) {
    return this.subcontractors.profile(user, userId, ctx);
  }

  @Put(':id/profile')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(Permission.SUBCONTRACTORS_MANAGE)
  update(@CurrentUser() user: AuthenticatedUser, @Param('id', id) userId: string, @Body(dto) body: SubcontractorProfileDto, @ReqContext() ctx: RequestContext) {
    return this.subcontractors.update(user, userId, body, ctx);
  }

  @Post(':id/profile/reveal')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(Permission.SUBCONTRACTORS_SENSITIVE_READ)
  reveal(@CurrentUser() user: AuthenticatedUser, @Param('id', id) userId: string, @ReqContext() ctx: RequestContext) {
    return this.subcontractors.reveal(user, userId, ctx);
  }
}
