import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
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
import { PublicShareOpenDtoSchema, ReauthDtoSchema } from '../../../../packages/shared/src/documents/types.ts';
import type { PublicShareOpenDto, ReauthDto } from '../../../../packages/shared/src/documents/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { VaultService } from './vault.service.ts';
import { ShareLinksService } from './share-links.service.ts';
import { send } from './documents.controller.ts';

/** FR-DOC-005: re-authenticate (password or TOTP) to open confidential documents for N minutes. */
@Controller('vault')
@UseGuards(ThrottlerGuard, JwtAuthGuard, PermissionsGuard)
@UseInterceptors(DeniedAccessLogInterceptor)
@RequirePermissions(Permission.DOCUMENTS_USE)
export class VaultController {
  constructor(private readonly vault: VaultService) {}

  @Get('reauth')
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.vault.reauthStatus(user);
  }

  @Post('reauth')
  @HttpCode(HttpStatus.OK)
  @RateLimit('vault')
  reauth(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(ReauthDtoSchema)) dto: ReauthDto, @ReqContext() ctx: RequestContext) {
    return this.vault.reauthenticate(user, dto, ctx);
  }
}

/**
 * FR-DOC-010: public share links. No login; the token is the only credential, so every route
 * is rate-limited and every failure looks the same.
 */
@Controller('share')
@UseGuards(ThrottlerGuard)
export class PublicShareController {
  constructor(private readonly shares: ShareLinksService) {}

  @Get(':token')
  @RateLimit('share')
  info(@Param('token') token: string) {
    return this.shares.info(token);
  }

  @Post(':token/open')
  @HttpCode(HttpStatus.OK)
  @RateLimit('share')
  async open(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(PublicShareOpenDtoSchema)) dto: PublicShareOpenDto,
    @ReqContext() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    return send(await this.shares.open(token, dto, ctx), dto.mode === 'download' ? 'attachment' : 'inline', res);
  }
}
