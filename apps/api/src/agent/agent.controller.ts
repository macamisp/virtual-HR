import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { Public } from '../common/decorators/public.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { RateLimit } from '../common/rate-limit.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { AgentTokenDtoSchema, OfflineSyncDtoSchema, PairDtoSchema, Permission } from '../../../../packages/shared/src/index.ts';
import type { AgentTokenDto, AuthenticatedUser, OfflineSyncDto, PairDto } from '../../../../packages/shared/src/index.ts';
import { AgentService } from './agent.service.ts';
import type { RequestContext } from './agent.service.ts';

const ctxOf = (req: Request): RequestContext => ({ ip: req.ip || req.socket.remoteAddress || null, userAgent: req.headers['user-agent'] ?? null });

/** FR-ATT-011/012 (ADR 018). Pairing and token refresh are public (the agent has no session yet) and rate limited. */
@Controller('agent')
@UseGuards(ThrottlerGuard, JwtAuthGuard, PermissionsGuard)
export class AgentController {
  constructor(private readonly agents: AgentService) {}

  /** The consent text the agent shows before pairing. */
  @Public()
  @Get('notice')
  notice() {
    return this.agents.notice();
  }

  @Public()
  @Post('pair')
  @RateLimit('agentPair')
  @HttpCode(HttpStatus.OK)
  pair(@Body(new ZodValidationPipe(PairDtoSchema)) dto: PairDto, @Req() req: Request) {
    return this.agents.pair(dto, ctxOf(req));
  }

  @Public()
  @Post('token')
  @RateLimit('agentToken')
  @HttpCode(HttpStatus.OK)
  token(@Body(new ZodValidationPipe(AgentTokenDtoSchema)) dto: AgentTokenDto, @Req() req: Request) {
    return this.agents.token(dto.deviceId, dto.refreshToken, ctxOf(req));
  }

  @Post('pairing-codes')
  @RequirePermissions(Permission.AGENT_USE)
  createCode(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.agents.createPairingCode(user, ctxOf(req));
  }

  @Get('devices')
  @RequirePermissions(Permission.AGENT_USE)
  devices(@CurrentUser() user: AuthenticatedUser) {
    return this.agents.devices(user);
  }

  @Delete('devices/:id')
  @RequirePermissions(Permission.AGENT_USE)
  revoke(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.agents.revoke(user, id, ctxOf(req));
  }

  /** Only the agent's own session may upload (checked in the service). */
  @Post('offline-sync')
  @RequirePermissions(Permission.AGENT_USE)
  @HttpCode(HttpStatus.OK)
  offlineSync(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(OfflineSyncDtoSchema)) dto: OfflineSyncDto, @Req() req: Request) {
    return this.agents.offlineSync(user, dto, ctxOf(req));
  }
}
