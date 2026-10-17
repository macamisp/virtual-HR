/**
 * FR-MEET-007 recording routes (ADR 024). Every route needs meetings.use; the service checks the
 * meeting role (host/co-host to start, stop and delete) and who may watch.
 */
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Res, StreamableFile, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ReqContext } from '../common/decorators/request-context.decorator.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/auth/types.ts';
import { RecordingConsentDtoSchema } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser, RecordingConsentDto } from '../../../../packages/shared/src/index.ts';
import { RecordingsService } from './recordings.service.ts';

const id = new ParseUUIDPipe({ version: '4' });

@Controller()
@UseGuards(ThrottlerGuard, JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.MEETINGS_USE)
export class RecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  @Get('meetings/:id/recordings')
  list(@CurrentUser() user: AuthenticatedUser, @Param('id', id) meetingId: string) {
    return this.recordings.list(user, meetingId);
  }

  @Post('meetings/:id/recordings')
  start(@CurrentUser() user: AuthenticatedUser, @Param('id', id) meetingId: string, @ReqContext() ctx: RequestContext) {
    return this.recordings.request(user, meetingId, ctx);
  }

  @Get('recordings/:id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', id) recId: string) {
    return this.recordings.get(user, recId);
  }

  @Post('recordings/:id/consent')
  @HttpCode(HttpStatus.OK)
  consent(@CurrentUser() user: AuthenticatedUser, @Param('id', id) recId: string, @Body(new ZodValidationPipe(RecordingConsentDtoSchema)) dto: RecordingConsentDto, @ReqContext() ctx: RequestContext) {
    return this.recordings.consent(user, recId, dto, ctx);
  }

  @Post('recordings/:id/stop')
  @HttpCode(HttpStatus.OK)
  stop(@CurrentUser() user: AuthenticatedUser, @Param('id', id) recId: string, @ReqContext() ctx: RequestContext) {
    return this.recordings.stop(user, recId, ctx);
  }

  @Get('recordings/:id/content')
  async content(@CurrentUser() user: AuthenticatedUser, @Param('id', id) recId: string, @ReqContext() ctx: RequestContext, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const file = await this.recordings.content(user, recId, ctx);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    const ascii = file.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return new StreamableFile(file.stream, { type: 'video/mp4', length: file.sizeBytes, disposition: `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}` });
  }

  @Delete('recordings/:id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id', id) recId: string, @ReqContext() ctx: RequestContext) {
    return this.recordings.remove(user, recId, ctx);
  }
}
