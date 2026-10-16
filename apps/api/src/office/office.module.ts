import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { AttendanceModule } from '../attendance/attendance.module.ts';
import { OfficeAdminController, OfficeController } from './office.controller.ts';
import { OfficeService } from './office.service.ts';
import { OfficeRegistry } from './office-registry.ts';
import { OfficeGateway } from './office.gateway.ts';

@Module({
  imports: [AttendanceModule],
  controllers: [OfficeController, OfficeAdminController],
  providers: [PrismaService, OfficeRegistry, OfficeService, OfficeGateway],
  exports: [OfficeRegistry],
})
export class OfficeModule {}
