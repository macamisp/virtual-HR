import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { AttendanceGateway } from '../attendance/attendance.gateway.ts';
import { NotificationsService } from '../notifications/notifications.service.ts';

interface CallRow {
  meeting_id: string; caller_id: string; callee_id: string;
  state: string; expires_at: Date; title: string; display_name: string | null; email: string;
}
const SELECT = `SELECT c.*, m.title, u.display_name, u.email FROM meeting_calls c
  JOIN meetings m ON m.id = c.meeting_id JOIN users u ON u.id = c.callee_id`;
const map = (c: CallRow) => ({ meetingId: c.meeting_id, userId: c.callee_id, name: c.display_name ?? c.email, title: c.title, state: c.state, expiresAt: c.expires_at.toISOString() });

/** Durable 45-second ringing; decisions and missed notifications survive socket loss/restarts. */
@Injectable()
export class CallsService {
  constructor(private readonly prisma: PrismaService, private readonly gateway: AttendanceGateway, private readonly notifications: NotificationsService) {}

  async busy(db: pg.PoolClient, userId: string, meetingId: string): Promise<boolean> {
    const r = await db.query(`SELECT 1 FROM meeting_participants WHERE user_id = $1 AND meeting_id <> $2 AND left_at IS NULL
      UNION ALL SELECT 1 FROM meeting_calls WHERE callee_id = $1 AND meeting_id <> $2 AND state = 'ACCEPTED' AND expires_at > now() LIMIT 1`, [userId, meetingId]);
    return !!r.rows[0];
  }

  async start(db: pg.PoolClient, user: AuthenticatedUser, meetingId: string, ids: string[]): Promise<void> {
    // Stable ordering prevents deadlocks for simultaneous group calls. Decisions use the same lock.
    await db.query(`SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [[user.id, ...ids]]);
    if (await this.busy(db, user.id, meetingId)) throw new ConflictException('You are already in a call');
    for (const id of ids) {
      const state = await this.busy(db, id, meetingId) ? 'BUSY' : 'RINGING';
      await db.query(`INSERT INTO meeting_calls (org_id, meeting_id, caller_id, callee_id, state) VALUES ($1,$2,$3,$4,$5)`, [user.orgId, meetingId, user.id, id, state]);
    }
  }

  async announce(orgId: string, meetingId: string): Promise<void> {
    const rows = await this.prisma.runWithTenantContext(orgId, async (db) => (await db.query<CallRow>(`${SELECT} WHERE c.meeting_id = $1`, [meetingId])).rows);
    for (const c of rows) {
      if (c.state === 'RINGING') this.gateway.notifyUser(c.callee_id, 'meeting:ring', { meetingId, title: c.title, from: c.caller_id, expiresAt: c.expires_at.toISOString() });
      else this.push(c);
    }
  }

  private push(c: CallRow): void {
    const payload = map(c);
    this.gateway.notifyUser(c.caller_id, 'meeting:call-state', payload);
    this.gateway.notifyUser(c.callee_id, 'meeting:call-state', payload);
  }

  async expire(orgId: string): Promise<void> {
    const result = await this.prisma.runWithTenantContext(orgId, async (db) => {
      const ids = (await db.query<{ meeting_id: string; callee_id: string }>(`UPDATE meeting_calls SET state = 'MISSED', decided_at = now()
        WHERE state = 'RINGING' AND expires_at <= now() RETURNING meeting_id, callee_id`)).rows;
      const rows: CallRow[] = [];
      for (const id of ids) {
        const c = (await db.query<CallRow>(`${SELECT} WHERE c.meeting_id = $1 AND c.callee_id = $2`, [id.meeting_id, id.callee_id])).rows[0]!;
        rows.push(c);
        await appendAuditEntry(db, { orgId, actorId: c.callee_id, action: 'CALL_MISSED', entityType: 'MEETING', entityId: c.meeting_id });
      }
      const notifications = await this.notifications.create(db, orgId, rows.map((c) => ({ userId: c.callee_id, type: 'CALL_MISSED' as const, title: `Missed call: ${c.title}`, link: `/meetings/${c.meeting_id}`, entityType: 'MEETING', entityId: c.meeting_id, dedupeKey: `missed-call:${c.meeting_id}:${c.callee_id}` })));
      return { rows, notifications };
    });
    for (const c of result.rows) this.push(c);
    await this.notifications.deliver(orgId, result.notifications);
  }

  async maintenance(): Promise<void> {
    const orgs = (await this.prisma.getPool().query<{ id: string }>(`SELECT id FROM fn_list_orgs_for_jobs()`)).rows;
    for (const org of orgs) await this.expire(org.id);
  }

  async incoming(user: AuthenticatedUser) {
    await this.expire(user.orgId);
    const rows = await this.prisma.runWithTenantContext(user.orgId, async (db) => (await db.query<CallRow>(`${SELECT} WHERE c.callee_id = $1 AND c.state = 'RINGING' ORDER BY c.created_at`, [user.id])).rows);
    return { items: rows.map(map) };
  }

  async list(user: AuthenticatedUser, meetingId: string) {
    await this.expire(user.orgId);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const visible = await db.query(`SELECT 1 FROM meetings m WHERE m.id = $1 AND (m.host_id = $2 OR EXISTS (SELECT 1 FROM meeting_attendees a WHERE a.meeting_id = m.id AND a.user_id = $2))`, [meetingId, user.id]);
      if (!visible.rows[0]) throw new NotFoundException('Meeting not found');
      return { items: (await db.query<CallRow>(`${SELECT} WHERE c.meeting_id = $1 ORDER BY c.created_at, c.callee_id`, [meetingId])).rows.map(map) };
    });
  }

  async respond(user: AuthenticatedUser, meetingId: string, accept: boolean): Promise<void> {
    // Expiration commits even when the late response is refused.
    await this.expire(user.orgId);
    const c = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [user.id]);
      const c = (await db.query<CallRow>(`${SELECT} WHERE c.meeting_id = $1 AND c.callee_id = $2 FOR UPDATE OF c`, [meetingId, user.id])).rows[0];
      if (!c) throw new NotFoundException('Call not found');
      if (c.state === (accept ? 'ACCEPTED' : 'DECLINED')) return c;
      if (c.state !== 'RINGING' || c.expires_at <= new Date()) throw new ConflictException('This call is no longer ringing');
      if (accept && await this.busy(db, user.id, meetingId)) throw new ConflictException('You are already in a call');
      c.state = accept ? 'ACCEPTED' : 'DECLINED';
      await db.query(`UPDATE meeting_calls SET state = $3, decided_at = now() WHERE meeting_id = $1 AND callee_id = $2`, [meetingId, user.id, c.state]);
      await db.query(`UPDATE meeting_attendees SET response = $3 WHERE meeting_id = $1 AND user_id = $2`, [meetingId, user.id, c.state]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: `CALL_${c.state}`, entityType: 'MEETING', entityId: meetingId });
      return c;
    });
    this.push(c);
  }

  async cancel(user: AuthenticatedUser, meetingId: string): Promise<void> {
    const rows = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`UPDATE meeting_calls SET state = 'CANCELLED', decided_at = now() WHERE meeting_id = $1 AND caller_id = $2 AND state = 'RINGING'`, [meetingId, user.id]);
      return (await db.query<CallRow>(`${SELECT} WHERE c.meeting_id = $1 AND c.state = 'CANCELLED'`, [meetingId])).rows;
    });
    rows.forEach((c) => this.push(c));
  }
}
