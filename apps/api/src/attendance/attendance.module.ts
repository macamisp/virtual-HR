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
import { PgHolidayProvider, PgLeaveProvider } from './leave-providers.ts';

@Module({
  controllers: [AttendanceController, AttendanceFlagsController],
  providers: [
    {
      provide: PostgresAttendanceRepository,
      useFactory: () => {
        return new PostgresAttendanceRepository();
      },
    },
    {
      provide: AttendanceService,
      useFactory: (repo: PostgresAttendanceRepository, prisma: PrismaService, flags: AttendanceFlagsService, holidays: PgHolidayProvider, leave: PgLeaveProvider) => {
        // FR-ATT-022 (ADR 027): approved leave and public holidays from the database.
        const service = new AttendanceService(undefined, new SystemClock(), repo, undefined, holidays, leave);
        // FR-ADM-001: thresholds per organisation (cached 30 s; the admin API invalidates it).
        service.setPolicyProvider((orgId) => loadAttendancePolicy(prisma, orgId));
        // ADR 019: review flags (never change recorded time).
        service.setFlagSink(flags);
        // ADR 020: serialise a person's attendance updates across API tasks.
        if (coordinationEnabled()) service.setLockProvider(new RedisLock(sharedRedis()));
        return service;
      },
      inject: [PostgresAttendanceRepository, PrismaService, AttendanceFlagsService, PgHolidayProvider, PgLeaveProvider],
    },
    AttendanceFlagsService,
    AttendanceGateway,
    PgHolidayProvider,
    PgLeaveProvider,
  ],
  exports: [AttendanceService, AttendanceGateway, PostgresAttendanceRepository, AttendanceFlagsService, PgHolidayProvider, PgLeaveProvider],
})
export class AttendanceModule {}
