import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.ts';
import { TasksModule } from '../tasks/tasks.module.ts';
import { WorkRequestsController } from './work-requests.controller.ts';
import { WorkRequestsService } from './work-requests.service.ts';

/** ADR 049 §2, §7: overtime and onsite work requests, decided like leave (ADR 027). */
@Module({
  imports: [NotificationsModule, TasksModule],
  controllers: [WorkRequestsController],
  providers: [WorkRequestsService],
})
export class WorkRequestsModule {}
