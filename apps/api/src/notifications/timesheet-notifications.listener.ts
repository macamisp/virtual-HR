import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { TimesheetEvents } from '../timesheets/timesheet-events.ts';
import { NotificationsService } from './notifications.service.ts';

/**
 * FR-TS-006 / FR-TS-012: timesheet decisions reach the right people. Submissions go to the
 * approvers (in-app + email); rejections and reopenings to the owner (with the comment);
 * approvals to the owner in-app. Bodies hold periods and comments only, never amounts.
 */
@Injectable()
export class TimesheetNotificationsListener implements OnModuleInit {
  constructor(
    private readonly events: TimesheetEvents,
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
    this.events.on('timesheet.submitted', async (e) => {
      const who = await this.name(e.orgId, e.ownerId);
      await this.notifications.notify(e.orgId, e.approverIds.map((userId) => ({
        userId, type: 'TIMESHEET_SUBMITTED' as const,
        title: `${who} submitted a timesheet (${e.periodStart} – ${e.periodEnd})`,
        body: 'Review and approve it, or return it with a comment.',
        link: `/timesheets/${e.timesheetId}`, entityType: 'TIMESHEET', entityId: e.timesheetId, email: true,
      })));
    });

    this.events.on('timesheet.approved', async (e) => {
      const by = await this.name(e.orgId, e.actorId);
      await this.notifications.notify(e.orgId, [{
        userId: e.ownerId, type: 'TIMESHEET_APPROVED', title: `${by} approved your timesheet (${e.periodStart} – ${e.periodEnd})`,
        link: `/timesheets/${e.timesheetId}`, entityType: 'TIMESHEET', entityId: e.timesheetId,
      }]);
    });

    this.events.on('timesheet.rejected', async (e) => {
      const by = await this.name(e.orgId, e.actorId);
      await this.notifications.notify(e.orgId, [{
        userId: e.ownerId, type: 'TIMESHEET_REJECTED', title: `${by} returned your timesheet (${e.periodStart} – ${e.periodEnd})`,
        body: `Comment: ${e.comment}\nFix it and submit again.`,
        link: `/timesheets/${e.timesheetId}`, entityType: 'TIMESHEET', entityId: e.timesheetId, email: true,
      }]);
    });

    this.events.on('timesheet.reopened', async (e) => {
      const by = await this.name(e.orgId, e.actorId);
      await this.notifications.notify(e.orgId, [{
        userId: e.ownerId, type: 'TIMESHEET_REOPENED', title: `${by} reopened your approved timesheet (${e.periodStart} – ${e.periodEnd})`,
        body: `Reason: ${e.reason}\nCheck it and submit again.`,
        link: `/timesheets/${e.timesheetId}`, entityType: 'TIMESHEET', entityId: e.timesheetId, email: true,
      }]);
    });
  }
}
