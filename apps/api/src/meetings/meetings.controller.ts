import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import {
  ActionItemDtoSchema, LobbyDecisionDtoSchema, MeetingCreateDtoSchema, MeetingListQuerySchema, MeetingUpdateDtoSchema, RemoveParticipantDtoSchema,
} from '../../../../packages/shared/src/meetings/types.ts';
import type { ActionItemDto, MeetingCreateDto, MeetingUpdateDto } from '../../../../packages/shared/src/meetings/types.ts';
import { z } from 'zod';
import { CallsService } from './calls.service.ts';
import { ChatService } from '../chat/chat.service.ts';
import { MeetingsService } from './meetings.service.ts';

const id = new ParseUUIDPipe({ version: '4' });
type ListQuery = z.infer<typeof MeetingListQuerySchema>;

/** FR-MEET-001, 003, 005, 008, 009 (ADR 016). */
@Controller('meetings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.MEETINGS_USE)
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService, private readonly calls: CallsService, private readonly chat: ChatService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(MeetingListQuerySchema)) q: ListQuery) {
    return this.meetings.list(user, q.scope, q.limit);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(MeetingCreateDtoSchema)) dto: MeetingCreateDto) {
    return this.meetings.create(user, dto);
  }

  @Get('incoming')
  incoming(@CurrentUser() user: AuthenticatedUser) {
    return this.calls.incoming(user);
  }

  @Get(':id/calls')
  callsFor(@CurrentUser() user: AuthenticatedUser, @Param('id', id) meetingId: string) {
    return this.calls.list(user, meetingId);
  }

  /** FR-VO-008: the caller stops ringing the people who have not answered yet. */
  @Post(':id/calls/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelCalls(@CurrentUser() user: AuthenticatedUser, @Param('id', id) meetingId: string) {
    await this.calls.cancel(user, meetingId);
    return this.calls.list(user, meetingId);
  }

  @Post(':id/chat')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.MEETINGS_USE, Permission.CHAT_USE)
  meetingChat(@CurrentUser() user: AuthenticatedUser, @Param('id', id) meetingId: string) {
    return this.chat.meetingChannel(user, meetingId);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', id) meetingId: string) {
    return this.meetings.get(user, meetingId);
  }

  @Put(':id')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id', id) meetingId: string, @Body(new ZodValidationPipe(MeetingUpdateDtoSchema)) dto: MeetingUpdateDto) {
    return this.meetings.update(user, meetingId, dto);
  }

  @Delete(':id')
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', id) meetingId: string) {
    return this.meetings.cancel(user, meetingId);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  accept(@CurrentUser() user: AuthenticatedUser, @Param('id', id) meetingId: string) {
    return this.meetings.respond(user, meetingId, true);
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  decline(@CurrentUser() user: AuthenticatedUser, @Param('id', id) meetingId: string) {
    return this.meetings.respond(user, meetingId, false);
  }

  @Get(':id/invite.ics')
  @Header('Cache-Control', 'no-store')
  async ics(@CurrentUser() user: AuthenticatedUser, @Param('id', id) meetingId: string) {
    const body = Buffer.from(await this.meetings.ics(user, meetingId), 'utf8');
    return new StreamableFile(body, { type: 'text/calendar; charset=utf-8', disposition: 'attachment; filename="invite.ics"', length: body.length });
  }

  /** READY with a token, WAITING in the lobby, or DENIED. */
  @Post(':id/join')
  @HttpCode(HttpStatus.OK)
  join(@CurrentUser() user: AuthenticatedUser, @Param('id', id) meetingId: string) {
    return this.meetings.join(user, meetingId);
  }

  @Get(':id/lobby')
  lobby(@CurrentUser() user: AuthenticatedUser, @Param('id', id) meetingId: string) {
    return this.meetings.lobby(user, meetingId);
  }

  @Post(':id/lobby')
  @HttpCode(HttpStatus.OK)
  decide(@CurrentUser() user: AuthenticatedUser, @Param('id', id) meetingId: string, @Body(new ZodValidationPipe(LobbyDecisionDtoSchema)) dto: { userId: string; admit: boolean }) {
    return this.meetings.decide(user, meetingId, dto.userId, dto.admit);
  }

  @Post(':id/mute-all')
  @HttpCode(HttpStatus.OK)
  muteAll(@CurrentUser() user: AuthenticatedUser, @Param('id', id) meetingId: string) {
    return this.meetings.muteAll(user, meetingId);
  }

  @Post(':id/remove')
  @HttpCode(HttpStatus.OK)
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id', id) meetingId: string, @Body(new ZodValidationPipe(RemoveParticipantDtoSchema)) dto: { userId: string }) {
    return this.meetings.remove(user, meetingId, dto.userId);
  }

  @Post(':id/action-items')
  addItem(@CurrentUser() user: AuthenticatedUser, @Param('id', id) meetingId: string, @Body(new ZodValidationPipe(ActionItemDtoSchema)) dto: ActionItemDto) {
    return this.meetings.addActionItem(user, meetingId, dto);
  }

  @Post(':id/action-items/:itemId/task')
  toTask(@CurrentUser() user: AuthenticatedUser, @Param('id', id) meetingId: string, @Param('itemId', id) itemId: string) {
    return this.meetings.convertToTask(user, meetingId, itemId);
  }
}
