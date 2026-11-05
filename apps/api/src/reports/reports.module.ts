import { Module } from '@nestjs/common';
import { ComplianceRequirementsController, ReportsController } from './reports.controller.ts';
import { DashboardService } from './dashboard.service.ts';
import { ReportsService } from './reports.service.ts';
import { ComplianceService } from './compliance.service.ts';
import { WorkTimeController } from './work-time.controller.ts';
import { WorkTimeService } from './work-time.service.ts';

@Module({
  controllers: [ReportsController, ComplianceRequirementsController, WorkTimeController],
  providers: [DashboardService, ReportsService, ComplianceService, WorkTimeService],
})
export class ReportsModule {}
