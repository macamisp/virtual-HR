/**
 * Review flags (FR-ATT-017, FR-ATT-018, FR-ATT-012, FR-ATT-009; ADR 019).
 *
 * A flag is a request for a human to look. Raising one never changes recorded time, never blocks
 * a heartbeat and never notifies anyone as a "penalty". Reviewers (the person's manager or team
 * lead; HR and admins for everyone) resolve with a note; the person sees their own flags with a
 * plain-language explanation and can add a comment. Nobody resolves a flag about themselves.
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { formatInTimeZone } from 'date-fns-tz';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { impossibleTravel, networkViolations } from './anti-spoofing.ts';
import type { NetworkPolicy } from './anti-spoofing.ts';
import { FLAG_META, Permission, userCan } from '../../../../packages/shared/src/index.ts';
import type { AttendanceFlag, AuthenticatedUser, FlagCommentDto, FlagKind, FlagQuery, ResolveFlagDto } from '../../../../packages/shared/src/index.ts';

export interface NewFlag {
  orgId: string;
  userId: string;
  sessionId?: string | null;
  workDate: string;
  kind: FlagKind;
  details?: Record<string, unknown>;
  /** One flag per key; a repeat is ignored (e.g. `net:<session>:IP_NOT_ALLOWED`). */
  dedupeKey: string;
}

/** What AttendanceService and the gateway call (set with AttendanceService.setFlagSink). */
export interface FlagSink {
  raise(f: NewFlag): Promise<void>;
  /** Network policy and impossible travel for one heartbeat. */
  observe(o: { orgId: string; userId: string; sessionId: string; workDate: string; ip: string; country: string | null; at: Date; policy: NetworkPolicy }): Promise<void>;
  /** A heartbeat was rejected (signature, replay, order) or rate limited. */
  rejected(orgId: string, userId: string, why: 'INVALID' | 'FLOOD', at: Date, timeZone: string): Promise<void>;
}

interface FlagRow {
  id: string; kind: FlagKind; category: AttendanceFlag['category']; user_id: string; display_name: string | null; email: string;
  session_id: string | null; work_date: string; details: Record<string, unknown>; status: AttendanceFlag['status'];
  resolution: AttendanceFlag['resolution']; resolution_note: string | null; resolved_by: string | null; resolver_name: string | null;
  resolved_at: Date | null; user_comment: string | null; created_at: Date; manager_id: string | null; team_id: string | null;
}

const SELECT = `SELECT f.*, u.display_name, u.email, u.manager_id, u.team_id, r.display_name AS resolver_name
  FROM attendance_flags f JOIN users u ON u.id = f.user_id LEFT JOIN users r ON r.id = f.resolved_by`;

/** Rejections inside this window count towards one flag. */
const WINDOW_MS = 10 * 60_000;
const THRESHOLD = { INVALID: 5, FLOOD: 3 } as const;

@Injectable()
export class AttendanceFlagsService implements FlagSink {
  /** Avoids a database round trip per heartbeat for flags already raised. */
  private readonly raised = new Set<string>();
  private readonly lastSeen = new Map<string, { country: string; at: Date }>();
  private readonly rejections = new Map<string, number[]>();

  constructor(private readonly prisma: PrismaService) {}

  async raise(f: NewFlag): Promise<void> {
    const key = `${f.orgId}:${f.dedupeKey}`;
    if (this.raised.has(key)) return;
    const meta = FLAG_META[f.kind];
    await this.prisma.runWithTenantContext(f.orgId, (db) => db.query(
      `INSERT INTO attendance_flags (org_id, user_id, session_id, work_date, kind, category, details, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (org_id, dedupe_key) DO NOTHING`,
      [f.orgId, f.userId, f.sessionId ?? null, f.workDate, f.kind, meta.category, JSON.stringify(f.details ?? {}), f.dedupeKey.slice(0, 200)],
    ));
    this.raised.add(key);
    if (this.raised.size > 50_000) this.raised.clear();
  }

  async observe(o: Parameters<FlagSink['observe']>[0]): Promise<void> {
    for (const reason of networkViolations({ ip: o.ip, country: o.country }, o.policy)) {
      await this.raise({ orgId: o.orgId, userId: o.userId, sessionId: o.sessionId, workDate: o.workDate, kind: reason, details: { ip: o.ip, country: o.country }, dedupeKey: `net:${o.sessionId}:${reason}` });
    }
    if (!o.country || o.country === 'XX' || o.country === 'T1') return;
    const k = `${o.orgId}:${o.userId}`;
    let prev = this.lastSeen.get(k);
    if (!prev) {
      const row = (await this.prisma.runWithTenantContext(o.orgId, (db) => db.query<{ last_country: string | null; last_country_at: Date | null }>(
        `SELECT last_country, last_country_at FROM users WHERE id = $1`, [o.userId]))).rows[0];
      if (row?.last_country && row.last_country_at) prev = { country: row.last_country, at: new Date(row.last_country_at) };
    }
    if (prev?.country === o.country && o.at.getTime() - prev.at.getTime() < 10 * 60_000) return;
    if (prev) {
      const jump = impossibleTravel(prev, { country: o.country, at: o.at });
      if (jump) {
        await this.raise({ orgId: o.orgId, userId: o.userId, sessionId: o.sessionId, workDate: o.workDate, kind: 'IMPOSSIBLE_TRAVEL',
          details: { ...jump, previousAt: prev.at.toISOString(), at: o.at.toISOString() }, dedupeKey: `travel:${o.sessionId}:${jump.from}:${jump.to}` });
      }
    }
    this.lastSeen.set(k, { country: o.country, at: o.at });
    await this.prisma.runWithTenantContext(o.orgId, (db) => db.query(`UPDATE users SET last_country = $2, last_country_at = $3 WHERE id = $1`, [o.userId, o.country, o.at]));
  }

  async rejected(orgId: string, userId: string, why: 'INVALID' | 'FLOOD', at: Date, timeZone: string): Promise<void> {
    const k = `${orgId}:${userId}:${why}`;
    const recent = (this.rejections.get(k) ?? []).filter((t) => t > at.getTime() - WINDOW_MS);
    recent.push(at.getTime());
    this.rejections.set(k, recent);
    if (recent.length < THRESHOLD[why]) return;
    const workDate = formatInTimeZone(at, timeZone, 'yyyy-MM-dd');
    const kind: FlagKind = why === 'INVALID' ? 'INVALID_HEARTBEATS' : 'HEARTBEAT_FLOOD';
    await this.raise({ orgId, userId, workDate, kind, details: { count: recent.length, windowMinutes: WINDOW_MS / 60_000 }, dedupeKey: `${kind}:${userId}:${workDate}` });
  }

  // ------------------------------------------------------------------ review

  private reviewer(user: AuthenticatedUser): 'all' | 'team' | null {
    if (userCan(user, Permission.ATTENDANCE_READ_ALL)) return 'all';
    if (userCan(user, Permission.ATTENDANCE_CORRECTIONS_REVIEW)) return 'team';
    return null;
  }

  private inScope(user: AuthenticatedUser, r: Pick<FlagRow, 'user_id' | 'manager_id' | 'team_id'>): boolean {
    const scope = this.reviewer(user);
    if (r.user_id === user.id || !scope) return false;
    return scope === 'all' || r.manager_id === user.id || (!!user.teamId && r.team_id === user.teamId);
  }

  private toFlag(user: AuthenticatedUser, r: FlagRow): AttendanceFlag {
    return {
      id: r.id, kind: r.kind, category: r.category, person: { id: r.user_id, displayName: r.display_name, email: r.email },
      sessionId: r.session_id, workDate: r.work_date, details: r.details, status: r.status, resolution: r.resolution,
      resolutionNote: r.resolution_note, resolvedBy: r.resolved_by ? { id: r.resolved_by, displayName: r.resolver_name } : null,
      resolvedAt: r.resolved_at?.toISOString() ?? null, userComment: r.user_comment, createdAt: r.created_at.toISOString(),
      canResolve: r.status === 'OPEN' && userCan(user, Permission.ATTENDANCE_CORRECTIONS_REVIEW) && this.inScope(user, r),
    };
  }

  async list(user: AuthenticatedUser, q: FlagQuery): Promise<{ items: AttendanceFlag[] }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const params: unknown[] = [q.status, q.limit, user.id];
      let where: string;
      if (q.scope === 'mine') where = 'f.user_id = $3';
      else {
        const scope = this.reviewer(user);
        if (!scope) throw new ForbiddenException('You do not review attendance');
        where = 'f.user_id <> $3';
        if (scope === 'team') { params.push(user.teamId ?? null); where += ` AND (u.manager_id = $3 OR ($4::uuid IS NOT NULL AND u.team_id = $4::uuid))`; }
      }
      const rows = (await db.query<FlagRow>(`${SELECT} WHERE f.status = $1 AND ${where} ORDER BY f.created_at DESC LIMIT $2`, params)).rows;
      return { items: rows.map((r) => this.toFlag(user, r)) };
    });
  }

  private async load(db: pg.PoolClient, id: string): Promise<FlagRow> {
    const r = (await db.query<FlagRow>(`${SELECT} WHERE f.id = $1 FOR UPDATE OF f`, [id])).rows[0];
    if (!r) throw new NotFoundException('Flag not found');
    return r;
  }

  async resolve(user: AuthenticatedUser, id: string, dto: ResolveFlagDto, ip: string | null): Promise<AttendanceFlag> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.load(db, id);
      if (r.user_id === user.id) throw new ForbiddenException('You cannot resolve a flag about yourself');
      if (!this.inScope(user, r)) throw new NotFoundException('Flag not found');
      if (r.status !== 'OPEN') return this.toFlag(user, r);
      await db.query(`UPDATE attendance_flags SET status = 'RESOLVED', resolution = $2, resolution_note = $3, resolved_by = $4, resolved_at = now() WHERE id = $1`,
        [id, dto.resolution, dto.note, user.id]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'ATTENDANCE_FLAG_RESOLVED', entityType: 'ATTENDANCE_FLAG', entityId: id,
        before: { status: 'OPEN' }, after: { kind: r.kind, subject: r.user_id, resolution: dto.resolution }, ip: ip ?? undefined });
      return this.toFlag(user, await this.load(db, id));
    });
  }

  async comment(user: AuthenticatedUser, id: string, dto: FlagCommentDto, ip: string | null): Promise<AttendanceFlag> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.load(db, id);
      if (r.user_id !== user.id) throw new NotFoundException('Flag not found');
      await db.query(`UPDATE attendance_flags SET user_comment = $2, user_comment_at = now() WHERE id = $1`, [id, dto.comment]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'ATTENDANCE_FLAG_COMMENTED', entityType: 'ATTENDANCE_FLAG', entityId: id, after: { kind: r.kind }, ip: ip ?? undefined });
      return this.toFlag(user, await this.load(db, id));
    });
  }
}
