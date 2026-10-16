import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller.ts';
import { AttendanceGateway } from './attendance.gateway.ts';
import { AttendanceService } from './attendance.service.ts';
import { PostgresAttendanceRepository } from './attendance-repository.ts';
import { AttendanceFlagsService } from './attendance-flags.service.ts';
import { AttendanceFlagsController } from './attendance-flags.controller.ts';
import { PrismaService } from '../common/prisma.service.ts';
import { loadAttendancePolicy } from '../admin/policy-store.ts';
import { SystemClock } from '../../../../packages/shared/src/index.ts';
import { coordinationEnabled, sharedRedis } from '../common/coordination.ts';
import { RedisLock } from '../common/redis-lock.ts';

@Module({
  controllers: [AttendanceController, AttendanceFlagsController],
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
      useFactory: (repo: PostgresAttendanceRepository, prisma: PrismaService, flags: AttendanceFlagsService) => {
        const service = new AttendanceService(undefined, new SystemClock(), repo);
        // FR-ADM-001: thresholds per organisation (cached 30 s; the admin API invalidates it).
        service.setPolicyProvider((orgId) => loadAttendancePolicy(prisma, orgId));
        // ADR 019: review flags (never change recorded time).
        service.setFlagSink(flags);
        // ADR 020: serialise a person's attendance updates across API tasks.
        if (coordinationEnabled()) service.setLockProvider(new RedisLock(sharedRedis()));
        return service;
      },
      inject: [PostgresAttendanceRepository, PrismaService, AttendanceFlagsService],
    },
    AttendanceFlagsService,
    AttendanceGateway,
  ],
  exports: [AttendanceService, AttendanceGateway, PostgresAttendanceRepository, AttendanceFlagsService],
})
export class AttendanceModule {}
