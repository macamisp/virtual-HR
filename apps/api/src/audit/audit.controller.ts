import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuditService } from './audit.service.ts';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentOrg } from '../common/decorators/current-org.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { Permission } from '../../../../packages/shared/src/index.ts';

@Controller('audit-logs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @RequirePermissions(Permission.AUDIT_READ)
  async getAuditLogs(
    @CurrentOrg() orgId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const l = limit ? parseInt(limit, 10) : 50;
    const o = offset ? parseInt(offset, 10) : 0;
    return await this.auditService.getAuditLogs(orgId, l, o);
  }

  @Get('verify')
  @RequirePermissions(Permission.AUDIT_READ)
  async verifyChain(@CurrentOrg() orgId: string) {
    const valid = await this.auditService.verifyChain(orgId);
    return { valid };
  }
}
