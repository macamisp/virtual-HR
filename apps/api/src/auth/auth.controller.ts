import { z } from 'zod';
import {
  Controller,
  Delete,
  Param,
  Post,
  Body,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  UsePipes,
  ForbiddenException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthService } from './auth.service.ts';
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
} from '../../../../packages/shared/src/index.ts';
import type {
  LoginDto,
  InviteUserDto,
  SignupInvitationDto,
  Verify2faDto,
  PasswordForgotDto,
  PasswordResetDto,
  AuthenticatedUser,
} from '../../../../packages/shared/src/index.ts';

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
  constructor(private readonly authService: AuthService) {}

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

  @Post('2fa/setup')
  @AllowMfaEnrollment()
  @HttpCode(HttpStatus.OK)
  async setup2fa(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return await this.authService.setup2fa(user, ...requestMeta(req));
  }

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
