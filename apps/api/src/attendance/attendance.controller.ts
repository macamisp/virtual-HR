import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  UsePipes,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AttendanceService } from './attendance.service.ts';
import { AttendanceGateway } from './attendance.gateway.ts';
import { InvalidTransitionError } from './attendance-state-machine.ts';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import {
  Permission,
  CorrectionRequestDtoSchema,
  ReviewCorrectionDtoSchema,
  AttendanceConsentDtoSchema,
  AttendanceExportQuerySchema,
  MyDaysQuerySchema,
} from '../../../../packages/shared/src/index.ts';
import type {
  AuthenticatedUser,
  CorrectionRequestDto,
  ReviewCorrectionDto,
  AttendanceConsentDto,
  AttendanceExportQuery,
  MyDaysQuery,
  BreakResult,
} from '../../../../packages/shared/src/index.ts';

/**
 * The attendance service throws plain Errors (it is framework-free). Map the known ones
 * to HTTP status codes instead of letting them surface as 500s.
 */
function toHttpError(err: unknown): unknown {
  if (err instanceof InvalidTransitionError) return new ConflictException(err.message);
  if (!(err instanceof Error)) return err;
  if (/cannot approve their own|Unauthorized to review|Insufficient permissions|has no assigned team|permission denied/i.test(err.message)) {
    return new ForbiddenException(err.message);
  }
  if (/not found/i.test(err.message)) return new NotFoundException(err.message);
  if (/must be (after|before)|Invalid|overlap|future|exceeds maximum allowed age/i.test(err.message)) return new BadRequestException(err.message);
  return err;
}

async function mapErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toHttpError(err);
  }
}

@Controller('attendance')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AttendanceController {
  constructor(
    private readonly attendanceService: AttendanceService,
    private readonly gateway: AttendanceGateway,
  ) {}

  /** GET /attendance/me/today: state, "tracking since" and today's totals (server clock). */
  @Get('me/today')
  @RequirePermissions(Permission.ATTENDANCE_READ_OWN)
  async getMyToday(@CurrentUser() user: AuthenticatedUser) {
    return await this.attendanceService.getMyToday(user.orgId, user.id);
  }

  /** GET /attendance/me/days?from&to: daily totals for the caller (FR-ATT-015). */
  @Get('me/days')
  @RequirePermissions(Permission.ATTENDANCE_READ_OWN)
  async getMyDays(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(MyDaysQuerySchema)) query: MyDaysQuery,
  ) {
    return await this.attendanceService.getMyDays(user.orgId, user.id, query.from, query.to);
  }

  /** GET /attendance/me/corrections: the caller's own correction requests. */
  @Get('me/corrections')
  @RequirePermissions(Permission.ATTENDANCE_CORRECTIONS_CREATE)
  async getMyCorrections(@CurrentUser() user: AuthenticatedUser) {
    return await this.attendanceService.getMyCorrections(user.orgId, user.id);
  }

  /** GET /attendance/consent: has the caller accepted the current monitoring notice? (FR-AUD-004) */
  @Get('consent')
  async getConsent(@CurrentUser() user: AuthenticatedUser) {
    return await this.attendanceService.getConsentStatus(user.orgId, user.id);
  }

  /** POST /attendance/break/start (FR-ATT-007). 409 if there is no open session or already on break. */
  @Post('break/start')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ATTENDANCE_READ_OWN)
  async startBreak(@CurrentUser() user: AuthenticatedUser): Promise<BreakResult> {
    const result = await mapErrors(() => this.attendanceService.startBreak(user.id, undefined, user.orgId));
    if (!result) throw new ConflictException('No open attendance session');
    this.gateway.broadcastTransition(user.orgId, user.id, result);
    return { state: result.currentState, totals: this.attendanceService.totalsAsOf(result.session) };
  }

  /** POST /attendance/break/end (FR-ATT-007). 409 if not on break. */
  @Post('break/end')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ATTENDANCE_READ_OWN)
  async endBreak(@CurrentUser() user: AuthenticatedUser): Promise<BreakResult> {
    const result = await mapErrors(() => this.attendanceService.endBreak(user.id, undefined, user.orgId));
    if (!result) throw new ConflictException('No open attendance session');
    this.gateway.broadcastTransition(user.orgId, user.id, result);
    return { state: result.currentState, totals: this.attendanceService.totalsAsOf(result.session) };
  }

  /** GET /attendance/corrections: pending requests the caller may review (FR-ATT-013). */
  @Get('corrections')
  @RequirePermissions(Permission.ATTENDANCE_CORRECTIONS_REVIEW)
  async getCorrectionQueue(@CurrentUser() user: AuthenticatedUser) {
    return await this.attendanceService.getCorrectionQueue({
      orgId: user.orgId,
      callerId: user.id,
      callerRole: user.role,
      callerPermissions: user.permissions,
    });
  }

  /**
   * FR-ATT-016: Live Attendance Board
   * Scope by role: Team lead sees own team only; HR/Admin sees all.
   */
  @Get('live')
  @RequirePermissions(Permission.ATTENDANCE_READ_TEAM)
  async getLiveBoard(
    @CurrentUser() user: AuthenticatedUser,
    @Query('teamId') teamId?: string,
  ) {
    return await mapErrors(() => this.attendanceService.getLiveBoard({
      orgId: user.orgId,
      callerUserId: user.id,
      callerRole: user.role,
      callerPermissions: user.permissions,
      callerTeamId: user.teamId,
      filterTeamId: teamId,
    }));
  }

  /**
   * FR-ATT-020: Transparency
   * Returns worker's own raw events and plain-language collection policy.
   */
  @Get('me/events')
  async getMyEvents(
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return await this.attendanceService.getTransparencyEvents({
      orgId: user.orgId,
      userId: user.id,
    });
  }

  /**
   * FR-AUD-004 & FR-ATT-020: Monitoring Consent
   * Records acceptance of monitoring notice version.
   */
  @Post('consent')
  @UsePipes(new ZodValidationPipe(AttendanceConsentDtoSchema))
  async recordConsent(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AttendanceConsentDto,
    @Req() req: Request,
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return await this.attendanceService.recordMonitoringConsent({
      orgId: user.orgId,
      userId: user.id,
      noticeVersion: dto.noticeVersion,
      ip,
      userAgent,
    });
  }

  /**
   * FR-ATT-013: Attendance Corrections (Request)
   */
  @Post('corrections')
  @RequirePermissions(Permission.ATTENDANCE_CORRECTIONS_CREATE)
  @UsePipes(new ZodValidationPipe(CorrectionRequestDtoSchema))
  async requestCorrection(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CorrectionRequestDto,
  ) {
    const reqIn = new Date(dto.requestedIn);
    const reqOut = new Date(dto.requestedOut);

    if (isNaN(reqIn.getTime()) || isNaN(reqOut.getTime())) {
      throw new BadRequestException('Invalid requestedIn or requestedOut timestamps');
    }

    return await mapErrors(() => this.attendanceService.requestCorrection({
      orgId: user.orgId,
      userId: user.id,
      sessionId: dto.sessionId,
      requestedIn: reqIn,
      requestedOut: reqOut,
      reason: dto.reason,
      evidenceDocumentId: dto.evidenceDocumentId,
    }));
  }

  /**
   * FR-ATT-013: Attendance Corrections (Review)
   * Only user's manager or HR may review; user cannot approve own request.
   */
  @Patch('corrections/:id')
  @RequirePermissions(Permission.ATTENDANCE_CORRECTIONS_REVIEW)
  @UsePipes(new ZodValidationPipe(ReviewCorrectionDtoSchema))
  async reviewCorrection(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') correctionId: string,
    @Body() dto: ReviewCorrectionDto,
  ) {
    return await mapErrors(() => this.attendanceService.reviewCorrection({
      orgId: user.orgId,
      correctionId,
      reviewerId: user.id,
      reviewerRole: user.role,
      reviewerPermissions: user.permissions,
      approved: dto.status === 'APPROVED',
      reviewNote: dto.reviewNote,
    }));
  }

  /**
   * FR-ATT-019: Export attendance data (CSV / XLSX)
   * Hardened against CSV formula injection.
   */
  @Get('export')
  @RequirePermissions(Permission.ATTENDANCE_EXPORT)
  @UsePipes(new ZodValidationPipe(AttendanceExportQuerySchema))
  async exportAttendance(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AttendanceExportQuery,
    @Res() res: Response,
  ) {
    const filter = {
      startDate: query.startDate,
      endDate: query.endDate,
      teamId: query.teamId,
      userId: query.userId,
    };

    try {
      if (query.format === 'xlsx') {
        const buffer = await this.attendanceService.exportAttendanceXlsx({
          orgId: user.orgId,
          callerUserId: user.id,
          callerRole: user.role,
          callerPermissions: user.permissions,
          filter,
        });

        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="attendance-${query.startDate}-to-${query.endDate}.xlsx"`,
        );
        return res.send(buffer);
      } else {
        const csv = await this.attendanceService.exportAttendanceCsv({
          orgId: user.orgId,
          callerUserId: user.id,
          callerRole: user.role,
          callerPermissions: user.permissions,
          filter,
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="attendance-${query.startDate}-to-${query.endDate}.csv"`,
        );
        return res.send(csv);
      }
    } catch (err) {
      throw toHttpError(err);
    }
  }
}
