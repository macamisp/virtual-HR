import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/auth/types.ts';
import { ProjectDtoSchema, ProjectMemberDtoSchema, ProjectUpdateDtoSchema } from '../../../../packages/shared/src/tasks/types.ts';
import type { ProjectDto, ProjectUpdateDto } from '../../../../packages/shared/src/tasks/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { ProjectsService } from './projects.service.ts';

const id = new ParseUUIDPipe({ version: '4' });

/** Minimal project administration (SRS 7.4 projects / project_members). */
@Controller('projects')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.TASKS_USE)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.projects.list(user);
  }

  @Get('candidates')
  @RequirePermissions(Permission.TASKS_USE, Permission.PROJECTS_MANAGE)
  candidates(@CurrentUser() user: AuthenticatedUser) {
    return this.projects.candidates(user);
  }

  @Post()
  @RequirePermissions(Permission.TASKS_USE, Permission.PROJECTS_MANAGE)
  create(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(ProjectDtoSchema)) dto: ProjectDto) {
    return this.projects.create(user, dto);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id', id) projectId: string, @Body(new ZodValidationPipe(ProjectUpdateDtoSchema)) dto: ProjectUpdateDto) {
    return this.projects.update(user, projectId, dto);
  }

  @Get(':id/members')
  members(@CurrentUser() user: AuthenticatedUser, @Param('id', id) projectId: string) {
    return this.projects.members(user, projectId);
  }

  @Post(':id/members')
  addMember(@CurrentUser() user: AuthenticatedUser, @Param('id', id) projectId: string, @Body(new ZodValidationPipe(ProjectMemberDtoSchema)) dto: { userId: string }) {
    return this.projects.addMember(user, projectId, dto.userId);
  }

  @Delete(':id/members/:userId')
  removeMember(@CurrentUser() user: AuthenticatedUser, @Param('id', id) projectId: string, @Param('userId', id) userId: string) {
    return this.projects.removeMember(user, projectId, userId);
  }
}
