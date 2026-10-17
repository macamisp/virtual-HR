import { Module } from '@nestjs/common';
import { AuditService } from './audit.service.ts';
import { AuditController } from './audit.controller.ts';

@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
