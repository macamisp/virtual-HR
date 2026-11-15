/**
 * Avatar actions end to end (ADR 056) over the real office socket: jump, wave and dance reach
 * everyone in the organisation through the roster (never another organisation, never the 10 Hz
 * positions); sitting needs a free chair in reach, in a room you may enter, not through a wall;
 * a hug or a high five needs the other person nearby and their explicit yes, and can be declined,
 * cancelled or left to lapse; leaving or dropping the connection clears it all; rate limits hold;
 * attendance is never touched.
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
import { generateDefaultFloor, mapRooms, mapSeats, SEAT_REACH } from '../../../packages/shared/src/office/index.ts';
import type {
  ActionAck, JoinAck, MoveAck, PairAck, PairClosedMessage, PairRequestMessage, PositionsMessage, RosterEntry, SitAck, TeleportAck,
} from '../../../packages/shared/src/office/index.ts';
import { resetOrgs } from './support/reset-orgs.ts';

const ORG = 'f1f10000-0000-4000-8000-000000000001';
const OTHER = 'f1f10000-0000-4000-8000-000000000002';
const PORT = 3091;
const PASSWORD = 'ComplexPassword123!';
const U = {
  a: { id: 'f1f10000-0000-4000-8000-000000000011', org: ORG, email: 'ana@act.test', name: 'Ana Act' },
  b: { id: 'f1f10000-0000-4000-8000-000000000012', org: ORG, email: 'bo@act.test', name: 'Bo Act' },
  c: { id: 'f1f10000-0000-4000-8000-000000000013', org: ORG, email: 'cy@act.test', name: 'Cy Act' },
  o: { id: 'f1f10000-0000-4000-8000-000000000021', org: OTHER, email: 'oz@act-other.test', name: 'Oz Other' },
} as const;
type Who = keyof typeof U;

const map = generateDefaultFloor();
const seats = mapSeats(map);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Avatar actions over the office socket (ADR 056)', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  const base = `http://localhost:${PORT}`;
  const tokens = {} as Record<Who, string>;
  const sockets: Socket[] = [];

  async function office(who: Who) {
    const s = io(base, { transports: ['websocket'], reconnection: false, auth: { token: tokens[who], purpose: 'office' } });
    sockets.push(s);
    await new Promise<void>((res, rej) => { s.once('connect', () => res()); s.once('connect_error', rej); });
    const inbox = { presence: [] as Array<RosterEntry | { id: string; gone: true }>, positions: [] as PositionsMessage[], requests: [] as PairRequestMessage[], closed: [] as PairClosedMessage[] };
    s.on('office:presence', (m: RosterEntry) => inbox.presence.push(m));
    s.on('office:positions', (m: PositionsMessage) => inbox.positions.push(m));
    s.on('office:pair-request', (m: PairRequestMessage) => inbox.requests.push(m));
    s.on('office:pair-closed', (m: PairClosedMessage) => inbox.closed.push(m));
    const join = (await s.emitWithAck('office:join', { positions: true })) as JoinAck;
    assert.ok(join.ok, `${who} joins`);
    const call = <T>(event: string, body: unknown = {}) => s.emitWithAck(event, body) as Promise<T>;
    const self = () => (join.ok ? join.self : { x: 0, y: 0 });
    return { s, inbox, join, self, call, act: (kind: string) => call<ActionAck>('office:action', { kind }), teleport: (dto: unknown) => call<TeleportAck>('office:teleport', dto) };
  }
  type Office = Awaited<ReturnType<typeof office>>;
  /** The latest roster entry `of` someone, as `o` received it. */
  const seen = (o: Office, id: string): RosterEntry | undefined => [...o.inbox.presence].reverse().find((p): p is RosterEntry => 'name' in p && p.id === id);
  /** Moves in legal 18 px steps every 100 ms from `from` to `to`. */
  async function walk(o: Office, from: { x: number; y: number }, to: { x: number; y: number }): Promise<MoveAck> {
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 18));
    let last: MoveAck = { ok: true, roomId: null };
    for (let i = 1; i <= steps; i += 1) {
      await wait(100);
      last = await o.call<MoveAck>('office:move', { x: Math.round(from.x + ((to.x - from.x) * i) / steps), y: Math.round(from.y + ((to.y - from.y) * i) / steps), dir: 0 });
      if (!last.ok) return last;
    }
    return last;
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
    process.env.OFFICE_LEAVE_GRACE_MS = '1500';
    process.env.OFFICE_PAIR_TTL_MS = '1500';
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await resetOrgs(adminPool, [ORG, OTHER]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Act Ltd', 'act-e2e'), ($2, 'Act Other Ltd', 'act-other-e2e')`, [ORG, OTHER]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status) VALUES ($1, $2, $3, $4, 'EMPLOYEE', $5, 'ACTIVE')`, [u.id, u.org, u.email, u.name, hash]);
    }
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
  });

  after(async () => {
    for (const s of sockets) s.disconnect();
    await app?.close();
    await resetOrgs(adminPool, [ORG, OTHER]);
    await adminPool.end();
    delete process.env.OFFICE_PAIR_TTL_MS;
  });

  it('jump, wave and dance reach the organisation by the roster only; stop ends a dance; bad input is refused', async () => {
    const pos0 = B.inbox.positions.length;
    const o0 = O.inbox.presence.length;
    assert.deepEqual(await A.act('wave'), { ok: true });
    await wait(250);
    assert.equal(seen(B, U.a.id)?.action?.kind, 'wave', 'a colleague sees the wave');
    assert.ok(!O.inbox.presence.slice(o0).some((p) => p.id === U.a.id), 'another organisation sees nothing');
    assert.ok(B.inbox.positions.slice(pos0).every((m) => m.u.every((e) => e.length === 8)), 'the position stream is unchanged');
    await A.act('dance');
    await wait(250);
    assert.equal(seen(B, U.a.id)?.action?.kind, 'dance');
    await A.act('stop');
    await wait(250);
    assert.equal(seen(B, U.a.id)?.action ?? null, null, 'stop ends the dance');
    await A.act('jump');
    await wait(900);
    assert.equal(seen(B, U.a.id)?.action ?? null, null, 'a jump ends by itself');
    for (const body of [{ kind: 'fly' }, { kind: 'wave', x: 1 }, {}, 'wave']) assert.equal((await A.call<ActionAck>('office:action', body)).ok, false, JSON.stringify(body));
  });

  it('actions are rate limited per person', async () => {
    let refused = 0;
    for (let i = 0; i < 12; i += 1) if (!(await C.act('wave')).ok) refused += 1;
    assert.ok(refused >= 4, `refused ${refused} of 12 in a burst`);
    await wait(5_100);
    assert.equal((await C.act('wave')).ok, true, 'allowed again after the window');
  });

  it('sitting: only a free chair within reach, not through walls, not in a room you may not enter; walking stands you up', async () => {
    const desk = seats.find((s) => s.id.startsWith('desk:'))!;
    assert.ok(!(await A.call<SitAck>('office:sit', { seatId: desk.id })).ok, 'too far from here');
    assert.equal((await A.call<SitAck>('office:sit', { seatId: 'desk:99999' })).ok, false, 'no such chair');
    assert.equal((await A.call<SitAck>('office:sit', { seatId: desk.id, extra: 1 })).ok, false, 'junk refused');
    // B goes to the café; the nearest chair is within reach of where the teleport puts them.
    const rooms = (await (await fetch(`${base}/office`, { headers: { Authorization: `Bearer ${tokens.b}` } })).json() as { rooms: Array<{ id: string; name: string }> }).rooms;
    const there = await B.teleport({ kind: 'room', roomId: rooms.find((r) => r.name === 'Café')!.id });
    assert.ok(there.ok);
    const at = there.ok ? { x: there.x, y: there.y } : { x: 0, y: 0 };
    const cafe = [...seats].sort((p, q) => Math.hypot(p.x - at.x, p.y - at.y) - Math.hypot(q.x - at.x, q.y - at.y))[0]!;
    assert.ok(Math.hypot(at.x - cafe.x, at.y - cafe.y) <= SEAT_REACH, 'a chair in reach');
    const sat = await B.call<SitAck>('office:sit', { seatId: cafe.id });
    assert.ok(sat.ok, JSON.stringify(sat));
    assert.deepEqual(sat.ok && { x: sat.x, y: sat.y }, { x: cafe.x, y: cafe.y }, 'placed on the chair');
    await wait(250);
    const sitting = seen(A, U.b.id)?.action;
    assert.deepEqual({ kind: sitting?.kind, seat: sitting?.seat, facing: sitting?.facing }, { kind: 'sit', seat: cafe.id, facing: cafe.facing });
    // C comes over and cannot take the same chair.
    await C.teleport({ kind: 'user', userId: U.b.id });
    const taken = await C.call<SitAck>('office:sit', { seatId: cafe.id });
    assert.equal(!taken.ok && taken.code, 'TAKEN');
    // Walking stands B up and frees the chair.
    const step = cafe.facing === 'right' ? { x: cafe.x - 18, y: cafe.y } : { x: cafe.x + 18, y: cafe.y };
    assert.ok((await walk(B, { x: cafe.x, y: cafe.y }, step)).ok);
    await wait(250);
    assert.equal(seen(A, U.b.id)?.action ?? null, null, 'standing again');
    // The board room's chairs (a knock room) cannot be sat on from outside it.
    const board = mapRooms(map).find((r) => r.name === 'Board room')!;
    const inside = seats.filter((s) => s.x > board.bounds.x && s.x < board.bounds.x + board.bounds.width && s.y > board.bounds.y && s.y < board.bounds.y + board.bounds.height);
    assert.equal(inside.length, 16, 'the board room has its 16 chairs');
    for (const s of inside.slice(0, 3)) assert.equal((await A.call<SitAck>('office:sit', { seatId: s.id })).ok, false);
  });

  it('hug and high five: refused when far or busy; asked, then accepted, declined, cancelled or timed out; never across organisations', async () => {
    // Far apart: refused.
    await A.teleport({ kind: 'floor', floorId: 'ground' });
    const far = await A.call<PairAck>('office:pair', { kind: 'hug', to: U.c.id });
    assert.equal(!far.ok && far.code, 'TOO_FAR');
    // Another organisation's person does not exist here.
    const other = await A.call<PairAck>('office:pair', { kind: 'hug', to: U.o.id });
    assert.equal(!other.ok && other.code, 'NOT_FOUND');
    assert.equal(O.inbox.requests.length, 0);
    // Next to each other: ask, C accepts, both animate.
    assert.ok((await A.teleport({ kind: 'user', userId: U.c.id })).ok);
    await wait(3_100); // past the per-person request cooldown
    const ask = await A.call<PairAck>('office:pair', { kind: 'hug', to: U.c.id });
    assert.ok(ask.ok, JSON.stringify(ask));
    await wait(150);
    const req = C.inbox.requests.at(-1)!;
    assert.deepEqual({ kind: req.kind, from: req.from, fromName: req.fromName }, { kind: 'hug', from: U.a.id, fromName: U.a.name });
    assert.equal(seen(B, U.a.id)?.action?.kind === 'hug', false, 'nothing happens before the answer');
    assert.equal(!(await A.call<PairAck>('office:pair', { kind: 'highfive', to: U.c.id })).ok, true, 'one request at a time');
    assert.deepEqual(await C.call<ActionAck>('office:pair-answer', { id: req.id, accept: true }), { ok: true });
    await wait(250);
    assert.equal(seen(B, U.a.id)?.action?.kind, 'hug');
    assert.equal(seen(B, U.a.id)?.action?.with, U.c.id);
    assert.equal(seen(B, U.c.id)?.action?.with, U.a.id);
    assert.equal(A.inbox.closed.at(-1)?.reason, 'accepted');
    // Someone else cannot answer for C.
    await wait(3_100);
    const ask2 = await A.call<PairAck>('office:pair', { kind: 'highfive', to: U.c.id });
    assert.ok(ask2.ok);
    assert.equal((await B.call<ActionAck>('office:pair-answer', { id: ask2.ok ? ask2.id : '', accept: true })).ok, false, 'only the person asked answers');
    // Declined.
    assert.deepEqual(await C.call<ActionAck>('office:pair-answer', { id: ask2.ok ? ask2.id : '', accept: false }), { ok: true });
    await wait(150);
    assert.equal(A.inbox.closed.at(-1)?.reason, 'declined');
    // Cancelled by the asker.
    await wait(3_100);
    const ask3 = await A.call<PairAck>('office:pair', { kind: 'highfive', to: U.c.id });
    assert.ok(ask3.ok);
    assert.deepEqual(await A.call<ActionAck>('office:pair-cancel', { id: ask3.ok ? ask3.id : '' }), { ok: true });
    await wait(150);
    assert.equal(C.inbox.closed.at(-1)?.reason, 'cancelled', 'the person asked is told');
    assert.equal((await C.call<ActionAck>('office:pair-answer', { id: ask3.ok ? ask3.id : '', accept: true })).ok, false, 'too late to accept');
    // Timed out (1.5 s in this test).
    await wait(3_100);
    const ask4 = await A.call<PairAck>('office:pair', { kind: 'highfive', to: U.c.id });
    assert.ok(ask4.ok);
    await wait(1_800);
    assert.equal(A.inbox.closed.at(-1)?.reason, 'timeout');
    assert.equal(C.inbox.closed.at(-1)?.reason, 'timeout');
    // Do not disturb is respected.
    await fetch(`${base}/office/me/status`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.c}` }, body: JSON.stringify({ status: 'DND' }) });
    await wait(3_100);
    const dnd = await A.call<PairAck>('office:pair', { kind: 'hug', to: U.c.id });
    assert.equal(!dnd.ok && dnd.code, 'BUSY');
    await fetch(`${base}/office/me/status`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.c}` }, body: JSON.stringify({ status: 'AUTO' }) });
    for (const body of [{ kind: 'kiss', to: U.c.id }, { kind: 'hug', to: 'not-a-uuid' }, { kind: 'hug', to: U.c.id, extra: true }]) assert.equal((await A.call<PairAck>('office:pair', body)).ok, false, JSON.stringify(body));
  });

  it('leaving clears the chair, the action and open requests; attendance is never touched', async () => {
    const before = await adminPool.query(`SELECT (SELECT count(*) FROM attendance_sessions WHERE org_id = $1)::int AS s, (SELECT count(*) FROM attendance_segments WHERE org_id = $1)::int AS g`, [ORG]);
    // C asks A, then C drops the connection: A is told, and the request is gone.
    await wait(3_100);
    const ask = await C.call<PairAck>('office:pair', { kind: 'highfive', to: U.a.id });
    assert.ok(ask.ok, JSON.stringify(ask));
    await A.act('dance');
    await wait(150);
    C.s.disconnect();
    await wait(400);
    assert.equal(A.inbox.closed.at(-1)?.reason, 'gone', 'the request ends with the connection');
    // A leaves while dancing: everyone sees A gone, the action with it.
    const b0 = B.inbox.presence.length;
    await A.call('office:leave');
    await wait(250);
    assert.ok(B.inbox.presence.slice(b0).some((p) => 'gone' in p && p.id === U.a.id));
    const after = await adminPool.query(`SELECT (SELECT count(*) FROM attendance_sessions WHERE org_id = $1)::int AS s, (SELECT count(*) FROM attendance_segments WHERE org_id = $1)::int AS g`, [ORG]);
    assert.deepEqual(after.rows[0], before.rows[0], 'no attendance session or segment was created or changed');
  });
});
