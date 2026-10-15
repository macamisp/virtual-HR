import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { TaskEvents } from '../tasks/task-events.ts';
import { NotificationsService } from './notifications.service.ts';

/**
 * FR-TASK-011: turns task domain events into notifications. Email for assignment, acceptance
 * requests, declines and mentions; in-app only for acceptance and status updates.
 */
@Injectable()
export class TaskNotificationsListener implements OnModuleInit {
  constructor(
    private readonly events: TaskEvents,
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
  ) {}

  private async name(orgId: string, userId: string): Promise<string> {
    return await this.prisma.runWithTenantContext(orgId, async (db) => {
      const res = await db.query<{ display_name: string | null; email: string }>(`SELECT display_name, email FROM users WHERE id = $1`, [userId]);
      return res.rows[0]?.display_name ?? res.rows[0]?.email ?? 'Someone';
    });
  }

  onModuleInit(): void {
    this.events.on('task.assigned', async (e) => {
      const by = await this.name(e.orgId, e.actorId);
      await this.notifications.notify(e.orgId, [{
        userId: e.assigneeId,
        type: e.requiresAcceptance ? 'TASK_ACCEPTANCE_REQUESTED' : 'TASK_ASSIGNED',
        title: e.requiresAcceptance ? `Please accept: ${e.title}` : `New task: ${e.title}`,
        body: e.requiresAcceptance
          ? `${by} assigned “${e.title}” to you. Accept it to start, or decline with a reason.`
          : `${by} assigned “${e.title}” to you.`,
        link: `/tasks/${e.taskId}`,
        entityType: 'TASK',
        entityId: e.taskId,
        email: true,
      }]);
    });

    this.events.on('task.accepted', async (e) => {
      if (e.reporterId === e.assigneeId) return;
      const who = await this.name(e.orgId, e.assigneeId);
      await this.notifications.notify(e.orgId, [{
        userId: e.reporterId, type: 'TASK_ACCEPTED', title: `${who} accepted “${e.title}”`,
        link: `/tasks/${e.taskId}`, entityType: 'TASK', entityId: e.taskId,
      }]);
    });

    this.events.on('task.declined', async (e) => {
      const who = await this.name(e.orgId, e.assigneeId);
      await this.notifications.notify(e.orgId, [{
        userId: e.reporterId, type: 'TASK_DECLINED', title: `${who} declined “${e.title}”`,
        body: `Reason: ${e.reason}\nChoose another assignee for the task.`,
        link: `/tasks/${e.taskId}`, entityType: 'TASK', entityId: e.taskId, email: true,
      }]);
    });

    this.events.on('task.mentioned', async (e) => {
      const by = await this.name(e.orgId, e.actorId);
      await this.notifications.notify(e.orgId, e.userIds.map((userId) => ({
        userId, type: 'TASK_MENTIONED' as const, title: `${by} mentioned you on “${e.title}”`,
        link: `/tasks/${e.taskId}`, entityType: 'TASK', entityId: e.taskId, email: true,
      })));
    });

    this.events.on('task.status', async (e) => {
      if (e.actorId === e.reporterId || (e.to !== 'DONE' && e.to !== 'BLOCKED')) return;
      const by = await this.name(e.orgId, e.actorId);
      await this.notifications.notify(e.orgId, [{
        userId: e.reporterId, type: 'TASK_STATUS',
        title: e.to === 'DONE' ? `${by} completed “${e.title}”` : `${by} marked “${e.title}” as blocked`,
        link: `/tasks/${e.taskId}`, entityType: 'TASK', entityId: e.taskId,
      }]);
    });
  }
}
