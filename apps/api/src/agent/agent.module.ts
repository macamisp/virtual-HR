import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { AuthModule } from '../auth/auth.module.ts';
import { AttendanceModule } from '../attendance/attendance.module.ts';
import { AgentController } from './agent.controller.ts';
import { AgentService } from './agent.service.ts';

/** Desktop agent (FR-ATT-011, FR-ATT-012; ADR 018). */
@Module({
  imports: [AuthModule, AttendanceModule],
  controllers: [AgentController],
  providers: [PrismaService, AgentService],
  exports: [AgentService],
})
export class AgentModule {}
