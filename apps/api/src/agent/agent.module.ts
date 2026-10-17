import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.ts';
import { AttendanceModule } from '../attendance/attendance.module.ts';
import { AgentController } from './agent.controller.ts';
import { AgentService } from './agent.service.ts';

/** Desktop agent (FR-ATT-011, FR-ATT-012; ADR 018). */
@Module({
  imports: [AuthModule, AttendanceModule],
  controllers: [AgentController],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}
