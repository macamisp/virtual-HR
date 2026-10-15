import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller.ts';
import { AttendanceGateway } from './attendance.gateway.ts';
import { AttendanceService } from './attendance.service.ts';
import { PostgresAttendanceRepository } from './attendance-repository.ts';
import { PrismaService } from '../common/prisma.service.ts';
import { loadAttendancePolicy } from '../admin/policy-store.ts';
import { SystemClock } from '../../../../packages/shared/src/index.ts';

@Module({
  controllers: [AttendanceController],
  providers: [
    PrismaService,
    {
      provide: PostgresAttendanceRepository,
      useFactory: () => {
        return new PostgresAttendanceRepository();
      },
    },
    {
      provide: AttendanceService,
      useFactory: (repo: PostgresAttendanceRepository, prisma: PrismaService) => {
        const service = new AttendanceService(undefined, new SystemClock(), repo);
        // FR-ADM-001: thresholds per organisation (cached 30 s; the admin API invalidates it).
        service.setPolicyProvider((orgId) => loadAttendancePolicy(prisma, orgId));
        return service;
      },
      inject: [PostgresAttendanceRepository, PrismaService],
    },
    AttendanceGateway,
  ],
  exports: [AttendanceService, AttendanceGateway, PostgresAttendanceRepository],
})
export class AttendanceModule {}
