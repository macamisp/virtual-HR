import { z } from 'zod';
import {
  Controller,
  Delete,
  Get,
  Param,
  Query,
  Post,
  Body,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  UsePipes,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthService } from './auth.service.ts';
import { WorkspaceService } from './workspace.service.ts';
import { GoogleSignInService, OAUTH_COOKIE, OAUTH_COOKIE_PATH } from './google-signin.service.ts';
import { AccountLinksService } from './account-links.service.ts';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { Public } from '../common/decorators/public.decorator.ts';
import { AllowMfaEnrollment } from '../common/decorators/allow-mfa-enrollment.decorator.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { RateLimit } from '../common/rate-limit.ts';
import {
  CSRF_HEADER,
  REFRESH_COOKIE_NAME,
  isOriginAllowed,
  refreshCookieOptions,
} from '../common/config.ts';
import {
  Permission,
  LoginDtoSchema,
  InviteUserDtoSchema,
  SignupInvitationDtoSchema,
  Verify2faDtoSchema,
  PasswordForgotDtoSchema,
  PasswordResetDtoSchema,
  WorkspaceSignupDtoSchema,
  VerifyEmailDtoSchema,
  ResendVerificationDtoSchema,
  GoogleStartDtoSchema,
  GoogleTotpDtoSchema,
  GoogleCompleteDtoSchema,
  LinkTokenDtoSchema,
} from '../../../../packages/shared/src/index.ts';
import type {
  LoginDto,
  InviteUserDto,
  SignupInvitationDto,
  Verify2faDto,
  PasswordForgotDto,
  PasswordResetDto,
  AuthenticatedUser,
  WorkspaceSignupDto,
  VerifyEmailDto,
  ResendVerificationDto,
  GoogleCompleteDto,
  GoogleTotpDto,
  LinkTokenDto,
} from '../../../../packages/shared/src/index.ts';
import { SelfService } from '../common/decorators/self-service.decorator.ts';

const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function requestMeta(req: Request): [string | undefined, string | undefined] {
  return [req.ip || req.socket.remoteAddress, req.headers['user-agent']];
}

/**
 * FR-AUTH-003: the rotating refresh token travels ONLY as the httpOnly cookie (Secure in
 * production, SameSite=Strict, Path=/auth/refresh). It is removed from every JSON body so
 * page scripts can never read it.
 */
function moveRefreshTokenToCookie<T extends object>(res: Response, result: T): Omit<T, 'refreshToken' | 'familyId'> {
  if (!('refreshToken' in result)) return result;
  // familyId is internal (ADR 018 device binding); the browser never needs it.
  const { refreshToken, familyId: _familyId, ...body } = result as T & { refreshToken: unknown; familyId?: unknown };
  if (typeof refreshToken === 'string' && refreshToken.length > 0) {
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, { ...refreshCookieOptions(), maxAge: REFRESH_MAX_AGE_MS });
  }
  return body;
}

@Controller('auth')
@UseGuards(ThrottlerGuard, JwtAuthGuard, PermissionsGuard)
export class AuthController {
  constructor(private readonly authService: AuthService, private readonly workspaces: WorkspaceService, private readonly google: GoogleSignInService, private readonly links: AccountLinksService) {}

  // ---------------------------------------------------------------- ADR 037: self-service workspaces

  @Public()
  @Post('signup')
  @RateLimit('signup')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(WorkspaceSignupDtoSchema))
  async signup(@Body() dto: WorkspaceSignupDto, @Req() req: Request) {
    const [ip, userAgent] = requestMeta(req);
    return await this.workspaces.signup(dto, { ip, userAgent });
  }

  @Public()
  @Post('email/verify')
  @RateLimit('signup')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(VerifyEmailDtoSchema))
  async verifyEmail(@Body() dto: VerifyEmailDto, @Req() req: Request) {
    const [ip, userAgent] = requestMeta(req);
    return await this.workspaces.verifyEmail(dto.token, { ip, userAgent });
  }

  @Public()
  @Post('email/resend')
  @RateLimit('signup')
  @HttpCode(HttpStatus.ACCEPTED)
  @UsePipes(new ZodValidationPipe(ResendVerificationDtoSchema))
  async resendVerification(@Body() dto: ResendVerificationDto) {
    return await this.workspaces.resendVerification(dto);
  }

  // ---------------------------------------------------------------- ADR 039: e-mailed links

  /** What a confirmation, invitation or reset link can still do (valid, used, expired, withdrawn). */
  @Public()
  @Post('links/status')
  @RateLimit('signup')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(LinkTokenDtoSchema))
  async linkStatus(@Body() dto: LinkTokenDto) {
    return await this.links.status(dto);
  }

  /** A new link, sent to the address the old one went to. Same answer whatever happened. */
  @Public()
  @Post('links/renew')
  @RateLimit('signup')
  @HttpCode(HttpStatus.ACCEPTED)
  @UsePipes(new ZodValidationPipe(LinkTokenDtoSchema))
  async renewLink(@Body() dto: LinkTokenDto, @Req() req: Request) {
    const [ip, userAgent] = requestMeta(req);
    return await this.links.renew(dto, { ip, userAgent });
  }

  // ---------------------------------------------------------------- FR-AUTH-005: sign in with Google

  /**
   * Sends the browser to Google; the state, nonce and PKCE verifier go into a signed cookie. A top-level
   * navigation, not a fetch (ADR 042): the cookie is then a first-party cookie of the API site, which
   * browsers that block third-party cookies still store and send back on the callback. Refused starts
   * return to the web app with a result code, as the callback does.
   */
  @Public()
  @Get('google/start')
  @RateLimit('signup')
  googleStart(@Query() q: Record<string, unknown>, @Res() res: Response): void {
    res.setHeader('Cache-Control', 'no-store');
    const parsed = GoogleStartDtoSchema.safeParse(q);
    if (!parsed.success || parsed.data.mode === 'link') {
      res.redirect(302, this.google.errorRedirect(parsed.success ? parsed.data.mode : 'login', 'failed'));
      return;
    }
    let r: ReturnType<GoogleSignInService['start']>;
    try {
      r = this.google.start(parsed.data);
    } catch (err) {
      if (err instanceof ServiceUnavailableException) {
        res.redirect(302, this.google.errorRedirect(parsed.data.mode, 'not_configured'));
        return;
      }
      throw err;
    }
    res.cookie(r.cookie.name, r.cookie.value, r.cookie.options);
    res.redirect(302, r.authorizeUrl);
  }

  /** Google redirects here; the browser is sent on to the web app with the outcome. */
  @Public()
  @Get('google/callback')
  @RateLimit('oauth')
  async googleCallback(@Query() q: Record<string, unknown>, @Req() req: Request, @Res() res: Response): Promise<void> {
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const [ip, userAgent] = requestMeta(req);
    const cookie: unknown = req.cookies?.[OAUTH_COOKIE];
    const r = await this.google.callback({ code: str(q.code), state: str(q.state), error: str(q.error) }, typeof cookie === 'string' ? cookie : undefined, { ip, userAgent });
    res.clearCookie(OAUTH_COOKIE, { path: OAUTH_COOKIE_PATH });
    res.redirect(302, r.redirect);
  }

  /** Last step after the callback (ADR 042): the single-use handoff token becomes the session and refresh cookie. */
  @Public()
  @Post('google/complete')
  @RateLimit('login')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(GoogleCompleteDtoSchema))
  async googleComplete(@Body() dto: GoogleCompleteDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const [ip, userAgent] = requestMeta(req);
    return moveRefreshTokenToCookie(res, await this.google.complete(dto, { ip, userAgent }));
  }

  /** Signed in: add Google to the account (any verified Google address the person controls). */
  @SelfService()
  @Post('google/link')
  @RateLimit('signup')
  @HttpCode(HttpStatus.OK)
  googleLink(@CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) res: Response) {
    const r = this.google.start({ mode: 'link' }, { id: user.id, orgId: user.orgId });
    res.cookie(r.cookie.name, r.cookie.value, r.cookie.options);
    return { authorizeUrl: r.authorizeUrl };
  }

  /** Remove Google from the account; refused while it is the only sign-in method. */
  @SelfService()
  @Delete('google/link')
  @HttpCode(HttpStatus.OK)
  async googleUnlink(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    const [ip, userAgent] = requestMeta(req);
    return await this.google.unlink({ id: user.id, orgId: user.orgId }, { ip, userAgent });
  }

  @Public()
  @Post('google/totp')
  @RateLimit('login')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(GoogleTotpDtoSchema))
  async googleTotp(@Body() dto: GoogleTotpDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const [ip, userAgent] = requestMeta(req);
    return moveRefreshTokenToCookie(res, await this.google.completeTotp(dto, { ip, userAgent }));
  }

  // ---------------------------------------------------------------- FR-AUTH-001 invitations

  @Get('invitations')
  @RequirePermissions(Permission.USERS_INVITE)
  async listInvitations(@CurrentUser() user: AuthenticatedUser) {
    return await this.authService.listInvitations(user);
  }

  @Post('invitations/:id/resend')
  @RequirePermissions(Permission.USERS_INVITE)
  @HttpCode(HttpStatus.OK)
  async resendInvitation(@CurrentUser() user: AuthenticatedUser, @Param('id', new ZodValidationPipe(z.uuid())) id: string, @Req() req: Request) {
    return await this.authService.resendInvitation(user, id, ...requestMeta(req));
  }

  @Post('invitations/:id/revoke')
  @RequirePermissions(Permission.USERS_INVITE)
  @HttpCode(HttpStatus.OK)
  async revokeInvitation(@CurrentUser() user: AuthenticatedUser, @Param('id', new ZodValidationPipe(z.uuid())) id: string, @Req() req: Request) {
    return await this.authService.revokeInvitation(user, id, ...requestMeta(req));
  }

  @Post('invitations/invite')
  @RequirePermissions(Permission.USERS_INVITE)
  @UsePipes(new ZodValidationPipe(InviteUserDtoSchema))
  async inviteUser(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InviteUserDto,
    @Req() req: Request,
  ) {
    return await this.authService.createInvitation(user, dto, ...requestMeta(req));
  }

  @Public()
  @Post('invitations/accept')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(SignupInvitationDtoSchema))
  async acceptInvitation(
    @Body() dto: SignupInvitationDto,
    @Req() req: Request,
  ) {
    return await this.authService.acceptInvitation(dto, ...requestMeta(req));
  }

  @Public()
  @Post('login')
  @RateLimit('login')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(LoginDtoSchema))
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return moveRefreshTokenToCookie(res, await this.authService.login(dto, ...requestMeta(req)));
  }

  /**
   * Refresh is authenticated only by the httpOnly cookie, which makes it a CSRF target, so it
   * also requires the X-HRVO-CSRF header (forces a CORS preflight that the origin allow-list
   * rejects) and an allowed Origin when one is sent. Tokens in the body are not accepted.
   */
  @Public()
  @Post('refresh')
  @RateLimit('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (req.headers[CSRF_HEADER] !== '1' || !isOriginAllowed(req.headers.origin)) {
      throw new ForbiddenException('CSRF check failed');
    }
    const cookieToken: unknown = req.cookies?.[REFRESH_COOKIE_NAME];
    const token = typeof cookieToken === 'string' ? cookieToken : '';
    return moveRefreshTokenToCookie(res, await this.authService.refresh(token, ...requestMeta(req)));
  }

  @Public()
  @Post('password/forgot')
  @RateLimit('passwordReset')
  @HttpCode(HttpStatus.ACCEPTED)
  @UsePipes(new ZodValidationPipe(PasswordForgotDtoSchema))
  async forgotPassword(@Body() dto: PasswordForgotDto, @Req() req: Request) {
    return await this.authService.requestPasswordReset(dto.email, ...requestMeta(req));
  }

  @Public()
  @Post('password/reset')
  @RateLimit('passwordReset')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(PasswordResetDtoSchema))
  async resetPassword(
    @Body() dto: PasswordResetDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.resetPassword(dto.token, dto.newPassword, ...requestMeta(req));
    res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
    return result;
  }

  @SelfService()
  @Post('2fa/setup')
  @AllowMfaEnrollment()
  @HttpCode(HttpStatus.OK)
  async setup2fa(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return await this.authService.setup2fa(user, ...requestMeta(req));
  }

  @SelfService()
  @Post('2fa/verify')
  @AllowMfaEnrollment()
  @RateLimit('login')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(Verify2faDtoSchema))
  async verify2fa(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: Verify2faDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return moveRefreshTokenToCookie(res, await this.authService.verifyAndEnable2fa(user, dto.code, ...requestMeta(req)));
  }

  @Delete('sessions/:id')
  @RequirePermissions(Permission.USERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @Req() req: Request,
  ) {
    return await this.authService.revokeSession(user, id, ...requestMeta(req));
  }

  @SelfService()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.logout(user, ...requestMeta(req));
    res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
    return result;
  }
}
