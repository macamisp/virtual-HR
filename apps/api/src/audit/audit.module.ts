import { Module } from '@nestjs/common';
import { AuditService } from './audit.service.ts';
import { AuditController } from './audit.controller.ts';
import { PrismaService } from '../common/prisma.service.ts';

@Module({
  controllers: [AuditController],
  providers: [AuditService, PrismaService],
  exports: [AuditService],
})
export class AuditModule {}
