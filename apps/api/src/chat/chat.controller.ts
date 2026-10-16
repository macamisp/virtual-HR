import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { ChannelCreateDtoSchema, ChatSearchQuerySchema, MembersDtoSchema, MessageDtoSchema, MessageEditDtoSchema, MessageQuerySchema } from '../../../../packages/shared/src/chat/types.ts';
import type { ChannelCreateDto, MembersDto, MessageDto, MessageQuery } from '../../../../packages/shared/src/chat/types.ts';
import { ChatService } from './chat.service.ts';

const id = new ParseUUIDPipe({ version: '4' });

/** FR-MEET-012, 013 (ADR 017), SRS 8.3 chat routes. */
@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.CHAT_USE)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('channels')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.chat.list(user);
  }

  @Post('channels')
  create(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(ChannelCreateDtoSchema)) dto: ChannelCreateDto) {
    return this.chat.create(user, dto);
  }

  @Post('channels/:id/join')
  @HttpCode(HttpStatus.OK)
  join(@CurrentUser() user: AuthenticatedUser, @Param('id', id) channelId: string) {
    return this.chat.join(user, channelId);
  }

  @Post('channels/:id/leave')
  @HttpCode(HttpStatus.OK)
  leave(@CurrentUser() user: AuthenticatedUser, @Param('id', id) channelId: string) {
    return this.chat.leave(user, channelId);
  }

  @Put('channels/:id/members')
  members(@CurrentUser() user: AuthenticatedUser, @Param('id', id) channelId: string, @Body(new ZodValidationPipe(MembersDtoSchema)) dto: MembersDto) {
    return this.chat.setMembers(user, channelId, dto);
  }

  @Post('channels/:id/archive')
  @HttpCode(HttpStatus.OK)
  archive(@CurrentUser() user: AuthenticatedUser, @Param('id', id) channelId: string) {
    return this.chat.archive(user, channelId);
  }

  @Get('channels/:id/messages')
  messages(@CurrentUser() user: AuthenticatedUser, @Param('id', id) channelId: string, @Query(new ZodValidationPipe(MessageQuerySchema)) q: MessageQuery) {
    return this.chat.messages(user, channelId, q);
  }

  @Post('channels/:id/messages')
  post(@CurrentUser() user: AuthenticatedUser, @Param('id', id) channelId: string, @Body(new ZodValidationPipe(MessageDtoSchema)) dto: MessageDto) {
    return this.chat.post(user, channelId, dto);
  }

  @Put('messages/:id')
  edit(@CurrentUser() user: AuthenticatedUser, @Param('id', id) messageId: string, @Body(new ZodValidationPipe(MessageEditDtoSchema)) dto: { body: string }) {
    return this.chat.edit(user, messageId, dto.body);
  }

  @Delete('messages/:id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id', id) messageId: string) {
    return this.chat.remove(user, messageId);
  }

  @Get('chat/search')
  search(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(ChatSearchQuerySchema)) q: { q: string; limit: number }) {
    return this.chat.search(user, q.q, q.limit);
  }
}
