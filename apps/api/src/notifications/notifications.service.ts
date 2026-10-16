import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { AttendanceGateway } from '../attendance/attendance.gateway.ts';
import { MAIL_TRANSPORT } from '../common/mailer.ts';
import type { MailTransport } from '../common/mailer.ts';
import type { Notification, NotificationList, NotificationListQuery, NotificationType } from '../../../../packages/shared/src/notifications/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { NotificationPreferencesService } from './notification-preferences.service.ts';
import { resolveChannels } from './notification-rules.ts';
import { renderEmail } from './email-templates.ts';

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
  inApp: boolean;
  /** Email now; false when not wanted or deferred by quiet hours (FR-NOTIF-004). */
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
    private readonly preferences: NotificationPreferencesService,
  ) {}

  /**
   * Inserts notifications inside the caller's tenant transaction, applying each recipient's
   * preferences and quiet hours (FR-NOTIF-004; critical types ignore both). Returns the rows
   * actually created (dedupe conflicts and switched-off types are skipped); call `deliver`
   * after the transaction commits.
   */
  async create(db: pg.PoolClient, orgId: string, items: NewNotification[], now: Date = new Date()): Promise<Created[]> {
    const created: Created[] = [];
    const settings = await this.preferences.settingsFor(db, orgId, [...new Set(items.map((i) => i.userId))]);
    for (const n of items) {
      const s = settings.get(n.userId);
      if (!s) continue; // not in this organisation
      const ch = resolveChannels(n.type, n.email === true, s.prefs.get(n.type), now, s.timezone, s.quietHours);
      if (!ch.inApp && !ch.email) continue;
      const res = await db.query<{ id: string }>(
        `INSERT INTO notifications (org_id, user_id, type, title, body, link, entity_type, entity_id, dedupe_key, send_email, email_after, in_app)
         SELECT $1, u.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12 FROM users u
         WHERE u.org_id = $1 AND u.id = $2 AND u.status = 'ACTIVE'
         ON CONFLICT (user_id, dedupe_key) DO NOTHING
         RETURNING id`,
        [orgId, n.userId, n.type, n.title.slice(0, 200), n.body ?? '', n.link ?? null, n.entityType ?? null, n.entityId ?? null, n.dedupeKey ?? null, ch.email, ch.emailAfter, ch.inApp],
      );
      if (res.rows[0]) created.push({ id: res.rows[0].id, userId: n.userId, title: n.title, inApp: ch.inApp, email: ch.email && ch.emailAfter === null });
    }
    return created;
  }

  /**
   * Quiet hours over: release the held emails of one organisation and hand them to delivery.
   * Releasing clears `email_after`; the sender's atomic claim still prevents a double send.
   */
  async dispatchDue(orgId: string, now: Date = new Date()): Promise<number> {
    const due = await this.prisma.runWithTenantContext(orgId, async (db) => {
      const res = await db.query<{ id: string }>(
        `UPDATE notifications SET email_after = NULL
         WHERE id IN (
           SELECT id FROM notifications WHERE org_id = $1 AND send_email AND emailed_at IS NULL AND email_after IS NOT NULL AND email_after <= $2
           ORDER BY email_after LIMIT 500 FOR UPDATE SKIP LOCKED)
         RETURNING id`,
        [orgId, now],
      );
      return res.rows.map((r) => r.id);
    });
    for (const id of due) {
      await this.emails.dispatch(orgId, id).catch((err: unknown) => {
        console.error('Deferred notification email dispatch failed:', err instanceof Error ? err.message : 'unknown error');
      });
    }
    return due.length;
  }

  /** After commit: real-time push to the user's sockets and email hand-off. */
  async deliver(orgId: string, created: Created[]): Promise<void> {
    for (const c of created) {
      if (c.inApp) this.gateway.notifyUser(c.userId, 'notification:new', { id: c.id, title: c.title });
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
         WHERE org_id = $1 AND user_id = $2 AND in_app AND ($3::boolean = false OR read_at IS NULL)
         ORDER BY created_at DESC LIMIT $4`,
        [user.orgId, user.id, q.unreadOnly, q.limit],
      );
      const unread = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM notifications WHERE org_id = $1 AND user_id = $2 AND in_app AND read_at IS NULL`,
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
    private readonly preferences: NotificationPreferencesService,
  ) {}

  async send(orgId: string, notificationId: string, now: Date = new Date()): Promise<boolean> {
    // Atomic claim: only one sender wins; the claim is released if sending fails so a retry can run.
    // A deferred email (quiet hours) is not claimable before its time.
    const row = await this.prisma.runWithTenantContext(orgId, async (db) => {
      const res = await db.query<{ type: string; title: string; body: string; link: string | null; email: string; display_name: string | null; user_id: string; org_name: string }>(
        `UPDATE notifications n SET emailed_at = now()
         FROM users u, organizations o
         WHERE n.org_id = $1 AND n.id = $2 AND n.emailed_at IS NULL AND n.send_email AND (n.email_after IS NULL OR n.email_after <= $3)
           AND u.id = n.user_id AND u.status = 'ACTIVE' AND o.id = n.org_id
         RETURNING n.type, n.title, n.body, n.link, u.email, u.display_name, u.id AS user_id, o.name AS org_name`,
        [orgId, notificationId, now],
      );
      return res.rows[0] ?? null;
    });
    if (!row) return false;
    const base = (process.env.APP_WEB_URL || 'http://localhost:3000').replace(/\/$/, '');
    const mail = renderEmail({
      type: row.type, title: row.title, body: row.body, link: row.link, recipientName: row.display_name, orgName: row.org_name, webUrl: base,
      unsubscribeUrl: this.preferences.unsubscribeUrl(base, orgId, row.user_id, row.type),
    });
    try {
      await this.mailer.send({ to: row.email, subject: mail.subject, text: mail.text });
    } catch (err) {
      await this.prisma.runWithTenantContext(orgId, async (db) => {
        await db.query(`UPDATE notifications SET emailed_at = NULL WHERE org_id = $1 AND id = $2`, [orgId, notificationId]);
      });
      throw err;
    }
    return true;
  }
}
