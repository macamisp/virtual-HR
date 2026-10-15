/**
 * Domain events emitted by the timesheets module after a transaction commits. The
 * notifications module (FR-TS-012) subscribes; timesheet code does not know about delivery.
 */
import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

interface Base {
  orgId: string;
  timesheetId: string;
  ownerId: string;
  periodStart: string;
  periodEnd: string;
  actorId: string;
}

export interface TimesheetEventMap {
  'timesheet.submitted': Base & { approverIds: string[] };
  'timesheet.approved': Base;
  'timesheet.rejected': Base & { comment: string };
  'timesheet.reopened': Base & { reason: string };
}

@Injectable()
export class TimesheetEvents {
  private readonly emitter = new EventEmitter();

  emit<K extends keyof TimesheetEventMap>(name: K, payload: TimesheetEventMap[K]): void {
    this.emitter.emit(name, payload);
  }

  on<K extends keyof TimesheetEventMap>(name: K, listener: (payload: TimesheetEventMap[K]) => void | Promise<void>): void {
    this.emitter.on(name, (payload: TimesheetEventMap[K]) => {
      // A failing listener (e.g. email down) must never break the approval that emitted.
      void Promise.resolve()
        .then(() => listener(payload))
        .catch(() => undefined);
    });
  }
}
