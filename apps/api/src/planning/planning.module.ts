import { Module } from '@nestjs/common';
import { ACTUAL_TIME_PROVIDER, TimeEntriesActualTime } from '../tasks/actual-time.ts';
import { PlanningController } from './planning.controller.ts';
import { PlanningService } from './planning.service.ts';

@Module({
  controllers: [PlanningController],
  providers: [PlanningService, { provide: ACTUAL_TIME_PROVIDER, useClass: TimeEntriesActualTime }],
  exports: [PlanningService],
})
export class PlanningModule {}
