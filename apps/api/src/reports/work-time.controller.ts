import { Controller, Get, Header, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequireAnyPermission } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { WorkTimeReportQuerySchema } from '../../../../packages/shared/src/reports/types.ts';
import type { WorkTimeReportQuery } from '../../../../packages/shared/src/reports/types.ts';
import { WorkTimeService } from './work-time.service.ts';

/**
 * ADR 049 §5 (FR-WT-019..021). Anyone who keeps time sees their own figures; others need team or
 * organisation report access, and the service limits them to people in that scope.
 */
@Controller('reports/work-time')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequireAnyPermission(Permission.TIMESHEETS_USE, Permission.REPORTS_TEAM, Permission.REPORTS_ALL)
export class WorkTimeController {
  constructor(private readonly workTime: WorkTimeService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async report(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(WorkTimeReportQuerySchema)) q: WorkTimeReportQuery) {
    if (q.format === 'json') return await this.workTime.report(user, q);
    const f = await this.workTime.export(user, { ...q, format: q.format });
    const body = typeof f.body === 'string' ? Buffer.from(f.body, 'utf8') : f.body;
    return new StreamableFile(body, { type: f.contentType, disposition: `attachment; filename="${f.filename}"`, length: body.length });
  }
}
