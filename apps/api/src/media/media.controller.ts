import { Body, Controller, Headers, HttpCode, HttpStatus, Logger, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
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
  private readonly log = new Logger(LiveKitWebhookController.name);

  constructor(private readonly media: MediaService) {}

  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async webhook(@Req() req: { rawBody?: Buffer }, @Headers('authorization') auth?: string) {
    const raw = req.rawBody;
    // Rejections are logged (reason and size only, never the token or body) so a webhook that LiveKit
    // reports as sent can be traced to this API; a 401 is otherwise silent (ADR 016).
    if (!raw || raw.length === 0) { this.log.warn('webhook rejected: empty body'); throw new UnauthorizedException('Bad signature'); }
    if (!auth) { this.log.warn(`webhook rejected: no Authorization header (${raw.length} bytes)`); throw new UnauthorizedException('Bad signature'); }
    if (!verifyWebhook(liveKitConfig(), auth, raw)) { this.log.warn(`webhook rejected: signature does not verify with the configured LIVEKIT_API_KEY/SECRET (${raw.length} bytes)`); throw new UnauthorizedException('Bad signature'); }
    let event: WebhookEvent;
    try { event = JSON.parse(raw.toString('utf8')) as WebhookEvent; } catch { this.log.warn('webhook rejected: body is not JSON'); throw new UnauthorizedException('Bad body'); }
    this.log.log(`webhook accepted: ${event.event ?? 'unknown'} room=${event.room?.name ?? '-'}`);
    await this.media.handleWebhook(event);
    return { ok: true };
  }
}
