/**
 * Board games in progress, kept in the database so that an API restart does not end them
 * (ADR 064, FR-VO-017). The office world stays the source of truth while the process runs: every
 * accepted change is written behind it, and the rows are read back only when an organisation's
 * office is loaded (first use after a start, or an admin reload).
 *
 *   invitation accepted --> row inserted (state after no moves)
 *   move accepted       --> row updated (state, updated_at)
 *   game over (result, resignation, a player left) --> row deleted: nothing is kept afterwards
 *
 * Writes are queued per game (a move never overtakes the insert before it). A failed write is
 * caught, counted and logged by its error code only: the game in the office never waits for, or
 * fails because of, this table. Rules, invitations, turns and tenant checks are unchanged: they run
 * in the world and the gateway before anything is written.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type pg from 'pg';
import { BoardStateSchema, type BoardGameKind } from '../../../../packages/shared/src/office/index.ts';
import { PrismaService } from '../common/prisma.service.ts';
import type { BoardGame } from './office-world.ts';

/** After a restart, how long the two players have to come back before the game ends (they left). */
export const boardResumeMs = (): number => Math.max(0, Number(process.env.OFFICE_BOARD_RESUME_MS ?? 120_000) || 0);
/** A game nobody has moved in for this long is over (an office closed for the night); not restored. */
export const BOARD_STALE_MS = 2 * 60 * 60 * 1000;

interface Row { id: string; floor_id: string; table_id: number; kind: string; white_id: string; black_id: string; state: unknown; white_name: string; black_name: string; updated_at: Date }

@Injectable()
export class OfficeBoardStore implements OnModuleDestroy {
  private readonly log = new Logger('OfficeBoards');
  private readonly queues = new Map<string, Promise<void>>();
  /** For tests and the operator: writes done, writes that failed, games restored. */
  readonly stats = { writes: 0, failures: 0, restored: 0, dropped: 0 };

  constructor(private readonly prisma: PrismaService) {}

  /** A stop: the writes already queued go out first (best effort; a failure is only counted). */
  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }

  /**
   * The games in progress of one organisation, inside its tenant transaction. Stale games, games
   * whose state does not parse and games for a table the map no longer has are deleted instead.
   */
  async load(db: pg.PoolClient, orgId: string, now: number, tableExists: (floorId: string, tableId: number, kind: BoardGameKind) => boolean): Promise<BoardGame[]> {
    const rows = (await db.query<Row>(
      `SELECT g.id, g.floor_id, g.table_id, g.kind, g.white_id, g.black_id, g.state, g.updated_at,
              COALESCE(w.display_name, w.email) AS white_name, COALESCE(b.display_name, b.email) AS black_name
         FROM office_board_games g
         JOIN users w ON w.org_id = g.org_id AND w.id = g.white_id
         JOIN users b ON b.org_id = g.org_id AND b.id = g.black_id
        WHERE g.org_id = $1`,
      [orgId],
    )).rows;
    const games: BoardGame[] = [];
    const drop: string[] = [];
    for (const r of rows) {
      const state = BoardStateSchema.safeParse(r.state);
      const kind = r.kind === 'chess' || r.kind === 'checkers' ? r.kind : null;
      if (!state.success || !kind || state.data.kind !== kind || state.data.result || now - r.updated_at.getTime() > BOARD_STALE_MS || !tableExists(r.floor_id, r.table_id, kind)) {
        drop.push(r.id);
        continue;
      }
      games.push({
        id: r.id, kind, tableId: r.table_id, floorId: r.floor_id,
        white: { id: r.white_id, name: r.white_name }, black: { id: r.black_id, name: r.black_name },
        state: state.data, resumeBy: now + boardResumeMs(),
      });
    }
    if (drop.length) await db.query(`DELETE FROM office_board_games WHERE org_id = $1 AND id = ANY($2::uuid[])`, [orgId, drop]);
    this.stats.restored += games.length;
    this.stats.dropped += drop.length;
    return games;
  }

  /** The game as it is now (started, or after an accepted move). */
  saved(orgId: string, g: BoardGame, at: number): void {
    const state = JSON.stringify(g.state);
    this.enqueue(g.id, () => this.prisma.runWithTenantContext(orgId, (db) => db.query(
      `INSERT INTO office_board_games (id, org_id, floor_id, table_id, kind, white_id, black_id, state, started_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9)
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = GREATEST(office_board_games.updated_at, EXCLUDED.updated_at)
       WHERE office_board_games.org_id = EXCLUDED.org_id`,
      [g.id, orgId, g.floorId, g.tableId, g.kind, g.white.id, g.black.id, state, new Date(at)],
    )));
  }

  /** The game is over: its row goes. */
  ended(orgId: string, gameId: string): void {
    this.enqueue(gameId, () => this.prisma.runWithTenantContext(orgId, (db) => db.query(
      `DELETE FROM office_board_games WHERE org_id = $1 AND id = $2`, [orgId, gameId],
    )));
  }

  /** Waits for every queued write (tests and shutdown). */
  async flush(): Promise<void> {
    while (this.queues.size) await Promise.all([...this.queues.values()]);
  }

  private enqueue(key: string, write: () => Promise<unknown>): void {
    const next = (this.queues.get(key) ?? Promise.resolve())
      .then(write)
      .then(() => { this.stats.writes += 1; }, (err: unknown) => this.failed(err))
      .finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); });
    this.queues.set(key, next);
  }

  private failed(err: unknown): void {
    this.stats.failures += 1;
    // The error code only: no user, organisation, position or SQL parameter in the log.
    this.log.warn(`office board write failed (${(err as { code?: string }).code ?? 'error'})`);
  }
}
