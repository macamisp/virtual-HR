import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.ts';
import { DocumentsModule } from '../documents/documents.module.ts';
import { PrivacyController, SelfExportController } from './privacy.controller.ts';
import { DataExportService } from './data-export.service.ts';
import { AnonymisationService } from './anonymisation.service.ts';

@Module({
  imports: [AttendanceModule, DocumentsModule],
  controllers: [PrivacyController, SelfExportController],
  providers: [DataExportService, AnonymisationService],
})
export class PrivacyModule {}
