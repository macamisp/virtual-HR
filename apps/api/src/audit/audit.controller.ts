import { Controller, Get, Header, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { AuditService } from './audit.service.ts';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentOrg } from '../common/decorators/current-org.decorator.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { AuditQuerySchema } from '../../../../packages/shared/src/admin/types.ts';
import type { AuditQuery } from '../../../../packages/shared/src/admin/types.ts';

/** FR-AUD-001 / FR-ADM-006. Read-only: nothing in the API can change or delete an entry. */
@Controller('audit-logs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @RequirePermissions(Permission.AUDIT_READ)
  async getAuditLogs(@CurrentOrg() orgId: string, @Query(new ZodValidationPipe(AuditQuerySchema)) q: AuditQuery) {
    return await this.auditService.getAuditLogs(orgId, q);
  }

  @Get('facets')
  @RequirePermissions(Permission.AUDIT_READ)
  async facets(@CurrentOrg() orgId: string) {
    return await this.auditService.facets(orgId);
  }

  @Get('export')
  @RequirePermissions(Permission.AUDIT_READ)
  @Header('Cache-Control', 'no-store')
  async export(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(AuditQuerySchema)) q: AuditQuery) {
    const file = await this.auditService.exportCsv(user, q);
    const body = Buffer.from(file.body, 'utf8');
    return new StreamableFile(body, { type: 'text/csv; charset=utf-8', disposition: `attachment; filename="${file.filename}"`, length: body.length });
  }

  @Get('verify')
  @RequirePermissions(Permission.AUDIT_READ)
  async verifyChain(@CurrentOrg() orgId: string) {
    return await this.auditService.verify(orgId);
  }
}
