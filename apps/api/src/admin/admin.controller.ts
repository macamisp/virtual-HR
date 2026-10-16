import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequireAnyPermission, RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ReqContext } from '../common/decorators/request-context.decorator.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import {
  AssignRoleDtoSchema,
  ConsentDtoSchema,
  CustomRoleDtoSchema,
  AttendanceGuardsSchema,
  OrgPolicySchema,
  RetentionSettingsSchema,
} from '../../../../packages/shared/src/admin/types.ts';
import type { AssignRoleDto, AttendanceGuards, ConsentDto, CustomRoleDto, OrgPolicy, RetentionSettings } from '../../../../packages/shared/src/admin/types.ts';
import { AdminService } from './admin.service.ts';
import { ConsentsService } from './consents.service.ts';

const id = new ParseUUIDPipe({ version: '4' });

/** FR-ADM-001, 002, 004 and FR-AUD-004 (ADR 011). */
@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly consents: ConsentsService,
  ) {}

  @Get('admin/policy')
  @RequirePermissions(Permission.ORG_MANAGE)
  policy(@CurrentUser() user: AuthenticatedUser) {
    return this.admin.policy(user);
  }

  @Put('admin/policy')
  @RequirePermissions(Permission.ORG_MANAGE)
  updatePolicy(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(OrgPolicySchema)) dto: OrgPolicy) {
    return this.admin.updatePolicy(user, dto);
  }

  @Get('admin/attendance-guards')
  @RequirePermissions(Permission.ORG_MANAGE)
  guards(@CurrentUser() user: AuthenticatedUser) {
    return this.admin.guards(user);
  }

  @Put('admin/attendance-guards')
  @RequirePermissions(Permission.ORG_MANAGE)
  updateGuards(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(AttendanceGuardsSchema)) dto: AttendanceGuards) {
    return this.admin.updateGuards(user, dto);
  }

  @Get('admin/retention')
  @RequirePermissions(Permission.ORG_MANAGE)
  retention(@CurrentUser() user: AuthenticatedUser) {
    return this.admin.retention(user);
  }

  @Put('admin/retention')
  @RequirePermissions(Permission.ORG_MANAGE)
  updateRetention(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(RetentionSettingsSchema)) dto: RetentionSettings) {
    return this.admin.updateRetention(user, dto);
  }

  @Get('admin/roles')
  @RequirePermissions(Permission.ROLES_MANAGE)
  roles(@CurrentUser() user: AuthenticatedUser) {
    return this.admin.roles(user);
  }

  @Post('admin/roles')
  @RequirePermissions(Permission.ROLES_MANAGE)
  createRole(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(CustomRoleDtoSchema)) dto: CustomRoleDto) {
    return this.admin.createRole(user, dto);
  }

  @Put('admin/roles/:id')
  @RequirePermissions(Permission.ROLES_MANAGE)
  updateRole(@CurrentUser() user: AuthenticatedUser, @Param('id', id) roleId: string, @Body(new ZodValidationPipe(CustomRoleDtoSchema)) dto: CustomRoleDto) {
    return this.admin.updateRole(user, roleId, dto);
  }

  @Delete('admin/roles/:id')
  @RequirePermissions(Permission.ROLES_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRole(@CurrentUser() user: AuthenticatedUser, @Param('id', id) roleId: string) {
    await this.admin.deleteRole(user, roleId);
  }

  @Get('admin/users')
  @RequirePermissions(Permission.ROLES_MANAGE)
  users(@CurrentUser() user: AuthenticatedUser) {
    return this.admin.users(user);
  }

  @Put('admin/users/:id/role')
  @RequirePermissions(Permission.ROLES_MANAGE)
  assignRole(@CurrentUser() user: AuthenticatedUser, @Param('id', id) userId: string, @Body(new ZodValidationPipe(AssignRoleDtoSchema)) dto: AssignRoleDto) {
    return this.admin.assignRole(user, userId, dto);
  }

  /** Any signed-in user: their own effective permissions, for the UI. */
  @Get('me/access')
  myAccess(@CurrentUser() user: AuthenticatedUser) {
    return this.admin.myAccess(user);
  }

  @Get('me/consents')
  myConsents(@CurrentUser() user: AuthenticatedUser) {
    return this.consents.overview(user.orgId, user.id);
  }

  @Post('me/consents')
  recordConsent(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(ConsentDtoSchema)) dto: ConsentDto, @ReqContext() ctx: RequestContext) {
    return this.consents.record(user, dto, ctx);
  }

  @Get('admin/users/:id/consents')
  @RequireAnyPermission(Permission.AUDIT_READ, Permission.USERS_MANAGE)
  userConsents(@CurrentUser() user: AuthenticatedUser, @Param('id', id) userId: string) {
    return this.consents.overview(user.orgId, userId);
  }
}
