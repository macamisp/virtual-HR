import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.ts';
import { OrgController } from './org.controller.ts';
import { OrgService } from './org.service.ts';
import { SchedulesController } from './schedules.controller.ts';
import { SchedulesService } from './schedules.service.ts';

/** FR-ORG-006 (ADR 031): teams and the manager hierarchy. FR-ORG-005 (ADR 032): work schedules. */
@Module({
  imports: [AttendanceModule],
  controllers: [OrgController, SchedulesController],
  providers: [OrgService, SchedulesService],
})
export class OrgModule {}
