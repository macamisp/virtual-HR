import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller.ts';
import { ProjectsController } from './projects.controller.ts';
import { TasksService } from './tasks.service.ts';
import { ProjectsService } from './projects.service.ts';
import { TaskEvents } from './task-events.ts';
import { ACTUAL_TIME_PROVIDER, TimeEntriesActualTime } from './actual-time.ts';

@Module({
  controllers: [TasksController, ProjectsController],
  providers: [
    TasksService,
    ProjectsService,
    TaskEvents,
    { provide: ACTUAL_TIME_PROVIDER, useClass: TimeEntriesActualTime },
  ],
  exports: [TasksService, TaskEvents],
})
export class TasksModule {}
