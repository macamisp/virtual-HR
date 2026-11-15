/**
 * Office connection intervals (ADR 059, FR-REP-009): when each person was connected to the virtual
 * office, timed by this server. Written from the office world's own lifecycle, never from the
 * movement stream, and never about where the person was or what they did.
 *
 * States of one person (one avatar per person, however many tabs):
 *
 *   not connected --first office socket joins--> OPEN (started_at = now)
 *   OPEN --a socket drops, others remain--> OPEN (nothing written)
 *   OPEN --last socket drops--> in grace (nothing written yet; the drop time is kept in memory)
 *   in grace --a socket of the same sign-in rejoins within the grace--> OPEN, same interval: the
 *            few seconds of the reload are bridged (included), so a reload never splits or ends it
 *   in grace --grace runs out, or a new sign-in replaces the avatar--> CLOSED at the drop time,
 *            reason DROPPED: the grace itself is never counted
 *   OPEN --leaves the office (or the grace is 0)--> CLOSED now, reason LEFT (or DROPPED)
 *   OPEN --API stops or crashes--> stays open; last_seen_at is at most about a minute old. It is
 *            CLOSED at its last_seen_at, reason SERVER_RESTART, as soon as the person connects
 *            again, or by the sweep once nobody has refreshed it for three minutes (at startup and
 *            every minute). The sweep never touches intervals another live process keeps fresh.
 *
 * While connected, last_seen_at is refreshed once a minute for everyone in each loaded office
 * (one UPDATE per organisation), and anything left open but not refreshed for three minutes is
 * closed at its last_seen_at. Every write is queued per person (so an open never overtakes the
 * close before it) and every failure is caught and counted: the office never waits for, or fails
 * because of, this table. Attendance is not touched.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { OfficeRegistry } from './office-registry.ts';

export type OfficeEndReason = 'LEFT' | 'DROPPED' | 'SERVER_RESTART';

/** How often last_seen_at is refreshed for connected people. */
export const PRESENCE_REFRESH_MS = 60_000;
/** An open interval not refreshed for this long belongs to nobody any more (a lost write). */
export const PRESENCE_STALE_MS = 180_000;

@Injectable()
export class OfficePresenceStore implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OfficePresence');
  private readonly queues = new Map<string, Promise<void>>();
  /** People whose open interval this process opened (anything else open for them is a leftover). */
  private readonly mine = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  /** For tests and the operator: writes done and writes that failed (never thrown). */
  readonly stats = { writes: 0, failures: 0, recovered: 0 };
  /** Tests replace the clock-driven refresh with explicit calls. */
  readonly refreshMs = Math.max(0, Number(process.env.OFFICE_PRESENCE_REFRESH_MS ?? PRESENCE_REFRESH_MS) || 0);

  constructor(private readonly prisma: PrismaService, private readonly registry: OfficeRegistry) {}

  async onModuleInit(): Promise<void> {
    // Before the server accepts connections: what a stopped process left open ends where it was last seen.
    this.stats.recovered += await this.closeStale(Date.now() - PRESENCE_STALE_MS);
    if (this.refreshMs > 0) {
      this.timer = setInterval(() => void this.refresh(), this.refreshMs);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Waits for every queued write (tests and shutdown). */
  async flush(): Promise<void> {
    while (this.queues.size) await Promise.all([...this.queues.values()]);
  }

  /** The person's first office connection (no avatar yet). */
  opened(orgId: string, userId: string, at: number): void {
    const key = `${orgId}:${userId}`;
    // Two tabs joining at the same moment both create the avatar: the second keeps the first's interval.
    const leftover = !this.mine.has(key);
    this.mine.add(key);
    this.enqueue(orgId, userId, async () => {
      await this.prisma.runWithTenantContext(orgId, async (db) => {
        // Open from a previous process (a restart) or a lost write: it ended where it was last seen.
        if (leftover) {
          await db.query(
            `UPDATE office_presence_intervals SET ended_at = GREATEST(started_at, LEAST(last_seen_at, $3)), end_reason = 'SERVER_RESTART'
             WHERE org_id = $1 AND user_id = $2 AND ended_at IS NULL`,
            [orgId, userId, new Date(at)],
          );
        }
        await db.query(
          `INSERT INTO office_presence_intervals (org_id, user_id, started_at, last_seen_at) VALUES ($1, $2, $3, $3)
           ON CONFLICT (org_id, user_id) WHERE ended_at IS NULL DO NOTHING`,
          [orgId, userId, new Date(at)],
        );
      });
    });
  }

  /** The person is no longer connected, since `at` (the drop, or the moment they left). */
  closed(orgId: string, userId: string, at: number, reason: Exclude<OfficeEndReason, 'SERVER_RESTART'>): void {
    this.mine.delete(`${orgId}:${userId}`);
    this.enqueue(orgId, userId, async () => {
      await this.prisma.runWithTenantContext(orgId, (db) => db.query(
        `UPDATE office_presence_intervals SET ended_at = GREATEST(started_at, $3), end_reason = $4
         WHERE org_id = $1 AND user_id = $2 AND ended_at IS NULL`,
        [orgId, userId, new Date(at), reason],
      ));
    });
  }

  /** Once a minute: everyone connected was seen now; intervals nobody refreshes are closed. */
  async refresh(now: number = Date.now()): Promise<void> {
    for (const w of await this.registry.loaded()) {
      const present = [...w.avatars.values()].filter((a) => a.goneAt === null).map((a) => a.userId);
      if (!present.length) continue;
      try {
        await this.prisma.runWithTenantContext(w.orgId, (db) => db.query(
          `UPDATE office_presence_intervals SET last_seen_at = GREATEST(last_seen_at, $3)
           WHERE org_id = $1 AND user_id = ANY($2::uuid[]) AND ended_at IS NULL`,
          [w.orgId, present, new Date(now)],
        ));
        this.stats.writes += 1;
      } catch (err) {
        this.failed('refresh', err);
      }
    }
    await this.closeStale(now - PRESENCE_STALE_MS);
  }

  /** Closes every open interval last seen before `before`, at its last_seen_at. Returns how many. */
  async closeStale(before: number): Promise<number> {
    try {
      const r = await this.prisma.getPool().query<{ n: number }>(`SELECT fn_close_stale_office_presence($1) AS n`, [new Date(before)]);
      this.stats.writes += 1;
      return Number(r.rows[0]?.n ?? 0);
    } catch (err) {
      this.failed('close-stale', err);
      return 0;
    }
  }

  private enqueue(orgId: string, userId: string, write: () => Promise<unknown>): void {
    const key = `${orgId}:${userId}`;
    const next = (this.queues.get(key) ?? Promise.resolve())
      .then(write)
      .then(() => { this.stats.writes += 1; }, (err: unknown) => this.failed('write', err))
      .finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); });
    this.queues.set(key, next);
  }

  private failed(what: string, err: unknown): void {
    this.stats.failures += 1;
    // The error code only: no user, organisation or SQL parameter in the log.
    this.log.warn(`office presence ${what} failed (${(err as { code?: string }).code ?? 'error'})`);
  }
}
