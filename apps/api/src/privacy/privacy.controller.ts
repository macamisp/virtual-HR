import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { CreateAnonymisationDtoSchema, ExecuteAnonymisationDtoSchema } from '../../../../packages/shared/src/privacy/types.ts';
import type { CreateAnonymisationDto, ExecuteAnonymisationDto } from '../../../../packages/shared/src/privacy/types.ts';
import { z } from 'zod';
import { DataExportService } from './data-export.service.ts';
import { AnonymisationService } from './anonymisation.service.ts';
import { SelfService } from '../common/decorators/self-service.decorator.ts';

const id = new ParseUUIDPipe({ version: '4' });
const FormatSchema = z.object({ format: z.enum(['json', 'zip']).default('zip') });
type Format = z.infer<typeof FormatSchema>;

function file(f: { body: Buffer; contentType: string; filename: string }): StreamableFile {
  return new StreamableFile(f.body, { type: f.contentType, disposition: `attachment; filename="${f.filename}"`, length: f.body.length });
}

/** FR-AUD-002 / 003 for HR with privacy.manage (ADR 014). */
@Controller('privacy')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PRIVACY_MANAGE)
export class PrivacyController {
  constructor(
    private readonly exports: DataExportService,
    private readonly anonymisation: AnonymisationService,
  ) {}

  @Get('subjects/:userId/export')
  @Header('Cache-Control', 'no-store')
  async export(@CurrentUser() user: AuthenticatedUser, @Param('userId', id) userId: string, @Query(new ZodValidationPipe(FormatSchema)) q: Format) {
    return file(await this.exports.export(user, userId, q.format));
  }

  @Get('subjects/:userId/anonymisation-check')
  check(@CurrentUser() user: AuthenticatedUser, @Param('userId', id) userId: string) {
    return this.anonymisation.check(user, userId);
  }

  @Get('requests')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.anonymisation.list(user);
  }

  @Post('requests')
  create(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(CreateAnonymisationDtoSchema)) dto: CreateAnonymisationDto) {
    return this.anonymisation.create(user, dto);
  }

  @Post('requests/:id/execute')
  @HttpCode(HttpStatus.OK)
  execute(@CurrentUser() user: AuthenticatedUser, @Param('id', id) requestId: string, @Body(new ZodValidationPipe(ExecuteAnonymisationDtoSchema)) dto: ExecuteAnonymisationDto) {
    return this.anonymisation.execute(user, requestId, dto.confirmEmail);
  }

  @Post('requests/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', id) requestId: string) {
    return this.anonymisation.cancel(user, requestId);
  }
}

/** Anyone may download their own data (the data subject's right of access). */
@Controller('me')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SelfExportController {
  constructor(private readonly exports: DataExportService) {}

  @SelfService()
  @Get('export')
  @Header('Cache-Control', 'no-store')
  async exportMine(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(FormatSchema)) q: Format) {
    return file(await this.exports.export(user, user.id, q.format));
  }
}
