import { Body, Controller, Get, Header, Put, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequireAnyPermission, RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import {
  AttendanceReportQuerySchema,
  ComplianceQuerySchema,
  ComplianceRequirementsDtoSchema,
  CostReportQuerySchema,
  TaskReportQuerySchema,
} from '../../../../packages/shared/src/reports/types.ts';
import type { AttendanceReportQuery, ComplianceQuery, ComplianceRequirementsDto, CostReportQuery, TaskReportQuery } from '../../../../packages/shared/src/reports/types.ts';
import { DashboardService } from './dashboard.service.ts';
import { ReportsService } from './reports.service.ts';
import { ComplianceService } from './compliance.service.ts';
import type { ExportFile } from './report-scope.ts';

type Exportable = 'csv' | 'xlsx' | 'pdf';

function file(f: ExportFile): StreamableFile {
  const body = typeof f.body === 'string' ? Buffer.from(f.body, 'utf8') : f.body;
  return new StreamableFile(body, { type: f.contentType, disposition: `attachment; filename="${f.filename}"`, length: body.length });
}

/** FR-REP-001..006, 008 (ADR 013). Every route needs reports.team or reports.all; the data is scoped inside. */
@Controller('reports')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequireAnyPermission(Permission.REPORTS_TEAM, Permission.REPORTS_ALL)
export class ReportsController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly reports: ReportsService,
    private readonly compliance: ComplianceService,
  ) {}

  @Get('dashboard')
  @Header('Cache-Control', 'no-store')
  dashboard(@CurrentUser() user: AuthenticatedUser) {
    return this.dashboardService.dashboard(user);
  }

  @Get('attendance')
  @Header('Cache-Control', 'no-store')
  async attendance(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(AttendanceReportQuerySchema)) q: AttendanceReportQuery) {
    if (q.format === 'json') return await this.reports.attendance(user, q);
    return file(await this.reports.exportAttendance(user, { ...q, format: q.format as Exportable }));
  }

  @Get('hours-cost')
  @Header('Cache-Control', 'no-store')
  async cost(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(CostReportQuerySchema)) q: CostReportQuery) {
    if (q.format === 'json') return await this.reports.cost(user, q);
    return file(await this.reports.exportCost(user, { ...q, format: q.format as Exportable }));
  }

  @Get('tasks')
  @Header('Cache-Control', 'no-store')
  async tasks(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(TaskReportQuerySchema)) q: TaskReportQuery) {
    if (q.format === 'json') return await this.reports.tasks(user, q);
    return file(await this.reports.exportTasks(user, { ...q, format: q.format as Exportable }));
  }

  @Get('compliance')
  @Header('Cache-Control', 'no-store')
  async complianceReport(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(ComplianceQuerySchema)) q: ComplianceQuery) {
    if (q.format === 'json') return await this.compliance.report(user, q);
    return file(await this.compliance.export(user, { ...q, format: q.format as Exportable }));
  }

  @Get('compliance/requirements')
  requirements(@CurrentUser() user: AuthenticatedUser) {
    return this.compliance.requirements(user);
  }
}

/** Changing what each role must have on file is an organisation setting. */
@Controller('reports')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ComplianceRequirementsController {
  constructor(private readonly compliance: ComplianceService) {}

  @Put('compliance/requirements')
  @RequirePermissions(Permission.ORG_MANAGE)
  update(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(ComplianceRequirementsDtoSchema)) dto: ComplianceRequirementsDto) {
    return this.compliance.updateRequirements(user, dto);
  }
}
