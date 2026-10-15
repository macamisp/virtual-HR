import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { MailModule } from '../common/mail.module.ts';
import { AttendanceModule } from '../attendance/attendance.module.ts';
import { TasksModule } from '../tasks/tasks.module.ts';
import { PlanningModule } from '../planning/planning.module.ts';
import { TimesheetsModule } from '../timesheets/timesheets.module.ts';
import { EMAIL_DISPATCHER, NotificationEmailSender, NotificationsService } from './notifications.service.ts';
import { NotificationsController } from './notifications.controller.ts';
import { TaskNotificationsListener } from './task-notifications.listener.ts';
import { TimesheetNotificationsListener } from './timesheet-notifications.listener.ts';
import { ScheduledWorkService } from './scheduled-work.service.ts';
import { JobsService } from './jobs.service.ts';

@Module({
  imports: [MailModule, AttendanceModule, TasksModule, PlanningModule, TimesheetsModule],
  controllers: [NotificationsController],
  providers: [
    PrismaService,
    NotificationEmailSender,
    JobsService,
    { provide: EMAIL_DISPATCHER, useExisting: JobsService },
    NotificationsService,
    TaskNotificationsListener,
    TimesheetNotificationsListener,
    ScheduledWorkService,
  ],
  exports: [NotificationsService, ScheduledWorkService, JobsService],
})
export class NotificationsModule {}
