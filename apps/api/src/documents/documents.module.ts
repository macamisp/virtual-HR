import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { NotificationsModule } from '../notifications/notifications.module.ts';
import { JobsService } from '../notifications/jobs.service.ts';
import { DocumentsController } from './documents.controller.ts';
import { ContractsController } from './contracts.controller.ts';
import { DocumentsService } from './documents.service.ts';
import { FoldersService } from './folders.service.ts';
import { ContractsService } from './contracts.service.ts';
import { DocumentScannerService, clamdOptionsProvider } from './document-scanner.service.ts';
import { DocumentMaintenanceService } from './document-maintenance.service.ts';
import { KMS_PROVIDER, kmsFromEnv } from './crypto.ts';
import { OBJECT_STORE, objectStoreFromEnv } from './object-store.ts';
import { SCAN_DISPATCHER } from './scan-dispatcher.ts';

/** FR-DOC-001..004, 007, 009, 012, 013, 015, 019 and minimal contracts (ADR 009). */
@Module({
  imports: [NotificationsModule],
  controllers: [DocumentsController, ContractsController],
  providers: [
    PrismaService,
    DocumentsService,
    FoldersService,
    ContractsService,
    DocumentScannerService,
    DocumentMaintenanceService,
    clamdOptionsProvider(),
    { provide: KMS_PROVIDER, useFactory: () => kmsFromEnv() },
    { provide: OBJECT_STORE, useFactory: () => objectStoreFromEnv() },
    { provide: SCAN_DISPATCHER, useExisting: JobsService },
  ],
  exports: [DocumentScannerService, DocumentMaintenanceService],
})
export class DocumentsModule {}
