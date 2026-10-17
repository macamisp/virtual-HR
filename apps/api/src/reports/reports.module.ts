import { Module } from '@nestjs/common';
import { ComplianceRequirementsController, ReportsController } from './reports.controller.ts';
import { DashboardService } from './dashboard.service.ts';
import { ReportsService } from './reports.service.ts';
import { ComplianceService } from './compliance.service.ts';

@Module({
  controllers: [ReportsController, ComplianceRequirementsController],
  providers: [DashboardService, ReportsService, ComplianceService],
})
export class ReportsModule {}
