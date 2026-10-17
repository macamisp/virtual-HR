import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.ts';
import { TasksModule } from '../tasks/tasks.module.ts';
import { PlanningModule } from '../planning/planning.module.ts';
import { TimeEntriesController } from './time-entries.controller.ts';
import { TimesheetsController } from './timesheets.controller.ts';
import { TimeEntriesService } from './time-entries.service.ts';
import { TimesheetsService } from './timesheets.service.ts';
import { RatesService } from './rates.service.ts';
import { TimesheetEvents } from './timesheet-events.ts';
import { TimesheetReportsService } from './reports.service.ts';

/** FR-TS-001..006, 009, 011..013 (ADR 008). */
@Module({
  imports: [AttendanceModule, TasksModule, PlanningModule],
  controllers: [TimeEntriesController, TimesheetsController],
  providers: [TimeEntriesService, TimesheetsService, RatesService, TimesheetEvents, TimesheetReportsService],
  exports: [TimeEntriesService, TimesheetsService, TimesheetEvents],
})
export class TimesheetsModule {}
