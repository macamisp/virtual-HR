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
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AttendanceService } from './attendance.service.ts';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { CurrentOrg } from '../common/decorators/current-org.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import {
  Permission,
  CorrectionRequestDtoSchema,
  ReviewCorrectionDtoSchema,
  AttendanceConsentDtoSchema,
  AttendanceExportQuerySchema,
} from '../../../../packages/shared/src/index.ts';
import type {
  AuthenticatedUser,
  CorrectionRequestDto,
  ReviewCorrectionDto,
  AttendanceConsentDto,
  AttendanceExportQuery,
} from '../../../../packages/shared/src/index.ts';

@Controller('attendance')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  /**
   * FR-ATT-016: Live Attendance Board
   * Scope by role: Team lead sees own team only; HR/Admin sees all.
   */
  @Get('live')
  async getLiveBoard(
    @CurrentUser() user: AuthenticatedUser,
    @Query('teamId') teamId?: string,
  ) {
    return await this.attendanceService.getLiveBoard({
      orgId: user.orgId,
      callerUserId: user.id,
      callerRole: user.role,
      callerTeamId: user.teamId,
      filterTeamId: teamId,
    });
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

    return await this.attendanceService.requestCorrection({
      orgId: user.orgId,
      userId: user.id,
      sessionId: dto.sessionId,
      requestedIn: reqIn,
      requestedOut: reqOut,
      reason: dto.reason,
      evidenceDocumentId: dto.evidenceDocumentId,
    });
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
    return await this.attendanceService.reviewCorrection({
      orgId: user.orgId,
      correctionId,
      reviewerId: user.id,
      reviewerRole: user.role,
      approved: dto.status === 'APPROVED',
      reviewNote: dto.reviewNote,
    });
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
          filter,
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="attendance-${query.startDate}-to-${query.endDate}.csv"`,
        );
        return res.send(csv);
      }
    } catch (err: any) {
      console.error('DEBUG: exportAttendance caught error:', err?.message, err?.stack);
      throw err;
    }
  }
}
