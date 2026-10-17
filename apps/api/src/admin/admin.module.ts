import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.ts';
import { AgentModule } from '../agent/agent.module.ts';
import { AdminController } from './admin.controller.ts';
import { AdminService } from './admin.service.ts';
import { ConsentsService } from './consents.service.ts';

@Module({
  imports: [AttendanceModule, AgentModule],
  controllers: [AdminController],
  providers: [AdminService, ConsentsService],
})
export class AdminModule {}
