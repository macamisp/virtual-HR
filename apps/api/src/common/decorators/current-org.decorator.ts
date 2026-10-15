import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentOrg = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.orgId || request.user?.orgId;
  },
);
