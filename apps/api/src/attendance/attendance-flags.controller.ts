import { Body, ConflictException, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { ChallengeResponseDtoSchema, FlagCommentDtoSchema, FlagQuerySchema, Permission, ResolveFlagDtoSchema } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser, FlagCommentDto, FlagQuery, ResolveFlagDto } from '../../../../packages/shared/src/index.ts';
import { AttendanceFlagsService } from './attendance-flags.service.ts';
import { AttendanceService } from './attendance.service.ts';
import { AttendanceGateway } from './attendance.gateway.ts';
import { InvalidTransitionError } from './attendance-state-machine.ts';

const ipOf = (req: Request) => req.ip || req.socket.remoteAddress || null;

/** ADR 019: review flags (FR-ATT-017/018) and the presence challenge reply (FR-ATT-023). */
@Controller('attendance')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AttendanceFlagsController {
  constructor(
    private readonly flags: AttendanceFlagsService,
    private readonly attendance: AttendanceService,
    private readonly gateway: AttendanceGateway,
  ) {}

  /** scope=mine: your own flags; scope=review: those you may review (checked in the service). */
  @Get('flags')
  @RequirePermissions(Permission.ATTENDANCE_READ_OWN)
  list(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(FlagQuerySchema)) q: FlagQuery) {
    return this.flags.list(user, q);
  }

  @Post('flags/:id/resolve')
  @RequirePermissions(Permission.ATTENDANCE_CORRECTIONS_REVIEW)
  @HttpCode(HttpStatus.OK)
  resolve(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(ResolveFlagDtoSchema)) dto: ResolveFlagDto, @Req() req: Request) {
    return this.flags.resolve(user, id, dto, ipOf(req));
  }

  /** The person flagged may explain (for example "I was on a VPN"). */
  @Post('flags/:id/comment')
  @RequirePermissions(Permission.ATTENDANCE_READ_OWN)
  @HttpCode(HttpStatus.OK)
  comment(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(FlagCommentDtoSchema)) dto: FlagCommentDto, @Req() req: Request) {
    return this.flags.comment(user, id, dto, ipOf(req));
  }

  /** FR-ATT-023: "Yes, I am still working" (server clock decides whether it is in time). */
  @Post('challenge')
  @RequirePermissions(Permission.ATTENDANCE_READ_OWN)
  @HttpCode(HttpStatus.OK)
  async answer(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(ChallengeResponseDtoSchema)) dto: { challengeId: string }) {
    try {
      const result = await this.attendance.answerChallenge(user.orgId, user.id, dto.challengeId);
      this.gateway.broadcastTransition(user.orgId, user.id, result);
      return { currentState: result.currentState };
    } catch (err) {
      if (err instanceof InvalidTransitionError) throw new ConflictException('The question has expired. Any input resumes tracking.');
      throw err;
    }
  }
}
