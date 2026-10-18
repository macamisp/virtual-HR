/**
 * FR-ORG-006 routes (ADR 031): teams and the manager hierarchy, managed by HR and admins
 * (users.manage). The organisation chart is built from the same structure.
 */
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ReqContext } from '../common/decorators/request-context.decorator.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/auth/types.ts';
import { PlacementDtoSchema, TeamDtoSchema, TeamUpdateDtoSchema } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser, PlacementDto, TeamDto, TeamUpdateDto } from '../../../../packages/shared/src/index.ts';
import { OrgService } from './org.service.ts';

const id = new ParseUUIDPipe({ version: '4' });

@Controller('org')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OrgController {
  constructor(private readonly org: OrgService) {}

  @Get('structure')
  @RequirePermissions(Permission.USERS_MANAGE)
  structure(@CurrentUser() user: AuthenticatedUser) {
    return this.org.structure(user);
  }

  @Post('teams')
  @RequirePermissions(Permission.USERS_MANAGE)
  createTeam(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(TeamDtoSchema)) dto: TeamDto, @ReqContext() ctx: RequestContext) {
    return this.org.createTeam(user, dto, ctx);
  }

  @Patch('teams/:id')
  @RequirePermissions(Permission.USERS_MANAGE)
  updateTeam(@CurrentUser() user: AuthenticatedUser, @Param('id', id) teamId: string, @Body(new ZodValidationPipe(TeamUpdateDtoSchema)) dto: TeamUpdateDto, @ReqContext() ctx: RequestContext) {
    return this.org.updateTeam(user, teamId, dto, ctx);
  }

  @Delete('teams/:id')
  @RequirePermissions(Permission.USERS_MANAGE)
  deleteTeam(@CurrentUser() user: AuthenticatedUser, @Param('id', id) teamId: string, @ReqContext() ctx: RequestContext) {
    return this.org.deleteTeam(user, teamId, ctx);
  }

  @Put('people/:id/placement')
  @RequirePermissions(Permission.USERS_MANAGE)
  setPlacement(@CurrentUser() user: AuthenticatedUser, @Param('id', id) personId: string, @Body(new ZodValidationPipe(PlacementDtoSchema)) dto: PlacementDto, @ReqContext() ctx: RequestContext) {
    return this.org.setPlacement(user, personId, dto, ctx);
  }
}
