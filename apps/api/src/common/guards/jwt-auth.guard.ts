import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.ts';
import type { JwtPayload, AuthenticatedUser } from '../../../../../packages/shared/src/index.ts';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private jwtSecret: string;

  constructor(private reflector: Reflector) {
    this.jwtSecret = process.env.JWT_SECRET || 'super-secret-jwt-access-key-change-in-production-min-32-chars';
  }

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromRequest(request);

    if (!token) {
      throw new UnauthorizedException('Authentication token missing');
    }

    try {
      const decoded = jwt.verify(token, this.jwtSecret) as JwtPayload;
      const authenticatedUser: AuthenticatedUser = {
        id: decoded.sub,
        orgId: decoded.orgId,
        email: decoded.email,
        role: decoded.role,
        displayName: decoded.displayName,
        teamId: decoded.teamId,
      };
      request.user = authenticatedUser;
      request.orgId = decoded.orgId;
      return true;
    } catch (_err: any) {
      console.error('JwtAuthGuard verification failed:', _err?.message, 'Token received:', token ? token.slice(0, 15) + '...' : 'none');
      throw new UnauthorizedException('Invalid or expired authentication token');
    }
  }

  private extractTokenFromRequest(request: any): string | null {
    if (request.headers?.authorization) {
      const [type, token] = request.headers.authorization.split(' ');
      if (type === 'Bearer' && token) {
        return token;
      }
    }
    if (request.cookies?.accessToken) {
      return request.cookies.accessToken;
    }
    return null;
  }
}
