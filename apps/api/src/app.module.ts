import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.ts';
import { UsersModule } from './users/users.module.ts';
import { AttendanceModule } from './attendance/attendance.module.ts';
import { AuditModule } from './audit/audit.module.ts';
import { TasksModule } from './tasks/tasks.module.ts';
import { PlanningModule } from './planning/planning.module.ts';
import { NotificationsModule } from './notifications/notifications.module.ts';
import { TimesheetsModule } from './timesheets/timesheets.module.ts';
import { RlsInterceptor } from './common/interceptors/rls.interceptor.ts';
import { rateLimitModule } from './common/rate-limit.ts';

@Module({
  imports: [rateLimitModule(), AuthModule, UsersModule, AttendanceModule, AuditModule, TasksModule, PlanningModule, TimesheetsModule, NotificationsModule],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: RlsInterceptor,
    },
  ],
})
export class AppModule {}
