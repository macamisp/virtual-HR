import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { ComplianceRequirementsController, ReportsController } from './reports.controller.ts';
import { DashboardService } from './dashboard.service.ts';
import { ReportsService } from './reports.service.ts';
import { ComplianceService } from './compliance.service.ts';

@Module({
  controllers: [ReportsController, ComplianceRequirementsController],
  providers: [PrismaService, DashboardService, ReportsService, ComplianceService],
})
export class ReportsModule {}
