import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { AttendanceModule } from '../attendance/attendance.module.ts';
import { AdminController } from './admin.controller.ts';
import { AdminService } from './admin.service.ts';
import { ConsentsService } from './consents.service.ts';

@Module({
  imports: [AttendanceModule],
  controllers: [AdminController],
  providers: [PrismaService, AdminService, ConsentsService],
})
export class AdminModule {}
