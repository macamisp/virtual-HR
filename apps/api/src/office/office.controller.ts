import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { BroadcastDtoSchema, DeskAssignDtoSchema, OfficeMapDtoSchema, PeopleQuerySchema, RoomInvitesDtoSchema, RoomUpdateDtoSchema, StatusDtoSchema } from '../../../../packages/shared/src/office/index.ts';
import type { BroadcastDto, DeskAssignDto, OfficeDefinition, PeopleQuery, RoomInvitesDto, RoomUpdateDto, StatusDto } from '../../../../packages/shared/src/office/index.ts';
import { OfficeService } from './office.service.ts';

const id = new ParseUUIDPipe({ version: '4' });

/** FR-VO-001..004, 007, 008, 012 (ADR 015). Live movement and rooms are on the socket. */
@Controller('office')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.OFFICE_USE)
export class OfficeController {
  constructor(private readonly office: OfficeService) {}

  @Get()
  snapshot(@CurrentUser() user: AuthenticatedUser) {
    return this.office.snapshot(user);
  }

  @Get('people')
  people(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(PeopleQuerySchema)) q: PeopleQuery) {
    return this.office.people(user, q);
  }

  @Put('me/status')
  status(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(StatusDtoSchema)) dto: StatusDto) {
    return this.office.setStatus(user, dto);
  }

  @Post('desks/:id/claim')
  claim(@CurrentUser() user: AuthenticatedUser, @Param('id', id) deskId: string) {
    return this.office.claimDesk(user, deskId);
  }

  @Delete('desks/:id/claim')
  release(@CurrentUser() user: AuthenticatedUser, @Param('id', id) deskId: string) {
    return this.office.releaseDesk(user, deskId);
  }
}

/** FR-VO-010: office.broadcast (admins, HR, managers). */
@Controller('office')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.BROADCAST)
export class OfficeBroadcastController {
  constructor(private readonly office: OfficeService) {}

  @Post('broadcast')
  broadcast(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(BroadcastDtoSchema)) dto: BroadcastDto) {
    return this.office.broadcast(user, dto.message);
  }
}

/** Office administration: org.manage. */
@Controller('office')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.ORG_MANAGE)
export class OfficeAdminController {
  constructor(private readonly office: OfficeService) {}

  @Put('desks/:id/assignee')
  assign(@CurrentUser() user: AuthenticatedUser, @Param('id', id) deskId: string, @Body(new ZodValidationPipe(DeskAssignDtoSchema)) dto: DeskAssignDto) {
    return this.office.assignDesk(user, deskId, dto);
  }

  @Put('rooms/:id')
  updateRoom(@CurrentUser() user: AuthenticatedUser, @Param('id', id) roomId: string, @Body(new ZodValidationPipe(RoomUpdateDtoSchema)) dto: RoomUpdateDto) {
    return this.office.updateRoom(user, roomId, dto);
  }

  @Get('rooms/:id/invites')
  invites(@CurrentUser() user: AuthenticatedUser, @Param('id', id) roomId: string) {
    return this.office.invites(user, roomId);
  }

  @Put('rooms/:id/invites')
  setInvites(@CurrentUser() user: AuthenticatedUser, @Param('id', id) roomId: string, @Body(new ZodValidationPipe(RoomInvitesDtoSchema)) dto: RoomInvitesDto) {
    return this.office.setInvites(user, roomId, dto);
  }

  @Put('map')
  replaceMap(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(OfficeMapDtoSchema)) dto: OfficeDefinition) {
    return this.office.replaceMap(user, dto);
  }
}
