import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller.ts';
import { AttendanceGateway } from './attendance.gateway.ts';
import { AttendanceService } from './attendance.service.ts';
import { PostgresAttendanceRepository } from './attendance-repository.ts';
import { PrismaService } from '../common/prisma.service.ts';
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
      useFactory: (repo: PostgresAttendanceRepository) => {
        return new AttendanceService(undefined, new SystemClock(), repo);
      },
      inject: [PostgresAttendanceRepository],
    },
    AttendanceGateway,
  ],
  exports: [AttendanceService, AttendanceGateway, PostgresAttendanceRepository],
})
export class AttendanceModule {}
