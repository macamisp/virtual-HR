import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.ts';
import { NotificationsModule } from '../notifications/notifications.module.ts';
import { LeaveController } from './leave.controller.ts';
import { LeaveService } from './leave.service.ts';

/** FR-ORG-010, FR-ORG-011 (ADR 027): leave requests and the holiday calendar; providers come from AttendanceModule. */
@Module({
  imports: [AttendanceModule, NotificationsModule],
  controllers: [LeaveController],
  providers: [LeaveService],
})
export class LeaveModule {}
