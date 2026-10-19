import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.ts';
import { OrgController } from './org.controller.ts';
import { OrgService } from './org.service.ts';
import { SchedulesController } from './schedules.controller.ts';
import { SchedulesService } from './schedules.service.ts';
import { MySubcontractorProfileController, SubcontractorsController } from './subcontractors.controller.ts';
import { SubcontractorsService } from './subcontractors.service.ts';
import { KEY_PROVIDER, keyProviderFromEnv } from '../documents/crypto.ts';

/** FR-ORG-006 (ADR 031): teams and the manager hierarchy. FR-ORG-005 (ADR 032): work schedules. FR-ORG-002 (ADR 033): subcontractor profiles. */
@Module({
  imports: [AttendanceModule],
  controllers: [OrgController, SchedulesController, MySubcontractorProfileController, SubcontractorsController],
  providers: [OrgService, SchedulesService, SubcontractorsService, { provide: KEY_PROVIDER, useFactory: () => keyProviderFromEnv() }],
})
export class OrgModule {}
