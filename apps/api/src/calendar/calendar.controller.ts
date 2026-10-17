import { BadRequestException, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { Public } from '../common/decorators/public.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { RateLimit } from '../common/rate-limit.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { BusyQuerySchema, CALENDAR_PROVIDERS, Permission } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser, CalendarProvider } from '../../../../packages/shared/src/index.ts';
import { CalendarService } from './calendar.service.ts';

const meta = (req: Request) => ({ ip: req.ip || req.socket.remoteAddress || null, userAgent: req.headers['user-agent'] ?? null });
function provider(p: string): CalendarProvider {
  const v = p.toUpperCase();
  if (!(CALENDAR_PROVIDERS as readonly string[]).includes(v)) throw new BadRequestException('Unknown calendar provider');
  return v as CalendarProvider;
}

/** FR-MEET-006 (ADR 023). */
@Controller('calendar')
@UseGuards(ThrottlerGuard, JwtAuthGuard, PermissionsGuard)
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get('connections')
  @RequirePermissions(Permission.MEETINGS_USE)
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.calendar.list(user);
  }

  @Post(':provider/connect')
  @RequirePermissions(Permission.MEETINGS_USE)
  @HttpCode(HttpStatus.OK)
  connect(@CurrentUser() user: AuthenticatedUser, @Param('provider') p: string) {
    return this.calendar.start(user, provider(p));
  }

  @Delete(':provider')
  @RequirePermissions(Permission.MEETINGS_USE)
  disconnect(@CurrentUser() user: AuthenticatedUser, @Param('provider') p: string, @Req() req: Request) {
    return this.calendar.disconnect(user, provider(p), meta(req));
  }

  @Post('sync')
  @RequirePermissions(Permission.MEETINGS_USE)
  @HttpCode(HttpStatus.OK)
  sync(@CurrentUser() user: AuthenticatedUser) {
    return this.calendar.syncUser(user);
  }

  @Get('busy')
  @RequirePermissions(Permission.MEETINGS_USE)
  busy(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(BusyQuerySchema)) q: { userIds: string[]; from: string; to: string }) {
    return this.calendar.busy(user, q.userIds, new Date(q.from), new Date(q.to));
  }

  /** The provider redirects the browser here (no session); the one-time state identifies the person. */
  @Public()
  @Get('oauth/callback')
  @RateLimit('oauth')
  async callback(@Query() q: Record<string, unknown>, @Req() req: Request, @Res() res: Response): Promise<void> {
    const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 2048) : undefined);
    res.redirect(302, await this.calendar.callback({ code: str(q.code), state: str(q.state), error: str(q.error) }, meta(req)));
  }
}
