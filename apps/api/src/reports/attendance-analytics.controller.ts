/**
 * HR attendance analytics (FR-REP-009, ADR 059).
 *
 *   GET /reports/attendance-analytics                 reports.team or reports.all, scoped; CSV, XLSX
 *                                                     or PDF also need attendance.export (audited)
 *   GET /reports/attendance-analytics/people/:userId  reports.team or reports.all, and
 *                                                     attendance.read.all, or .team for someone in
 *                                                     scope; anyone else is 404
 *   GET /attendance/me/analytics                      attendance.read.own: one's own detail
 *
 * Employees export their own records through the existing personal data export (Privacy).
 */
import { Controller, Get, Header, Param, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequireAnyPermission, RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { AttendanceAnalyticsQuerySchema, PersonAnalyticsQuerySchema } from '../../../../packages/shared/src/reports/attendance-analytics.ts';
import type { AttendanceAnalytics, AttendanceAnalyticsQuery, PersonAnalytics, PersonAnalyticsQuery } from '../../../../packages/shared/src/reports/attendance-analytics.ts';
import { AttendanceAnalyticsService } from './attendance-analytics.service.ts';

@Controller('reports/attendance-analytics')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequireAnyPermission(Permission.REPORTS_TEAM, Permission.REPORTS_ALL)
export class AttendanceAnalyticsController {
  constructor(private readonly analytics: AttendanceAnalyticsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async report(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(AttendanceAnalyticsQuerySchema)) q: AttendanceAnalyticsQuery): Promise<AttendanceAnalytics | StreamableFile> {
    if (q.format === 'json') return await this.analytics.report(user, q);
    const f = await this.analytics.export(user, { ...q, format: q.format });
    const body = typeof f.body === 'string' ? Buffer.from(f.body, 'utf8') : f.body;
    return new StreamableFile(body, { type: f.contentType, disposition: `attachment; filename="${f.filename}"`, length: body.length });
  }

  @Get('people/:userId')
  @Header('Cache-Control', 'no-store')
  async person(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Query(new ZodValidationPipe(PersonAnalyticsQuerySchema)) q: PersonAnalyticsQuery,
  ): Promise<PersonAnalytics> {
    return await this.analytics.person(user, userId, q);
  }
}

@Controller('attendance')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MyAttendanceAnalyticsController {
  constructor(private readonly analytics: AttendanceAnalyticsService) {}

  @Get('me/analytics')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(Permission.ATTENDANCE_READ_OWN)
  async mine(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(PersonAnalyticsQuerySchema)) q: PersonAnalyticsQuery): Promise<PersonAnalytics> {
    return await this.analytics.person(user, user.id, q);
  }
}
