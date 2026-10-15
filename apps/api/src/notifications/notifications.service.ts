import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { AttendanceGateway } from '../attendance/attendance.gateway.ts';
import { MAIL_TRANSPORT } from '../common/mailer.ts';
import type { MailTransport } from '../common/mailer.ts';
import type { Notification, NotificationList, NotificationListQuery, NotificationType } from '../../../../packages/shared/src/notifications/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';

export const EMAIL_DISPATCHER = Symbol('EMAIL_DISPATCHER');

/** Hands an emailed notification to delivery (BullMQ when jobs are enabled, else inline). */
export interface EmailDispatcher {
  dispatch(orgId: string, notificationId: string): Promise<void>;
}

export interface NewNotification {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
  entityType?: string;
  entityId?: string;
  /** Same key for the same user = created at most once (scheduled reminders). */
  dedupeKey?: string;
  email?: boolean;
}

interface Created {
  id: string;
  userId: string;
  title: string;
  email: boolean;
}

function mapNotification(r: pg.QueryResultRow): Notification {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body,
    link: r.link ?? null,
    readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AttendanceGateway,
    @Inject(EMAIL_DISPATCHER) private readonly emails: EmailDispatcher,
  ) {}

  /**
   * Inserts notifications inside the caller's tenant transaction. Returns the rows actually
   * created (dedupe conflicts are skipped); call `deliver` after the transaction commits.
   */
  async create(db: pg.PoolClient, orgId: string, items: NewNotification[]): Promise<Created[]> {
    const created: Created[] = [];
    for (const n of items) {
      const res = await db.query<{ id: string }>(
        `INSERT INTO notifications (org_id, user_id, type, title, body, link, entity_type, entity_id, dedupe_key, send_email)
         SELECT $1, u.id, $3, $4, $5, $6, $7, $8, $9, $10 FROM users u
         WHERE u.org_id = $1 AND u.id = $2 AND u.status = 'ACTIVE'
         ON CONFLICT (user_id, dedupe_key) DO NOTHING
         RETURNING id`,
        [orgId, n.userId, n.type, n.title.slice(0, 200), n.body ?? '', n.link ?? null, n.entityType ?? null, n.entityId ?? null, n.dedupeKey ?? null, n.email === true],
      );
      if (res.rows[0]) created.push({ id: res.rows[0].id, userId: n.userId, title: n.title, email: n.email === true });
    }
    return created;
  }

  /** After commit: real-time push to the user's sockets and email hand-off. */
  async deliver(orgId: string, created: Created[]): Promise<void> {
    for (const c of created) {
      this.gateway.notifyUser(c.userId, 'notification:new', { id: c.id, title: c.title });
      if (c.email) {
        await this.emails.dispatch(orgId, c.id).catch((err: unknown) => {
          console.error('Notification email dispatch failed:', err instanceof Error ? err.message : 'unknown error');
        });
      }
    }
  }

  /** Create + deliver in one tenant transaction (for event listeners). */
  async notify(orgId: string, items: NewNotification[]): Promise<void> {
    if (items.length === 0) return;
    const created = await this.prisma.runWithTenantContext(orgId, (db) => this.create(db, orgId, items));
    await this.deliver(orgId, created);
  }

  async list(user: AuthenticatedUser, q: NotificationListQuery): Promise<NotificationList> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const items = await db.query(
        `SELECT id, type, title, body, link, read_at, created_at FROM notifications
         WHERE org_id = $1 AND user_id = $2 AND ($3::boolean = false OR read_at IS NULL)
         ORDER BY created_at DESC LIMIT $4`,
        [user.orgId, user.id, q.unreadOnly, q.limit],
      );
      const unread = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM notifications WHERE org_id = $1 AND user_id = $2 AND read_at IS NULL`,
        [user.orgId, user.id],
      );
      return { items: items.rows.map(mapNotification), unreadCount: unread.rows[0]!.n };
    });
  }

  async markRead(user: AuthenticatedUser, id: string): Promise<NotificationList> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const res = await db.query(
        `UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE org_id = $1 AND user_id = $2 AND id = $3`,
        [user.orgId, user.id, id],
      );
      if (res.rowCount === 0) throw new NotFoundException('Notification not found');
    });
    return await this.list(user, { unreadOnly: false, limit: 30 });
  }

  async markAllRead(user: AuthenticatedUser): Promise<NotificationList> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`UPDATE notifications SET read_at = now() WHERE org_id = $1 AND user_id = $2 AND read_at IS NULL`, [user.orgId, user.id]);
    });
    return await this.list(user, { unreadOnly: false, limit: 30 });
  }
}

/** Sends one notification email (idempotent: skips if already emailed or the user is inactive). */
@Injectable()
export class NotificationEmailSender {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAIL_TRANSPORT) private readonly mailer: MailTransport,
  ) {}

  async send(orgId: string, notificationId: string): Promise<boolean> {
    // Atomic claim: only one sender wins; the claim is released if sending fails so a retry can run.
    const row = await this.prisma.runWithTenantContext(orgId, async (db) => {
      const res = await db.query(
        `UPDATE notifications n SET emailed_at = now()
         FROM users u
         WHERE n.org_id = $1 AND n.id = $2 AND n.emailed_at IS NULL AND n.send_email AND u.id = n.user_id AND u.status = 'ACTIVE'
         RETURNING n.title, n.body, n.link, u.email`,
        [orgId, notificationId],
      );
      return res.rows[0] ?? null;
    });
    if (!row) return false;
    const base = (process.env.APP_WEB_URL || 'http://localhost:3000').replace(/\/$/, '');
    try {
      await this.mailer.send({
        to: row.email,
        subject: `HRVO: ${row.title}`,
        text: [row.body, row.link ? `Open in HR Virtual Office: ${base}${row.link}` : null, 'You receive this because of your role in HR Virtual Office.']
          .filter((l): l is string => !!l)
          .join('\n\n'),
      });
    } catch (err) {
      await this.prisma.runWithTenantContext(orgId, async (db) => {
        await db.query(`UPDATE notifications SET emailed_at = NULL WHERE org_id = $1 AND id = $2`, [orgId, notificationId]);
      });
      throw err;
    }
    return true;
  }
}
