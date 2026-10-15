import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/auth/types.ts';
import {
  AttachmentDtoSchema,
  ChecklistItemDtoSchema,
  ChecklistUpdateDtoSchema,
  CommentDtoSchema,
  CreateTaskDtoSchema,
  DeclineTaskDtoSchema,
  TaskListQuerySchema,
  UpdateTaskDtoSchema,
} from '../../../../packages/shared/src/tasks/types.ts';
import type {
  AttachmentDto,
  CommentDto,
  CreateTaskDto,
  DeclineTaskDto,
  TaskListQuery,
  UpdateTaskDto,
} from '../../../../packages/shared/src/tasks/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { TasksService } from './tasks.service.ts';

const id = new ParseUUIDPipe({ version: '4' });

/** FR-TASK-001, 002, 005, 006, 007. Visibility and authority are enforced in TasksService. */
@Controller('tasks')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.TASKS_USE)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(TaskListQuerySchema)) q: TaskListQuery) {
    return this.tasks.list(user, q);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(CreateTaskDtoSchema)) dto: CreateTaskDto) {
    return this.tasks.create(user, dto);
  }

  @Get('assignable-users')
  assignable(@CurrentUser() user: AuthenticatedUser, @Query('projectId', new ParseUUIDPipe({ version: '4', optional: true })) projectId?: string) {
    return this.tasks.assignableUsers(user, projectId);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', id) taskId: string) {
    return this.tasks.get(user, taskId);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id', id) taskId: string, @Body(new ZodValidationPipe(UpdateTaskDtoSchema)) dto: UpdateTaskDto) {
    return this.tasks.update(user, taskId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id', id) taskId: string) {
    return this.tasks.remove(user, taskId);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  accept(@CurrentUser() user: AuthenticatedUser, @Param('id', id) taskId: string) {
    return this.tasks.accept(user, taskId);
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  decline(@CurrentUser() user: AuthenticatedUser, @Param('id', id) taskId: string, @Body(new ZodValidationPipe(DeclineTaskDtoSchema)) dto: DeclineTaskDto) {
    return this.tasks.decline(user, taskId, dto.reason);
  }

  @Get(':id/comments')
  comments(@CurrentUser() user: AuthenticatedUser, @Param('id', id) taskId: string) {
    return this.tasks.comments(user, taskId);
  }

  @Post(':id/comments')
  addComment(@CurrentUser() user: AuthenticatedUser, @Param('id', id) taskId: string, @Body(new ZodValidationPipe(CommentDtoSchema)) dto: CommentDto) {
    return this.tasks.addComment(user, taskId, dto.body);
  }

  @Get(':id/activity')
  activity(@CurrentUser() user: AuthenticatedUser, @Param('id', id) taskId: string) {
    return this.tasks.activity(user, taskId);
  }

  @Get(':id/mentionable')
  mentionable(@CurrentUser() user: AuthenticatedUser, @Param('id', id) taskId: string) {
    return this.tasks.mentionableUsers(user, taskId);
  }

  @Post(':id/checklist')
  addChecklist(@CurrentUser() user: AuthenticatedUser, @Param('id', id) taskId: string, @Body(new ZodValidationPipe(ChecklistItemDtoSchema)) dto: { text: string }) {
    return this.tasks.addChecklistItem(user, taskId, dto.text);
  }

  @Patch(':id/checklist/:itemId')
  updateChecklist(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id) taskId: string,
    @Param('itemId', id) itemId: string,
    @Body(new ZodValidationPipe(ChecklistUpdateDtoSchema)) dto: { text?: string; done?: boolean },
  ) {
    return this.tasks.updateChecklistItem(user, taskId, itemId, dto);
  }

  @Delete(':id/checklist/:itemId')
  removeChecklist(@CurrentUser() user: AuthenticatedUser, @Param('id', id) taskId: string, @Param('itemId', id) itemId: string) {
    return this.tasks.removeChecklistItem(user, taskId, itemId);
  }

  @Post(':id/attachments')
  addAttachment(@CurrentUser() user: AuthenticatedUser, @Param('id', id) taskId: string, @Body(new ZodValidationPipe(AttachmentDtoSchema)) dto: AttachmentDto) {
    return this.tasks.addAttachment(user, taskId, dto);
  }

  @Delete(':id/attachments/:attachmentId')
  removeAttachment(@CurrentUser() user: AuthenticatedUser, @Param('id', id) taskId: string, @Param('attachmentId', id) attachmentId: string) {
    return this.tasks.removeAttachment(user, taskId, attachmentId);
  }
}
