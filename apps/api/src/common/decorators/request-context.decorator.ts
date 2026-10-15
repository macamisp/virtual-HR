import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** Who is calling from where, for access logs (FR-DOC-012). Never contains secrets. */
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export const ReqContext = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestContext => {
  const req = ctx.switchToHttp().getRequest<{ ip?: string; socket?: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined> }>();
  const ua = req.headers['user-agent'];
  return {
    ip: req.ip || req.socket?.remoteAddress || null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 400) : null,
  };
});
