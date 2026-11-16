/**
 * Board games survive an API restart (ADR 064, FR-VO-017), over the real office socket and a real
 * second API instance on the same database:
 * - the game is written behind the world: at the start, after every accepted move, and deleted
 *   when it ends (nothing kept afterwards); an admin reload of the office keeps it;
 * - after a restart both players get the same position back on joining and play on, with the
 *   server still checking turns and moves;
 * - a player who does not come back within the resume window loses (they left);
 * - stale or unreadable rows are not restored, they are deleted;
 * - the table is tenant-bound: another organisation sees no row, and a player from another
 *   organisation is refused by the database.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { io, type Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { OfficeBoardStore } from '../src/office/office-boards.ts';
import { OfficeRegistry } from '../src/office/office-registry.ts';
import { newBoard, squareOf } from '../../../packages/shared/src/office/board-games.ts';
import type { BoardAck, BoardInviteMessage, BoardSnapshot } from '../../../packages/shared/src/office/board-games.ts';
import type { JoinAck, MoveAck, TeleportAck } from '../../../packages/shared/src/office/index.ts';
import { resetOrgs } from './support/reset-orgs.ts';

const ORG = 'f1f90000-0000-4000-8000-000000000001';
const OTHER = 'f1f90000-0000-4000-8000-000000000002';
const PORT = 3121;
const PASSWORD = 'ComplexPassword123!';
const U = {
  a: { id: 'f1f90000-0000-4000-8000-000000000011', org: ORG, email: 'ana@board-restart.test', name: 'Ana Restart' },
  b: { id: 'f1f90000-0000-4000-8000-000000000012', org: ORG, email: 'bo@board-restart.test', name: 'Bo Restart' },
  c: { id: 'f1f90000-0000-4000-8000-000000000013', org: ORG, email: 'cy@board-restart.test', name: 'Cy Restart' },
  o: { id: 'f1f90000-0000-4000-8000-000000000021', org: OTHER, email: 'oz@board-restart-other.test', name: 'Oz Other' },
} as const;
type Who = keyof typeof U;
const TABLE_FRONT = { y: 28 * 32 + 20 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mv = (from: string, to: string) => ({ from: squareOf(from), to: squareOf(to) });

interface Row { id: string; kind: string; white_id: string; black_id: string; state: { plies: number; turn: string; board: Array<string | null> } }

describe('Board games survive an API restart (ADR 064)', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  const base = `http://localhost:${PORT}`;
  const tokens = {} as Record<Who, string>;
  let sockets: Socket[] = [];
  let tableId = 0;
  let floorId = '';

  async function start(): Promise<void> {
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
  }
  /** A stop as in production (sockets drop with the server; the leave grace is the default). */
  async function restart(): Promise<void> {
    await app.get(OfficeBoardStore).flush();
    await app.close();
    sockets = [];
    await start();
  }
  const flush = () => app.get(OfficeBoardStore).flush();
  const rows = async () => (await adminPool.query<Row>(`SELECT id, kind, white_id, black_id, state FROM office_board_games WHERE org_id = $1 ORDER BY started_at`, [ORG])).rows;

  async function office(who: Who) {
    const s = io(base, { transports: ['websocket'], reconnection: false, auth: { token: tokens[who], purpose: 'office' } });
    sockets.push(s);
    await new Promise<void>((res, rej) => { s.once('connect', () => res()); s.once('connect_error', rej); });
    const inbox = { invites: [] as BoardInviteMessage[], boards: [] as BoardSnapshot[] };
    s.on('office:board-invite', (m: BoardInviteMessage) => inbox.invites.push(m));
    s.on('office:board', (m: BoardSnapshot) => inbox.boards.push(m));
    const join = (await s.emitWithAck('office:join', { positions: true })) as JoinAck;
    assert.ok(join.ok, `${who} joins`);
    const call = <T>(event: string, body: unknown = {}) => s.emitWithAck(event, body) as Promise<T>;
    return {
      s, inbox, call,
      invite: (to: Who, kind: 'chess' | 'checkers' = 'chess') => call<BoardAck>('office:board-invite', { to: U[to].id, tableId, kind }),
      answer: (id: string, accept: boolean) => call<BoardAck>('office:board-answer', { id, accept }),
      move: (id: string, m: { from: number; to: number }) => call<BoardAck>('office:board-move', { id, ...m }),
      resign: (id: string) => call<BoardAck>('office:board-resign', { id }),
      last: () => inbox.boards[inbox.boards.length - 1],
    };
  }
  type Office = Awaited<ReturnType<typeof office>>;

  async function toTable(o: Office, x: number): Promise<void> {
    const room = (await adminPool.query<{ id: string }>(`SELECT r.id FROM rooms r JOIN offices f ON f.id = r.office_id WHERE f.org_id = $1 AND r.name = 'Arcade'`, [ORG])).rows[0]!;
    const t = await o.call<TeleportAck & { x?: number; y?: number }>('office:teleport', { kind: 'room', roomId: room.id });
    assert.ok(t.ok && typeof t.x === 'number' && typeof t.y === 'number', JSON.stringify(t));
    let at = { x: t.x!, y: t.y! };
    const target = { x, y: TABLE_FRONT.y };
    for (let i = 0; i < 40; i += 1) {
      const dx = target.x - at.x; const dy = target.y - at.y;
      const d = Math.hypot(dx, dy);
      if (d < 2) break;
      const k = Math.min(1, 18 / d);
      await wait(90);
      const next = { x: at.x + dx * k, y: at.y + dy * k };
      const r = await o.call<MoveAck>('office:move', { ...next, dir: 0 });
      assert.ok(r.ok, JSON.stringify(r));
      at = next;
    }
  }

  /** `white` invites `black` at the table; both accept and see the new board. */
  async function play(white: Office, black: Office, who: Who): Promise<BoardSnapshot> {
    await toTable(white, 2990);
    await toTable(black, 3010);
    const sent = await white.invite(who);
    assert.ok(sent.ok, JSON.stringify(sent));
    await wait(150);
    assert.ok((await black.answer(black.inbox.invites.at(-1)!.id, true)).ok);
    await wait(150);
    return white.last()!;
  }

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    process.env.OFFICE_LEAVE_GRACE_MS = '8000';
    process.env.OFFICE_BOARD_RESUME_MS = '120000';
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await resetOrgs(adminPool, [ORG, OTHER]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Board Restart Ltd', 'board-restart-e2e'), ($2, 'Board Restart Other', 'board-restart-other-e2e')`, [ORG, OTHER]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(U)) await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status) VALUES ($1, $2, $3, $4, 'EMPLOYEE', $5, 'ACTIVE')`, [u.id, u.org, u.email, u.name, hash]);
    await start();
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
      assert.ok(tokens[who], `login ${who}`);
    }
    // The office (and its map) is created on first join.
    await office('a');
    const map = (await adminPool.query<{ map_json: { floors: Array<{ id: string; map: { layers: Array<{ name: string; objects?: Array<{ id: number; properties?: Array<{ name: string; value: unknown }> }> }> } }> } }>(`SELECT map_json FROM offices WHERE org_id = $1`, [ORG])).rows[0]!.map_json;
    floorId = map.floors[0]!.id;
    tableId = map.floors[0]!.map.layers.find((l) => l.name === 'furniture')!.objects!.find((f) => f.properties?.some((p) => p.name === 'kind' && p.value === 'chess-table'))!.id;
    for (const s of sockets) s.disconnect();
    sockets = [];
    await wait(200);
  });

  after(async () => {
    for (const s of sockets) s.disconnect();
    await app?.close();
    await resetOrgs(adminPool, [ORG, OTHER]);
    await appPool.end();
    await adminPool.end();
    delete process.env.OFFICE_BOARD_RESUME_MS;
    delete process.env.OFFICE_LEAVE_GRACE_MS;
  });

  it('a game is written at the start and after every accepted move, and deleted when it ends', async () => {
    const A = await office('a');
    const B = await office('b');
    const g = await play(A, B, 'b');
    await flush();
    let r = await rows();
    assert.equal(r.length, 1);
    assert.deepEqual([r[0]!.id, r[0]!.kind, r[0]!.white_id, r[0]!.black_id, r[0]!.state.plies], [g.id, 'chess', U.a.id, U.b.id, 0]);
    assert.ok((await A.move(g.id, mv('e2', 'e4'))).ok);
    assert.equal(((await A.move(g.id, mv('d2', 'd4'))) as { code?: string }).code, 'NOT_YOUR_TURN', 'refused moves are not written');
    await flush();
    r = await rows();
    assert.deepEqual([r[0]!.state.plies, r[0]!.state.turn, r[0]!.state.board[squareOf('e4')]], [1, 'b', 'wP']);
    // An admin change reloads the office: the game goes on (it used to be dropped).
    await app.get(OfficeRegistry).reload(ORG);
    assert.ok((await B.move(g.id, mv('e7', 'e5'))).ok, 'still the same game after a reload');
    assert.ok((await B.resign(g.id)).ok);
    await flush();
    assert.equal((await rows()).length, 0, 'nothing is kept after the game');
    for (const s of sockets) s.disconnect();
    sockets = [];
    await wait(300);
  });

  it('after a restart both players get the same position back and play on; the rules still apply', async () => {
    await wait(3100); // the invitation cooldown
    let A = await office('a');
    let B = await office('b');
    const g = await play(A, B, 'b');
    assert.ok((await A.move(g.id, mv('e2', 'e4'))).ok);
    assert.ok((await B.move(g.id, mv('e7', 'e5'))).ok);
    await wait(100);
    const before = A.last()!.state;

    await restart();

    A = await office('a');
    B = await office('b');
    await wait(200);
    for (const o of [A, B]) {
      const back = o.last();
      assert.ok(back, 'the running game comes back on joining');
      assert.equal(back.id, g.id);
      assert.deepEqual(back.state, before, 'the same position, side to move and rule state');
      assert.deepEqual([back.white.name, back.black.name], [U.a.name, U.b.name]);
    }
    assert.equal(((await B.move(g.id, mv('d7', 'd5'))) as { code?: string }).code, 'NOT_YOUR_TURN');
    assert.equal(((await A.move(g.id, mv('e4', 'e5'))) as { code?: string }).code, 'ILLEGAL');
    assert.ok((await A.move(g.id, mv('g1', 'f3'))).ok, 'play goes on');
    await wait(150);
    assert.equal(B.last()!.state.plies, 3);
    await flush();
    assert.equal((await rows())[0]!.state.plies, 3);
    // Both are back, so leaving now ends the game as usual.
    assert.ok(await A.call('office:leave'));
    await wait(400);
    assert.deepEqual(B.last()!.state.result, { winner: 'b', reason: 'left' });
    await flush();
    assert.equal((await rows()).length, 0);
    for (const s of sockets) s.disconnect();
    sockets = [];
    await wait(300);
  });

  it('a player who does not come back within the resume window loses; the one who came back wins', async () => {
    await wait(3100);
    let A = await office('a');
    const C = await office('c');
    const g = await play(A, C, 'c');
    assert.ok((await A.move(g.id, mv('d2', 'd4'))).ok);
    process.env.OFFICE_BOARD_RESUME_MS = '1500';
    await restart();
    A = await office('a');
    await wait(300);
    assert.equal(A.last()?.id, g.id, 'restored while the other player may still come back');
    assert.equal(A.last()?.state.result, null);
    await wait(2000);
    assert.deepEqual(A.last()!.state.result, { winner: 'w', reason: 'left' });
    await flush();
    assert.equal((await rows()).length, 0);
    process.env.OFFICE_BOARD_RESUME_MS = '120000';
    for (const s of sockets) s.disconnect();
    sockets = [];
    await wait(300);
  });

  it('stale and unreadable rows are deleted at load, not restored', async () => {
    const ins = `INSERT INTO office_board_games (id, org_id, floor_id, table_id, kind, white_id, black_id, state, started_at, updated_at) VALUES ($1, $2, $3, $4, 'chess', $5, $6, $7::jsonb, $8, $8)`;
    const stale = 'f1f90000-0000-4000-8000-0000000000a1';
    const broken = 'f1f90000-0000-4000-8000-0000000000a2';
    await adminPool.query(ins, [stale, ORG, floorId, tableId, U.a.id, U.b.id, JSON.stringify(newBoard('chess')), new Date(Date.now() - 3 * 3600_000)]);
    await adminPool.query(ins, [broken, ORG, 'other-floor', tableId, U.a.id, U.c.id, JSON.stringify({ ...newBoard('chess'), board: ['wX'] }), new Date()]);
    await restart();
    const A = await office('a');
    await wait(300);
    assert.equal(A.last(), undefined, 'nothing restored');
    assert.equal((await rows()).length, 0, 'both rows deleted');
    for (const s of sockets) s.disconnect();
    sockets = [];
    await wait(300);
  });

  it('tenant-bound: another organisation sees no row, and a player from another organisation is refused', async () => {
    const id = 'f1f90000-0000-4000-8000-0000000000b1';
    const ins = `INSERT INTO office_board_games (id, org_id, floor_id, table_id, kind, white_id, black_id, state, started_at, updated_at) VALUES ($1, $2, $3, $4, 'chess', $5, $6, $7::jsonb, now(), now())`;
    await adminPool.query(ins, [id, ORG, floorId, tableId, U.a.id, U.b.id, JSON.stringify(newBoard('chess'))]);
    const seenAs = async (org: string) => {
      const c = await appPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
        const n = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM office_board_games`)).rows[0]!.n;
        // Writing another organisation's row is refused by the policy.
        const upd = (await c.query(`UPDATE office_board_games SET updated_at = now() WHERE id = $1`, [id])).rowCount;
        await c.query('ROLLBACK');
        return { n, upd };
      } finally { c.release(); }
    };
    assert.deepEqual(await seenAs(ORG), { n: 1, upd: 1 });
    assert.deepEqual(await seenAs(OTHER), { n: 0, upd: 0 });
    await assert.rejects(adminPool.query(ins, ['f1f90000-0000-4000-8000-0000000000b2', ORG, floorId, tableId + 1, U.a.id, U.o.id, JSON.stringify(newBoard('chess'))]), { code: '23503' }, 'a player from another organisation');
    await assert.rejects(adminPool.query(ins, ['f1f90000-0000-4000-8000-0000000000b3', ORG, floorId, tableId, U.a.id, U.c.id, JSON.stringify(newBoard('chess'))]), { code: '23505' }, 'one game per table');
    await assert.rejects(adminPool.query(ins, ['f1f90000-0000-4000-8000-0000000000b4', ORG, floorId, tableId + 2, U.a.id, U.a.id, JSON.stringify(newBoard('chess'))]), { code: '23514' }, 'two different players');
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [OTHER]);
      await assert.rejects(c.query(ins, ['f1f90000-0000-4000-8000-0000000000b5', ORG, floorId, tableId + 3, U.a.id, U.b.id, JSON.stringify(newBoard('chess'))]), { code: '42501' }, 'no row for another organisation');
      await c.query('ROLLBACK');
    } finally { c.release(); }
    const grants = (await adminPool.query<{ truncate: boolean; retention: boolean }>(`SELECT has_table_privilege('hrvo_app', 'office_board_games', 'TRUNCATE') AS truncate, has_table_privilege('hrvo_retention', 'office_board_games', 'DELETE') AS retention`)).rows[0]!;
    assert.deepEqual(grants, { truncate: false, retention: true });
    await adminPool.query(`DELETE FROM office_board_games WHERE id = $1`, [id]);
  });
});
