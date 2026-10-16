import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { AttendanceModule } from '../attendance/attendance.module.ts';
import { DocumentsModule } from '../documents/documents.module.ts';
import { PrivacyController, SelfExportController } from './privacy.controller.ts';
import { DataExportService } from './data-export.service.ts';
import { AnonymisationService } from './anonymisation.service.ts';

@Module({
  imports: [AttendanceModule, DocumentsModule],
  controllers: [PrivacyController, SelfExportController],
  providers: [PrismaService, DataExportService, AnonymisationService],
})
export class PrivacyModule {}
