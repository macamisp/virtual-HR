# ADR 064: Board games in progress survive an API restart

Date: 2026-11-16. Status: proposed (built and tested locally on `integration/local-qa-2026-11-16`; not
pushed, not deployed). Related: FR-VO-017; ADR 062 (board games), ADR 048 (leave grace), ADR 059
(office presence store, same write pattern).

## Context

ADR 062 kept running chess and checkers games in the office world's memory, so a deploy or a crash
ended every game. The V3 release candidate listed this as limit L1. The requirement is to keep
server-side move validation, invitations, acceptance, resignation and tenant isolation exactly as
they are.

## Decision

1. **The world stays the source of truth; the database follows it.**
   - A new table `office_board_games` holds one row per game in progress: organisation, floor, table,
     kind, the two players and the rules engine's state as JSON.
   - Rows are written by `OfficeBoardStore`:
     - inserted when an invitation is accepted;
     - updated after every move the rules accepted (refused moves never reach it);
     - deleted when the game ends (result, resignation, a player left).
   - Nothing is kept once a game is over: no history and no scores.
   - Writes are queued per game and never block or fail the game. A failure is counted and logged
     by its error code only.
2. **Restore on load.**
   - When an organisation's office world loads (first use after a start), the store reads that
     organisation's rows inside its tenant transaction.
   - Each row's state is checked with `BoardStateSchema` (shared, Zod).
   - Rows are deleted instead of restored when they:
     - do not parse;
     - are older than 2 hours;
     - have a result already;
     - name a table the map no longer has.
   - Player names come from the users table.
   - An admin reload of the office now carries the in-memory games and invitations across. They used
     to be dropped.
3. **Resume window.**
   - A restored game waits up to `OFFICE_BOARD_RESUME_MS` (default 2 minutes) for both players to
     come back. The client rejoins on reconnect, and the server sends the running game on join, as
     after a reload.
   - Once both are back, the normal rule applies again: a player who leaves loses.
   - If only one comes back in time, they win (`left`). If neither comes back, the game ends without
     a winner.
4. **Tenant isolation in the database as well as in the world:**
   - RLS enabled and forced, with the standard `app.org_id` policy;
   - both players bound to the game's organisation by composite foreign keys to `users(org_id, id)`;
   - at most one game per table (unique index), two different players, and a state of the same kind
     as the game (check constraints);
   - no TRUNCATE for the application role, and DELETE for the retention role.
5. **Privacy.**
   - The data export lists a person's games in progress: kind, side, start, last move time and number
     of moves.
   - Anonymisation deletes the games they are in.
   - The table holds no position in the office, nothing about other activity, and nothing after the
     game.

## Consequences and limits

- **Graceful stop:** sockets drop, and with the leave grace above 0 (the default) nothing ends, so
  the rows remain. With `OFFICE_LEAVE_GRACE_MS=0` a dropped socket ends the game as before.
- **Last move before a stop:** the store flushes queued writes when the module is destroyed (best
  effort). A move accepted in the last few milliseconds before a crash may not be written; the game
  then resumes one move earlier.
- **Invitations** are still in memory only. An open invitation lapses with a restart (they last
  30 s).
- **One process:** the office world is one per process, as before. Running two API processes for one
  organisation's office was already unsupported.

## Migration and rollback

- **Migration:** `20261116120000_office_board_games` is additive (one new table) and needs no data
  backfill.
- **Rollback:** `apps/api/prisma/rollback/20261116120000_office_board_games.down.sql`, after the previous
  API is running again. It loses only the games in progress.
- **Rehearsal (2026-11-16):** on the disposable `hrvo_qa_boards`, restored from
  `hrvo_demo-pre-v3-final-20261116T0842Z.dump`:
  - apply: table with RLS forced, one policy, grants as above;
  - rollback: table and migration row gone;
  - re-apply: same state; `prisma migrate diff`: no difference.
- **Then applied to the local `hrvo_demo`:** 40 migrations, up to date.

## Tests

- `office-board-restart-e2e`, 5 tests, real socket and a second API instance on the same database:
  - written at the start and after every accepted move; deleted at the end; an admin reload keeps
    the game;
  - after a restart, the same position and players come back and play goes on, with turn and
    legality still enforced;
  - a player who does not return loses after the resume window;
  - stale and unreadable rows are deleted, not restored;
  - RLS (no row and no update for another organisation, insert refused with 42501), a player from
    another organisation refused (23503), one game per table (23505), two different players (23514),
    no TRUNCATE.
- `board-game-rules`: the stored state survives a JSON round trip after real moves; damaged
  states are refused.
- `office-board-e2e` (6) and `privacy-e2e` unchanged and passing.
