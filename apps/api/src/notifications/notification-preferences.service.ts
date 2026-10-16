import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { getJwtSecret } from '../common/config.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import {
  isCriticalNotification,
  NOTIFICATION_TYPE_META,
  NOTIFICATION_TYPES,
} from '../../../../packages/shared/src/notifications/types.ts';
import type {
  NotificationPreferences,
  NotificationPreferencesDto,
  NotificationType,
  QuietHours,
  UnsubscribeResult,
} from '../../../../packages/shared/src/notifications/types.ts';
import { isValidTimezone, minutesToClock, signUnsubscribeToken, verifyUnsubscribeToken } from './notification-rules.ts';
import type { ChannelPreference } from './notification-rules.ts';

export interface RecipientSettings {
  timezone: string;
  quietHours: QuietHours | null;
  prefs: Map<string, ChannelPreference>;
}

const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** FR-NOTIF-004 preferences and quiet hours; FR-NOTIF-002 one-click unsubscribe. */
@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Everything `create` needs for a set of recipients, in two queries. */
  async settingsFor(db: pg.PoolClient, orgId: string, userIds: readonly string[]): Promise<Map<string, RecipientSettings>> {
    const out = new Map<string, RecipientSettings>();
    if (userIds.length === 0) return out;
    const users = await db.query<{ id: string; timezone: string | null; org_tz: string; qs: number | null; qe: number | null }>(
      `SELECT u.id, u.timezone, o.timezone AS org_tz, u.quiet_hours_start AS qs, u.quiet_hours_end AS qe
       FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.org_id = $1 AND u.id = ANY($2::uuid[])`,
      [orgId, userIds],
    );
    for (const u of users.rows) {
      out.set(u.id, {
        timezone: u.timezone ?? u.org_tz,
        quietHours: u.qs !== null && u.qe !== null ? { start: minutesToClock(u.qs), end: minutesToClock(u.qe) } : null,
        prefs: new Map(),
      });
    }
    const prefs = await db.query<{ user_id: string; type: string; in_app: boolean; email: boolean }>(
      `SELECT user_id, type, in_app, email FROM notification_preferences WHERE user_id = ANY($1::uuid[])`,
      [userIds],
    );
    for (const p of prefs.rows) out.get(p.user_id)?.prefs.set(p.type, { inApp: p.in_app, email: p.email });
    return out;
  }

  async get(user: AuthenticatedUser): Promise<NotificationPreferences> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const all = await this.settingsFor(db, user.orgId, [user.id]);
      const mine = all.get(user.id);
      if (!mine) throw new NotFoundException('User not found');
      const row = await db.query<{ timezone: string | null; org_tz: string }>(
        `SELECT u.timezone, o.timezone AS org_tz FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = $1`,
        [user.id],
      );
      return {
        timezone: row.rows[0]!.timezone,
        orgTimezone: row.rows[0]!.org_tz,
        quietHours: mine.quietHours,
        items: NOTIFICATION_TYPES.map((type) => {
          const meta = NOTIFICATION_TYPE_META[type];
          const critical = !!meta.critical;
          const p = mine.prefs.get(type);
          return { type, label: meta.label, group: meta.group, critical, inApp: critical || (p?.inApp ?? true), email: critical || (p?.email ?? true) };
        }),
      };
    });
  }

  async update(user: AuthenticatedUser, dto: NotificationPreferencesDto): Promise<NotificationPreferences> {
    if (dto.timezone !== null && !isValidTimezone(dto.timezone)) throw new BadRequestException('Unknown timezone');
    const seen = new Set<string>();
    for (const i of dto.items) {
      if (seen.has(i.type)) throw new BadRequestException(`Duplicate preference for ${i.type}`);
      seen.add(i.type);
      if (isCriticalNotification(i.type) && (!i.inApp || !i.email)) throw new BadRequestException(`${NOTIFICATION_TYPE_META[i.type].label} is a security notice and cannot be turned off`);
    }
    const before = await this.get(user);
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(
        `UPDATE users SET timezone = $2, quiet_hours_start = $3, quiet_hours_end = $4 WHERE id = $1`,
        [user.id, dto.timezone, dto.quietHours ? toMinutes(dto.quietHours.start) : null, dto.quietHours ? toMinutes(dto.quietHours.end) : null],
      );
      // Rows exist only for types that differ from the default (both on).
      await db.query(`DELETE FROM notification_preferences WHERE user_id = $1`, [user.id]);
      const off = dto.items.filter((i) => !i.inApp || !i.email);
      if (off.length > 0) {
        await db.query(
          `INSERT INTO notification_preferences (org_id, user_id, type, in_app, email)
           SELECT $1, $2, t.type, t.in_app, t.email FROM unnest($3::text[], $4::boolean[], $5::boolean[]) AS t(type, in_app, email)`,
          [user.orgId, user.id, off.map((i) => i.type), off.map((i) => i.inApp), off.map((i) => i.email)],
        );
      }
      await appendAuditEntry(db, {
        orgId: user.orgId, actorId: user.id, action: 'NOTIFICATION_PREFERENCES_UPDATED', entityType: 'USER', entityId: user.id,
        before: { timezone: before.timezone, quietHours: before.quietHours, off: before.items.filter((i) => !i.inApp || !i.email).map((i) => `${i.type}:${i.inApp ? '' : '-app'}${i.email ? '' : '-email'}`) },
        after: { timezone: dto.timezone, quietHours: dto.quietHours, off: off.map((i) => `${i.type}:${i.inApp ? '' : '-app'}${i.email ? '' : '-email'}`) },
      });
    });
    return await this.get(user);
  }

  /** The link placed in each non-critical email. */
  unsubscribeUrl(webUrl: string, orgId: string, userId: string, type: string): string | null {
    if (isCriticalNotification(type)) return null;
    return `${webUrl}/unsubscribe#${signUnsubscribeToken(getJwtSecret(), orgId, userId, type)}`;
  }

  /**
   * Public, rate-limited. The token only identifies org, user and type and can only turn email
   * off for that type, so a leaked old email is at worst a nuisance. Idempotent.
   */
  async unsubscribe(token: string): Promise<UnsubscribeResult> {
    const claim = verifyUnsubscribeToken(getJwtSecret(), token);
    if (!claim || !(NOTIFICATION_TYPES as readonly string[]).includes(claim.type) || isCriticalNotification(claim.type)) {
      throw new BadRequestException('This unsubscribe link is not valid');
    }
    const type = claim.type as NotificationType;
    await this.prisma.runWithTenantContext(claim.orgId, async (db) => {
      const res = await db.query(
        `INSERT INTO notification_preferences (org_id, user_id, type, in_app, email)
         SELECT $1, u.id, $3, true, false FROM users u WHERE u.id = $2 AND u.org_id = $1
         ON CONFLICT (user_id, type) DO UPDATE SET email = false, updated_at = now()
         RETURNING user_id`,
        [claim.orgId, claim.userId, type],
      );
      if (res.rowCount === 0) throw new BadRequestException('This unsubscribe link is not valid');
      await appendAuditEntry(db, { orgId: claim.orgId, actorId: claim.userId, action: 'NOTIFICATION_UNSUBSCRIBED', entityType: 'USER', entityId: claim.userId, after: { type } });
    });
    return { type, label: NOTIFICATION_TYPE_META[type].label };
  }
}
