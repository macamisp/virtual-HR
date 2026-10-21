import { Body, Controller, Headers, HttpCode, HttpStatus, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { MediaTokenRequestSchema } from '../../../../packages/shared/src/meetings/types.ts';
import type { MediaTokenRequest } from '../../../../packages/shared/src/meetings/types.ts';
import { MediaService } from './media.service.ts';
import type { WebhookEvent } from './media.service.ts';
import { MeetingsService } from '../meetings/meetings.service.ts';
import { liveKitConfig, verifyWebhook } from './livekit.ts';
import { Public } from '../common/decorators/public.decorator.ts';

/** ADR 016: short-lived LiveKit tokens, one room each, chosen by the server. */
@Controller('media')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly meetings: MeetingsService,
  ) {}

  @Post('token')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.OFFICE_USE)
  async token(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(MediaTokenRequestSchema)) dto: MediaTokenRequest) {
    if (dto.kind === 'room') return await this.media.roomToken(user);
    if (dto.kind === 'proximity') return await this.media.proximityToken(user);
    // Meetings go through the lobby rules; READY carries the token.
    const r = await this.meetings.join(user, dto.meetingId);
    if (r.status !== 'READY') throw new UnauthorizedException(r.message);
    return r.token;
  }
}

/** LiveKit → API. No user; authenticated by the webhook signature over the raw body. */
@Controller('media/livekit')
export class LiveKitWebhookController {
  constructor(private readonly media: MediaService) {}

  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async webhook(@Req() req: { rawBody?: Buffer }, @Headers('authorization') auth?: string) {
    const raw = req.rawBody;
    if (!raw || !verifyWebhook(liveKitConfig(), auth, raw)) throw new UnauthorizedException('Bad signature');
    let event: WebhookEvent;
    try { event = JSON.parse(raw.toString('utf8')) as WebhookEvent; } catch { throw new UnauthorizedException('Bad body'); }
    await this.media.handleWebhook(event);
    return { ok: true };
  }
}
