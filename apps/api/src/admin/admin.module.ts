import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.ts';
import { AgentModule } from '../agent/agent.module.ts';
import { MailModule } from '../common/mail.module.ts';
import { AdminController } from './admin.controller.ts';
import { AdminService } from './admin.service.ts';
import { ConsentsService } from './consents.service.ts';
import { OrgProfileController } from './org-profile.controller.ts';
import { OwnershipService } from './ownership.service.ts';

@Module({
  imports: [AttendanceModule, AgentModule, MailModule],
  controllers: [AdminController, OrgProfileController],
  providers: [AdminService, ConsentsService, OwnershipService],
})
export class AdminModule {}
