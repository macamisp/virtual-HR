import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { AttendanceModule } from '../attendance/attendance.module.ts';
import { OfficeAdminController, OfficeBroadcastController, OfficeController } from './office.controller.ts';
import { OfficeService } from './office.service.ts';
import { OfficeRegistry } from './office-registry.ts';
import { OfficeGateway } from './office.gateway.ts';

@Module({
  imports: [AttendanceModule],
  controllers: [OfficeController, OfficeAdminController, OfficeBroadcastController],
  providers: [PrismaService, OfficeRegistry, OfficeService, OfficeGateway],
  exports: [OfficeRegistry, OfficeGateway],
})
export class OfficeModule {}
