import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequireAnyPermission, RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/auth/types.ts';
import {
  ApproveTimesheetDtoSchema,
  ProjectRateDtoSchema,
  RateProfileDtoSchema,
  RejectTimesheetDtoSchema,
  ReopenTimesheetDtoSchema,
  SubmitTimesheetDtoSchema,
  TimesheetListQuerySchema,
  TimesheetNotesDtoSchema,
  TimesheetReportQuerySchema,
  TimesheetSettingsDtoSchema,
} from '../../../../packages/shared/src/timesheets/types.ts';
import type {
  ApproveTimesheetDto,
  ProjectRateDto,
  RateProfileDto,
  RejectTimesheetDto,
  ReopenTimesheetDto,
  SubmitTimesheetDto,
  TimesheetListQuery,
  TimesheetNotesDto,
  TimesheetReportQuery,
  TimesheetSettingsDto,
} from '../../../../packages/shared/src/timesheets/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { TimesheetsService } from './timesheets.service.ts';
import { RatesService } from './rates.service.ts';
import { TimesheetReportsService } from './reports.service.ts';

const id = new ParseUUIDPipe({ version: '4' });
const READERS = [Permission.TIMESHEETS_USE, Permission.TIMESHEETS_READ_ALL] as const;

/**
 * FR-TS-002/006/009/011. Reading needs timesheets.use (own, plus team when approving) or
 * timesheets.read.all (Finance/Auditor, read-only); the service applies row visibility.
 */
@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TimesheetsController {
  constructor(
    private readonly timesheets: TimesheetsService,
    private readonly rates: RatesService,
    private readonly reports: TimesheetReportsService,
  ) {}

  @Get('timesheets')
  @RequireAnyPermission(...READERS)
  list(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(TimesheetListQuerySchema)) q: TimesheetListQuery) {
    return this.timesheets.list(user, q);
  }

  @Get('timesheets/current')
  @RequirePermissions(Permission.TIMESHEETS_USE)
  current(@CurrentUser() user: AuthenticatedUser) {
    return this.timesheets.current(user);
  }

  @Get('timesheets/settings')
  @RequireAnyPermission(...READERS)
  settings(@CurrentUser() user: AuthenticatedUser) {
    return this.rates.settings(user);
  }

  @Put('timesheets/settings')
  @RequirePermissions(Permission.ORG_MANAGE)
  updateSettings(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(TimesheetSettingsDtoSchema)) dto: TimesheetSettingsDto) {
    return this.rates.updateSettings(user, dto);
  }

  /** FR-TS-013: JSON for the page, or a CSV / XLSX download (audited). Declared before :id. */
  @Get('timesheets/reports')
  @RequireAnyPermission(Permission.TIMESHEETS_APPROVE_TEAM, Permission.TIMESHEETS_APPROVE_ALL, Permission.TIMESHEETS_READ_ALL)
  @Header('Cache-Control', 'no-store')
  async report(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(TimesheetReportQuerySchema)) q: TimesheetReportQuery) {
    if (q.format === 'json') return await this.reports.report(user, q);
    const file = await this.reports.export(user, q);
    const body = typeof file.body === 'string' ? Buffer.from(file.body, 'utf8') : file.body;
    return new StreamableFile(body, { type: file.contentType, disposition: `attachment; filename="${file.filename}"`, length: body.length });
  }

  @Get('timesheets/:id')
  @RequireAnyPermission(...READERS)
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id', id) sheetId: string) {
    return this.timesheets.detail(user, sheetId);
  }

  @Patch('timesheets/:id')
  @RequirePermissions(Permission.TIMESHEETS_USE)
  notes(@CurrentUser() user: AuthenticatedUser, @Param('id', id) sheetId: string, @Body(new ZodValidationPipe(TimesheetNotesDtoSchema)) dto: TimesheetNotesDto) {
    return this.timesheets.updateNotes(user, sheetId, dto);
  }

  @Post('timesheets/:id/submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.TIMESHEETS_USE)
  submit(@CurrentUser() user: AuthenticatedUser, @Param('id', id) sheetId: string, @Body(new ZodValidationPipe(SubmitTimesheetDtoSchema)) dto: SubmitTimesheetDto) {
    return this.timesheets.submit(user, sheetId, dto);
  }

  @Post('timesheets/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(Permission.TIMESHEETS_APPROVE_TEAM, Permission.TIMESHEETS_APPROVE_ALL)
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id', id) sheetId: string, @Body(new ZodValidationPipe(ApproveTimesheetDtoSchema)) dto: ApproveTimesheetDto) {
    return this.timesheets.approve(user, sheetId, dto);
  }

  @Post('timesheets/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(Permission.TIMESHEETS_APPROVE_TEAM, Permission.TIMESHEETS_APPROVE_ALL)
  reject(@CurrentUser() user: AuthenticatedUser, @Param('id', id) sheetId: string, @Body(new ZodValidationPipe(RejectTimesheetDtoSchema)) dto: RejectTimesheetDto) {
    return this.timesheets.reject(user, sheetId, dto);
  }

  @Post('timesheets/:id/reopen')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.TIMESHEET_REOPEN)
  reopen(@CurrentUser() user: AuthenticatedUser, @Param('id', id) sheetId: string, @Body(new ZodValidationPipe(ReopenTimesheetDtoSchema)) dto: ReopenTimesheetDto) {
    return this.timesheets.reopen(user, sheetId, dto);
  }

  // ---- rates (FR-TS-009)

  @Get('rates')
  @RequireAnyPermission(Permission.RATES_MANAGE, Permission.TIMESHEETS_READ_ALL)
  listRates(@CurrentUser() user: AuthenticatedUser) {
    return this.rates.list(user);
  }

  @Put('rates/:userId')
  @RequirePermissions(Permission.RATES_MANAGE)
  setRate(@CurrentUser() user: AuthenticatedUser, @Param('userId', id) userId: string, @Body(new ZodValidationPipe(RateProfileDtoSchema)) dto: RateProfileDto) {
    return this.rates.upsert(user, userId, dto);
  }

  @Put('projects/:projectId/members/:userId/rate')
  @RequirePermissions(Permission.RATES_MANAGE)
  setProjectRate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', id) projectId: string,
    @Param('userId', id) userId: string,
    @Body(new ZodValidationPipe(ProjectRateDtoSchema)) dto: ProjectRateDto,
  ) {
    return this.rates.setProjectRate(user, projectId, userId, dto);
  }
}
