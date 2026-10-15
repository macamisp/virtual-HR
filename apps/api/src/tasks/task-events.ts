/**
 * Domain events emitted by the tasks module after a transaction commits. The notifications
 * module (FR-TASK-011) subscribes; tasks code does not know about delivery channels.
 */
import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export interface TaskEventMap {
  'task.assigned': { orgId: string; taskId: string; title: string; assigneeId: string; actorId: string; requiresAcceptance: boolean };
  'task.accepted': { orgId: string; taskId: string; title: string; assigneeId: string; reporterId: string };
  'task.declined': { orgId: string; taskId: string; title: string; assigneeId: string; reporterId: string; reason: string };
  'task.mentioned': { orgId: string; taskId: string; title: string; commentId: string; userIds: string[]; actorId: string };
  'task.status': { orgId: string; taskId: string; title: string; from: string; to: string; actorId: string; reporterId: string; assigneeId: string | null };
}

@Injectable()
export class TaskEvents {
  private readonly emitter = new EventEmitter();

  emit<K extends keyof TaskEventMap>(name: K, payload: TaskEventMap[K]): void {
    this.emitter.emit(name, payload);
  }

  on<K extends keyof TaskEventMap>(name: K, listener: (payload: TaskEventMap[K]) => void | Promise<void>): void {
    this.emitter.on(name, (payload: TaskEventMap[K]) => {
      // A failing listener (e.g. email down) must never break the task operation that emitted.
      void Promise.resolve()
        .then(() => listener(payload))
        .catch(() => undefined);
    });
  }
}
