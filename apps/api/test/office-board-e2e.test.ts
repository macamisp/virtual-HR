/**
 * Board games end to end (FR-VO-017, ADR 062) over the real office socket: two people at the
 * arcade's chess table; an invitation reaches only the person invited; Decline, Accept, moves
 * checked by the server (out of turn, illegal, not your game), fool's mate ends the game for both,
 * checkers on the same table, resigning, and leaving ends the game. Refused: away from the table,
 * yourself, someone in another organisation, a second game at a busy table. Nothing is stored.
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
import { squareOf } from '../../../packages/shared/src/office/board-games.ts';
import type { BoardAck, BoardInviteClosed, BoardInviteMessage, BoardSnapshot } from '../../../packages/shared/src/office/board-games.ts';
import type { JoinAck, MoveAck, TeleportAck } from '../../../packages/shared/src/office/index.ts';
import { resetOrgs } from './support/reset-orgs.ts';

const ORG = 'f1f70000-0000-4000-8000-000000000001';
const OTHER = 'f1f70000-0000-4000-8000-000000000002';
const PORT = 3119;
const PASSWORD = 'ComplexPassword123!';
const U = {
  a: { id: 'f1f70000-0000-4000-8000-000000000011', org: ORG, email: 'ana@board.test', name: 'Ana Board' },
  b: { id: 'f1f70000-0000-4000-8000-000000000012', org: ORG, email: 'bo@board.test', name: 'Bo Board' },
  c: { id: 'f1f70000-0000-4000-8000-000000000013', org: ORG, email: 'cy@board.test', name: 'Cy Board' },
  o: { id: 'f1f70000-0000-4000-8000-000000000021', org: OTHER, email: 'oz@board-other.test', name: 'Oz Other' },
} as const;
type Who = keyof typeof U;
/** The default map's chess table: tiles 93-94 x 26-27 (object id looked up after joining). */
const TABLE_FRONT = { y: 28 * 32 + 20 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mv = (from: string, to: string) => ({ from: squareOf(from), to: squareOf(to) });

describe('Board games over the office socket (ADR 062)', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  const base = `http://localhost:${PORT}`;
  const tokens = {} as Record<Who, string>;
  const sockets: Socket[] = [];
  let tableId = 0;

  async function office(who: Who) {
    const s = io(base, { transports: ['websocket'], reconnection: false, auth: { token: tokens[who], purpose: 'office' } });
    sockets.push(s);
    await new Promise<void>((res, rej) => { s.once('connect', () => res()); s.once('connect_error', rej); });
    const inbox = { invites: [] as BoardInviteMessage[], closed: [] as BoardInviteClosed[], boards: [] as BoardSnapshot[] };
    s.on('office:board-invite', (m: BoardInviteMessage) => inbox.invites.push(m));
    s.on('office:board-invite-closed', (m: BoardInviteClosed) => inbox.closed.push(m));
    s.on('office:board', (m: BoardSnapshot) => inbox.boards.push(m));
    const join = (await s.emitWithAck('office:join', { positions: true })) as JoinAck;
    assert.ok(join.ok, `${who} joins`);
    const call = <T>(event: string, body: unknown = {}) => s.emitWithAck(event, body) as Promise<T>;
    return {
      s, inbox, call,
      invite: (to: Who, kind: 'chess' | 'checkers' = 'chess', table = tableId) => call<BoardAck>('office:board-invite', { to: U[to].id, tableId: table, kind }),
      answer: (id: string, accept: boolean) => call<BoardAck>('office:board-answer', { id, accept }),
      move: (id: string, m: { from: number; to: number }) => call<BoardAck>('office:board-move', { id, ...m }),
      resign: (id: string) => call<BoardAck>('office:board-resign', { id }),
      last: () => inbox.boards[inbox.boards.length - 1]!,
    };
  }
  type Office = Awaited<ReturnType<typeof office>>;

  /** Teleports into the arcade, then walks in validated steps to a point in front of the chess table. */
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

  let A: Office;
  let B: Office;
  let C: Office;
  let O: Office;

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    process.env.OFFICE_LEAVE_GRACE_MS = '0';
    process.env.OFFICE_BOARD_INVITE_TTL_MS = '1500';
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await resetOrgs(adminPool, [ORG, OTHER]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Board Ltd', 'board-e2e'), ($2, 'Board Other Ltd', 'board-other-e2e')`, [ORG, OTHER]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(U)) await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status) VALUES ($1, $2, $3, $4, 'EMPLOYEE', $5, 'ACTIVE')`, [u.id, u.org, u.email, u.name, hash]);
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
      assert.ok(tokens[who], `login ${who}`);
    }
    A = await office('a');
    B = await office('b');
    C = await office('c');
    O = await office('o');
    const map = (await adminPool.query<{ map_json: { floors: Array<{ map: { layers: Array<{ name: string; objects?: Array<{ id: number; properties?: Array<{ name: string; value: unknown }> }> }> } }> } }>(`SELECT map_json FROM offices WHERE org_id = $1`, [ORG])).rows[0]!.map_json;
    const furniture = map.floors[0]!.map.layers.find((l) => l.name === 'furniture')!.objects!;
    tableId = furniture.find((f) => f.properties?.some((p) => p.name === 'kind' && p.value === 'chess-table'))!.id;
  });

  after(async () => {
    for (const s of sockets) s.disconnect();
    await app?.close();
    await resetOrgs(adminPool, [ORG, OTHER]);
    await adminPool.end();
    delete process.env.OFFICE_BOARD_INVITE_TTL_MS;
  });

  it('refused away from the table, for yourself, for someone not at the table, at a table without the game', async () => {
    assert.deepEqual(await A.invite('b'), { ok: false, error: 'Walk up to the table first', code: 'TOO_FAR' });
    await toTable(A, 2990);
    assert.equal(((await A.invite('a')) as { code?: string }).code, 'SELF');
    assert.equal(((await A.invite('b')) as { code?: string }).code, 'TOO_FAR', 'Bo is not at the table');
    assert.equal(((await A.invite('b', 'chess', 1)) as { code?: string }).code, 'NO_TABLE');
  });

  it('another organisation cannot be invited (they are not in this office)', async () => {
    await wait(3100); // invitation cooldown
    const r = await A.call<BoardAck>('office:board-invite', { to: U.o.id, tableId, kind: 'chess' });
    assert.equal((r as { code?: string }).code, 'NOT_FOUND');
    assert.equal(O.inbox.invites.length, 0);
  });

  it('an invitation reaches only the person invited; Decline tells both; it also times out', async () => {
    await toTable(B, 3030);
    await wait(3100);
    const sent = await A.invite('b');
    assert.ok(sent.ok, JSON.stringify(sent));
    await wait(150);
    assert.deepEqual(B.inbox.invites.map((i) => [i.from, i.kind, i.tableId]), [[U.a.id, 'chess', tableId]]);
    assert.equal(C.inbox.invites.length + O.inbox.invites.length, 0, 'nobody else is told');
    assert.equal(((await C.answer(sent.ok ? sent.id! : '', true)) as { code?: string }).code, 'NOT_OPEN', 'only Bo can answer');
    assert.ok((await B.answer(sent.ok ? sent.id! : '', false)).ok);
    await wait(150);
    assert.deepEqual([A, B].map((o) => o.inbox.closed.at(-1)?.reason), ['declined', 'declined']);
    await wait(3100);
    const again = await A.invite('b');
    assert.ok(again.ok);
    await wait(1800);
    assert.deepEqual([A, B].map((o) => o.inbox.closed.at(-1)?.reason), ['timeout', 'timeout']);
  });

  it("chess: accepted, the inviter is white; the server refuses moves out of turn, illegal moves and other people's; fool's mate ends it for both", async () => {
    await wait(3100);
    const sent = await A.invite('b');
    assert.ok(sent.ok);
    await wait(150);
    const accepted = await B.answer(B.inbox.invites.at(-1)!.id, true);
    assert.ok(accepted.ok, JSON.stringify(accepted));
    await wait(150);
    const g = A.last();
    assert.equal(g.id, B.last().id);
    assert.deepEqual([g.white.id, g.black.id, g.kind, g.state.turn], [U.a.id, U.b.id, 'chess', 'w']);
    assert.equal(((await B.move(g.id, mv('e7', 'e5'))) as { code?: string }).code, 'NOT_YOUR_TURN');
    assert.equal(((await A.move(g.id, mv('e2', 'e5'))) as { code?: string }).code, 'ILLEGAL');
    assert.equal(((await C.move(g.id, mv('e2', 'e4'))) as { code?: string }).code, 'NOT_FOUND', 'not their game');
    for (const [o, m] of [[A, mv('f2', 'f3')], [B, mv('e7', 'e5')], [A, mv('g2', 'g4')], [B, mv('d8', 'h4')]] as const) {
      const r = await o.move(g.id, m);
      assert.ok(r.ok, JSON.stringify(r));
    }
    await wait(150);
    for (const o of [A, B]) {
      assert.deepEqual(o.last().state.result, { winner: 'b', reason: 'checkmate' });
      assert.equal(o.last().check, true);
    }
    assert.equal(((await A.move(g.id, mv('a2', 'a3'))) as { code?: string }).code, 'NOT_FOUND', 'the game is over');
  });

  it('checkers at the same table; a busy table refuses a second game; resigning ends it for both', async () => {
    await wait(3100);
    const sent = await A.invite('b', 'checkers');
    assert.ok(sent.ok);
    await wait(150);
    assert.ok((await B.answer(B.inbox.invites.at(-1)!.id, true)).ok);
    await wait(150);
    const g = A.last();
    assert.equal(g.kind, 'checkers');
    assert.equal(g.state.board.filter((p) => p === 'wM').length, 12);
    assert.ok((await A.move(g.id, mv('c3', 'd4'))).ok);
    await toTable(C, 3010);
    assert.equal(((await C.invite('a', 'chess')) as { code?: string }).code, 'BUSY', 'the table is in use');
    assert.ok((await B.resign(g.id)).ok);
    await wait(150);
    for (const o of [A, B]) assert.deepEqual(o.last().state.result, { winner: 'w', reason: 'resigned' });
  });

  it('leaving the office ends a game: the other player wins', async () => {
    await wait(3100);
    const sent = await A.invite('b', 'chess');
    assert.ok(sent.ok, JSON.stringify(sent));
    await wait(150);
    assert.ok((await B.answer(B.inbox.invites.at(-1)!.id, true)).ok);
    await wait(150);
    assert.ok((await A.call('office:leave')));
    await wait(300);
    assert.deepEqual(B.last().state.result, { winner: 'b', reason: 'left' });
  });
});
