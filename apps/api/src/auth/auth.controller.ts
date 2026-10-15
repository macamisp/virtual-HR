import {
  Controller,
  Post,
  Body,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  UsePipes,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.ts';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { Public } from '../common/decorators/public.decorator.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import {
  Permission,
  LoginDtoSchema,
  InviteUserDtoSchema,
  SignupInvitationDtoSchema,
  Verify2faDtoSchema,
} from '../../../../packages/shared/src/index.ts';
import type {
  LoginDto,
  InviteUserDto,
  SignupInvitationDto,
  Verify2faDto,
  AuthenticatedUser,
} from '../../../../packages/shared/src/index.ts';

@Controller('auth')
@UseGuards(JwtAuthGuard, PermissionsGuard)
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
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return await this.authService.createInvitation(user, dto, ip, userAgent);
  }

  @Public()
  @Post('invitations/accept')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(SignupInvitationDtoSchema))
  async acceptInvitation(
    @Body() dto: SignupInvitationDto,
    @Req() req: Request,
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return await this.authService.acceptInvitation(dto, ip, userAgent);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(LoginDtoSchema))
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const result = await this.authService.login(dto, ip, userAgent);

    if ('refreshToken' in result && result.refreshToken) {
      // Set rotating refresh token in httpOnly, secure, sameSite cookie (FR-AUTH-003)
      res.cookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        path: '/auth/refresh',
      });
    }

    return result;
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Body('refreshToken') bodyRefreshToken: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = req.cookies?.refreshToken || bodyRefreshToken;
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const result = await this.authService.refresh(token, ip, userAgent);

    // Set rotated refresh token
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/auth/refresh',
    });

    return result;
  }

  @Post('2fa/setup')
  @HttpCode(HttpStatus.OK)
  async setup2fa(@CurrentUser() user: AuthenticatedUser) {
    return await this.authService.setup2fa(user);
  }

  @Post('2fa/verify')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(Verify2faDtoSchema))
  async verify2fa(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: Verify2faDto,
    @Req() req: Request,
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return await this.authService.verifyAndEnable2fa(user, dto.code, ip, userAgent);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Body('sessionId') sessionId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const effectiveSessionId = sessionId || req.cookies?.sessionId || 'default';
    const result = await this.authService.logout(effectiveSessionId, user, ip, userAgent);

    res.clearCookie('refreshToken', { path: '/auth/refresh' });
    return result;
  }
}
