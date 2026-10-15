import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.ts';
import { ALLOW_MFA_ENROLLMENT_KEY } from '../decorators/allow-mfa-enrollment.decorator.ts';
import { verifyToken } from '../../auth/tokens.ts';
import type { AuthenticatedUser, TokenType } from '../../../../../packages/shared/src/index.ts';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }
    const allowEnrollment = this.reflector.getAllAndOverride<boolean>(ALLOW_MFA_ENROLLMENT_KEY, targets);
    const allowed: TokenType[] = allowEnrollment ? ['access', 'mfa_enroll'] : ['access'];

    const request = context.switchToHttp().getRequest();
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('Authentication token missing');
    }

    try {
      const { payload, tokenType } = verifyToken(token, allowed);
      const authenticatedUser: AuthenticatedUser = {
        id: payload.sub,
        orgId: payload.orgId,
        email: payload.email,
        role: payload.role,
        displayName: payload.displayName,
        teamId: payload.teamId,
        sessionId: payload.sid,
        tokenType,
      };
      request.user = authenticatedUser;
      request.orgId = payload.orgId;
      return true;
    } catch {
      // Never log the token or its prefix (AGENTS.md security rules).
      throw new UnauthorizedException('Invalid or expired authentication token');
    }
  }

  /**
   * Access tokens are accepted only as Bearer headers. Cookie-borne access tokens are
   * deliberately unsupported: ambient credentials would make every route CSRF-able.
   */
  private extractBearerToken(request: { headers?: Record<string, string | undefined> }): string | null {
    const header = request.headers?.authorization;
    if (!header) return null;
    const [type, token] = header.split(' ');
    return type === 'Bearer' && token ? token : null;
  }
}
