import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.ts';
import { OfficeAdminController, OfficeBroadcastController, OfficeController } from './office.controller.ts';
import { OfficeService } from './office.service.ts';
import { OfficeRegistry } from './office-registry.ts';
import { OfficeGateway } from './office.gateway.ts';
import { OfficePresenceStore } from './office-presence.ts';

@Module({
  imports: [AttendanceModule],
  controllers: [OfficeController, OfficeAdminController, OfficeBroadcastController],
  providers: [OfficeRegistry, OfficeService, OfficeGateway, OfficePresenceStore],
  exports: [OfficeRegistry, OfficeGateway, OfficePresenceStore],
})
export class OfficeModule {}
