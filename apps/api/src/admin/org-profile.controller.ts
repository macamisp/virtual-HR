/**
 * Workspace profile and ownership routes (ADR 037). Lives in the admin module next to roles and
 * users; /org/teams and the hierarchy are in apps/api/src/org.
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { SelfService } from '../common/decorators/self-service.decorator.ts';
import { ReqContext } from '../common/decorators/request-context.decorator.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/auth/types.ts';
import { OrgProfileUpdateDtoSchema, OwnerRemoveDtoSchema, OwnershipTransferDtoSchema } from '../../../../packages/shared/src/auth/workspace.ts';
import type { OrgProfileUpdateDto, OwnershipTransferDto } from '../../../../packages/shared/src/auth/workspace.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { OwnershipService } from './ownership.service.ts';

const id = new ParseUUIDPipe({ version: '4' });

@Controller('org')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OrgProfileController {
  constructor(private readonly ownership: OwnershipService) {}

  @Get('profile')
  @RequirePermissions(Permission.ORG_MANAGE)
  profile(@CurrentUser() user: AuthenticatedUser) {
    return this.ownership.profile(user);
  }

  @Put('profile')
  @RequirePermissions(Permission.ORG_MANAGE)
  updateProfile(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(OrgProfileUpdateDtoSchema)) dto: OrgProfileUpdateDto, @ReqContext() ctx: RequestContext) {
    return this.ownership.updateProfile(user, dto, ctx);
  }

  @Post('ownership/transfers')
  @RequirePermissions(Permission.ORG_OWNER)
  @HttpCode(HttpStatus.CREATED)
  createTransfer(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(OwnershipTransferDtoSchema)) dto: OwnershipTransferDto, @ReqContext() ctx: RequestContext) {
    return this.ownership.createTransfer(user, dto, ctx);
  }

  /** Owners: every transfer. Others: the ones addressed to them (to accept) or started by them. */
  @SelfService()
  @Get('ownership/transfers')
  listTransfers(@CurrentUser() user: AuthenticatedUser) {
    return this.ownership.listTransfers(user);
  }

  @SelfService()
  @Post('ownership/transfers/:id/accept')
  @HttpCode(HttpStatus.OK)
  acceptTransfer(@CurrentUser() user: AuthenticatedUser, @Param('id', id) transferId: string, @ReqContext() ctx: RequestContext) {
    return this.ownership.acceptTransfer(user, transferId, ctx);
  }

  @SelfService()
  @Post('ownership/transfers/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancelTransfer(@CurrentUser() user: AuthenticatedUser, @Param('id', id) transferId: string, @ReqContext() ctx: RequestContext) {
    return this.ownership.cancelTransfer(user, transferId, ctx);
  }

  @Post('owners/:id/remove')
  @RequirePermissions(Permission.ORG_OWNER)
  @HttpCode(HttpStatus.OK)
  removeOwner(@CurrentUser() user: AuthenticatedUser, @Param('id', id) userId: string, @Body(new ZodValidationPipe(OwnerRemoveDtoSchema)) dto: { password?: string; totpCode?: string }, @ReqContext() ctx: RequestContext) {
    return this.ownership.removeOwner(user, userId, dto, ctx);
  }
}
