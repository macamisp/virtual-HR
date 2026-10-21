/**
 * FR-DOC-014 e-signature routes (ADR 022). Every route needs documents.use; the service checks the
 * document level (MANAGE to request) and that the caller is a party to the request.
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { z } from 'zod';
import { ThrottlerGuard } from '@nestjs/throttler';
import { DeniedAccessLogInterceptor } from './denied-access-log.interceptor.ts';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ReqContext } from '../common/decorators/request-context.decorator.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { RateLimit } from '../common/rate-limit.ts';
import { Permission } from '../../../../packages/shared/src/auth/types.ts';
import { DeclineSignatureDtoSchema, SignatureRequestDtoSchema, SignDtoSchema } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser, SignatureRequestDto, SignDto } from '../../../../packages/shared/src/index.ts';
import { EsignService } from './esign.service.ts';

const id = new ParseUUIDPipe({ version: '4' });
const ListQuerySchema = z.object({ scope: z.enum(['to-sign', 'sent', 'document']).default('to-sign'), documentId: z.string().uuid().optional() }).strict();

@Controller()
@UseGuards(ThrottlerGuard, JwtAuthGuard, PermissionsGuard)
@UseInterceptors(DeniedAccessLogInterceptor)
@RequirePermissions(Permission.DOCUMENTS_USE)
export class EsignController {
  constructor(private readonly esign: EsignService) {}

  @Post('documents/:id/signature-requests')
  create(@CurrentUser() user: AuthenticatedUser, @Param('id', id) docId: string, @Body(new ZodValidationPipe(SignatureRequestDtoSchema)) dto: SignatureRequestDto, @ReqContext() ctx: RequestContext) {
    return this.esign.create(user, docId, dto, ctx);
  }

  @Get('signature-requests')
  list(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(ListQuerySchema)) q: z.infer<typeof ListQuerySchema>) {
    return this.esign.list(user, q.scope, q.documentId);
  }

  @Get('signature-requests/:id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', id) reqId: string) {
    return this.esign.get(user, reqId);
  }

  @Get('signature-requests/:id/verify')
  verify(@CurrentUser() user: AuthenticatedUser, @Param('id', id) reqId: string) {
    return this.esign.verify(user, reqId);
  }

  @Post('signature-requests/:id/sign')
  @HttpCode(HttpStatus.OK)
  @RateLimit('vault')
  sign(@CurrentUser() user: AuthenticatedUser, @Param('id', id) reqId: string, @Body(new ZodValidationPipe(SignDtoSchema)) dto: SignDto, @ReqContext() ctx: RequestContext) {
    return this.esign.sign(user, reqId, dto, ctx);
  }

  @Post('signature-requests/:id/decline')
  @HttpCode(HttpStatus.OK)
  decline(@CurrentUser() user: AuthenticatedUser, @Param('id', id) reqId: string, @Body(new ZodValidationPipe(DeclineSignatureDtoSchema)) dto: { reason: string }, @ReqContext() ctx: RequestContext) {
    return this.esign.decline(user, reqId, dto.reason, ctx);
  }

  @Post('signature-requests/:id/finalize')
  @HttpCode(HttpStatus.OK)
  finalize(@CurrentUser() user: AuthenticatedUser, @Param('id', id) reqId: string) {
    return this.esign.finalize(user, reqId);
  }

  @Post('signature-requests/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', id) reqId: string, @ReqContext() ctx: RequestContext) {
    return this.esign.cancel(user, reqId, ctx);
  }
}
