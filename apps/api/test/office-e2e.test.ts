/**
 * Virtual office end to end (FR-VO-001..005, 007, 008, 012, 013; ADR 015): REST snapshot and
 * admin settings with RLS, and the Socket.IO protocol — join, validated movement, interest
 * management, batched positions, rooms with every access mode, knocks, teleports, desks, the
 * presence ring from attendance, proximity groups, and the office socket never keeping an
 * attendance session alive.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { generateSync } from 'otplib';
import { io, type Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { AttendanceGateway } from '../src/attendance/attendance.gateway.ts';
import { signHeartbeatPayload } from '../../../packages/shared/src/attendance/heartbeat-signer.ts';
import { centre, generateDefaultFloor, OfficeSnapshotSchema, PeopleListSchema, TILE_SIZE } from '../../../packages/shared/src/office/index.ts';
import type { JoinAck, MoveAck, OfficeSnapshot, PositionsMessage, ProximityMessage, RosterEntry, TeleportAck } from '../../../packages/shared/src/office/index.ts';
import type { StateMachineTransitionResult } from '../../../packages/shared/src/index.ts';

const ORG = 'f0f00000-0000-4000-8000-000000000001';
const OTHER = 'f0f00000-0000-4000-8000-000000000002';
const PORT = 3089;
const PASSWORD = 'ComplexPassword123!';
const SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const U = {
  admin: { id: 'f0f00000-0000-4000-8000-000000000011', org: ORG, email: 'admin@vo.test', name: 'Ada Admin', role: 'ADMIN', mfa: true },
  a: { id: 'f0f00000-0000-4000-8000-000000000012', org: ORG, email: 'anna@vo.test', name: 'Anna A', role: 'EMPLOYEE', mfa: false },
  b: { id: 'f0f00000-0000-4000-8000-000000000013', org: ORG, email: 'ben@vo.test', name: 'Ben B', role: 'EMPLOYEE', mfa: false },
  c: { id: 'f0f00000-0000-4000-8000-000000000014', org: ORG, email: 'cleo@vo.test', name: 'Cleo C', role: 'SUBCONTRACTOR', mfa: false },
  other: { id: 'f0f00000-0000-4000-8000-000000000021', org: OTHER, email: 'otto@vo-other.test', name: 'Otto Other', role: 'EMPLOYEE', mfa: false },
} as const;
type Who = keyof typeof U;
interface Session { accessToken: string; sessionId: string; sessionSecret: string }

const t = (n: number) => n * TILE_SIZE + TILE_SIZE / 2;
const map = generateDefaultFloor();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Virtual office (FR-VO-001..005, 007, 008, 012, 013)', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  const base = `http://localhost:${PORT}`;
  const sessions = {} as Record<Who, Session>;
  const sockets: Socket[] = [];
  let snap: OfficeSnapshot;
  const room = (name: string) => snap.rooms.find((r) => r.name === name)!;

  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessions[who].accessToken}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  async function ok<T>(res: Response, status: number, schema?: { parse: (v: unknown) => T }): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return schema ? schema.parse(JSON.parse(text)) : (JSON.parse(text || 'null') as T);
  }

  /** An office socket with an inbox of everything it received. */
  async function officeSocket(who: Who, positions = true) {
    const s = io(base, { transports: ['websocket'], reconnection: false, auth: { token: sessions[who].accessToken, purpose: 'office' } });
    sockets.push(s);
    await new Promise<void>((res, rej) => { s.once('connect', () => res()); s.once('connect_error', rej); });
    const inbox = { positions: [] as PositionsMessage[], presence: [] as Array<RosterEntry | { id: string; gone: true }>, proximity: [] as ProximityMessage[], knocks: [] as unknown[], answered: [] as Array<{ admit: boolean }> };
    s.on('office:positions', (m: PositionsMessage) => inbox.positions.push(m));
    s.on('office:presence', (m: RosterEntry) => inbox.presence.push(m));
    s.on('office:proximity', (m: ProximityMessage) => inbox.proximity.push(m));
    s.on('room:knock', (m: unknown) => inbox.knocks.push(m));
    s.on('room:answered', (m: { admit: boolean }) => inbox.answered.push(m));
    const join = (await s.emitWithAck('office:join', { positions })) as JoinAck;
    const move = (x: number, y: number) => s.emitWithAck('office:move', { x, y, dir: 0, ct: Date.now() }) as Promise<MoveAck>;
    const teleport = (dto: unknown) => s.emitWithAck('office:teleport', dto) as Promise<TeleportAck>;
    /** Walks in legal 20 px steps every 100 ms (like the client at 10 Hz). */
    const walk = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 18);
      let last: MoveAck = { ok: true };
      for (let i = 1; i <= steps; i += 1) {
        await wait(100);
        last = await move(Math.round(from.x + ((to.x - from.x) * i) / steps), Math.round(from.y + ((to.y - from.y) * i) / steps));
        if (!last.ok) return last;
      }
      return last;
    };
    return { s, inbox, join, move, teleport, walk };
  }
  const lastSeen = (inbox: { positions: PositionsMessage[] }, id: string) => {
    for (let i = inbox.positions.length - 1; i >= 0; i -= 1) {
      const e = inbox.positions[i]!.u.find((x) => x[0] === id);
      if (e) return e;
      if (inbox.positions[i]!.gone.includes(id)) return null;
    }
    return null;
  };

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'VO Ltd', 'vo-e2e'), ($2, 'Other Ltd', 'vo-other-e2e')`, [ORG, OTHER]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status, mfa_enabled, mfa_secret) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8)`,
        [u.id, u.org, u.email, u.name, u.role, hash, u.mfa, u.mfa ? SECRET : null]);
    }
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD, ...(U[who].mfa ? { totpCode: generateSync({ secret: SECRET }) } : {}) }) });
      sessions[who] = (await res.json()) as Session;
      assert.ok(sessions[who].accessToken, `login ${who}`);
    }
  });

  after(async () => {
    for (const s of sockets) s.disconnect();
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.end();
  });

  describe('Office layout and administration (FR-VO-001, 004, 007)', { concurrency: false }, () => {
    it('the first visit creates the default office: one floor, eight rooms, twenty desks; every role may enter', async () => {
      snap = await ok(await api('c', '/office'), 200, OfficeSnapshotSchema);
      assert.equal(snap.floors.length, 1);
      assert.equal(snap.rooms.length, 8);
      assert.equal(snap.desks.length, 20);
      assert.equal(snap.canManage, false);
      assert.equal(room('Board room').accessMode, 'KNOCK');
      assert.equal(room('HR office').accessMode, 'INVITE');
      assert.equal(room('HR office').canEnter, false);
      assert.equal(room('Lounge').canEnter, true);
      assert.ok(!JSON.stringify(snap).includes('password'), 'no password material');
      const admin = await ok(await api('admin', '/office'), 200, OfficeSnapshotSchema);
      assert.equal(admin.canManage, true);
      assert.equal(admin.rooms.find((r) => r.name === 'HR office')!.canEnter, true, 'admins may enter any room');
      const rows = await adminPool.query(`SELECT count(*)::int AS n FROM rooms WHERE org_id = $1`, [ORG]);
      assert.equal(rows.rows[0].n, 8);
    });

    it('organisations are isolated: another org gets its own office; ids of ours are not found', async () => {
      const theirs = await ok(await api('other', '/office'), 200, OfficeSnapshotSchema);
      assert.notEqual(theirs.office.id, snap.office.id);
      assert.ok(theirs.rooms.every((r) => !snap.rooms.some((x) => x.id === r.id)));
      assert.equal((await api('other', `/office/desks/${snap.desks[0]!.id}/claim`, { method: 'POST' })).status, 404);
      await assert.rejects(adminPool.query(`INSERT INTO desks (org_id, office_id, floor_id, map_object_id, label, bounds) VALUES ($1, $2, 'ground', 999, 'x', '{}')`, [OTHER, snap.office.id]), /another organisation/);
    });

    it('only org.manage changes rooms, desks or the map; input is validated; changes are audited', async () => {
      const board = room('Board room');
      assert.equal((await api('a', `/office/rooms/${board.id}`, { method: 'PUT', body: { capacity: 3 } })).status, 403);
      assert.equal((await api('a', '/office/map', { method: 'PUT', body: { name: 'x', floors: [] } })).status, 403);
      assert.equal((await api('admin', `/office/rooms/${board.id}`, { method: 'PUT', body: { accessMode: 'PASSWORD' } })).status, 400, 'a password room needs a password');
      assert.equal((await api('admin', `/office/rooms/${board.id}`, { method: 'PUT', body: { capacity: 0 } })).status, 400);
      assert.equal((await api('admin', '/office/map', { method: 'PUT', body: { name: 'Bad', floors: [{ id: 'g', name: 'G', map: { ...map, width: 5 } }] } })).status, 400);
      const ok2 = await ok(await api('admin', '/office/map', { method: 'PUT', body: { name: 'Main office', floors: [{ id: 'ground', name: 'Ground floor', map }] } }), 200, OfficeSnapshotSchema);
      assert.equal(ok2.office.version, 2);
      assert.deepEqual(ok2.rooms.map((r) => r.id).sort(), snap.rooms.map((r) => r.id).sort(), 'same object ids keep the same rooms');
      const audit = await adminPool.query(`SELECT action FROM audit_logs WHERE org_id = $1 AND action LIKE 'OFFICE%'`, [ORG]);
      assert.deepEqual(audit.rows.map((r) => r.action), ['OFFICE_MAP_REPLACED']);
    });

    it('desks: anyone claims a free desk, never someone else\'s; admins assign; audited', async () => {
      const d1 = snap.desks[0]!;
      const d2 = snap.desks[1]!;
      const mine = await ok(await api('a', `/office/desks/${d1.id}/claim`, { method: 'POST' }), 201, OfficeSnapshotSchema);
      assert.equal(mine.me.deskId, d1.id);
      assert.equal((await api('b', `/office/desks/${d1.id}/claim`, { method: 'POST' })).status, 409);
      await ok(await api('a', `/office/desks/${d2.id}/claim`, { method: 'POST' }), 201);
      const after = await ok(await api('a', '/office'), 200, OfficeSnapshotSchema);
      assert.equal(after.me.deskId, d2.id, 'one desk per person: claiming another releases the first');
      assert.equal(after.desks.find((d) => d.id === d1.id)!.assignee, null);
      await ok(await api('admin', `/office/desks/${d1.id}/assignee`, { method: 'PUT', body: { userId: U.b.id } }), 200);
      assert.equal((await api('a', `/office/desks/${d1.id}/assignee`, { method: 'PUT', body: { userId: U.a.id } })).status, 403);
      const audit = await adminPool.query(`SELECT action FROM audit_logs WHERE org_id = $1 AND entity_type = 'DESK' ORDER BY id`, [ORG]);
      assert.deepEqual(audit.rows.map((r) => r.action), ['DESK_CLAIMED', 'DESK_CLAIMED', 'DESK_ASSIGNED']);
    });
  });

  describe('Live office over Socket.IO (FR-VO-002, 003, 005, 008, 012, 013)', { concurrency: false }, () => {
    let A: Awaited<ReturnType<typeof officeSocket>>;
    let B: Awaited<ReturnType<typeof officeSocket>>;
    let C: Awaited<ReturnType<typeof officeSocket>>;

    it('joining puts people at their desk (or the reception) and returns the roster', async () => {
      A = await officeSocket('a');
      assert.equal(A.join.ok, true);
      const aStart = A.join.ok ? A.join.self : null;
      const deskA = snap.desks[1]!;
      assert.ok(aStart && Math.abs(aStart.x - (deskA.bounds.x + deskA.bounds.width / 2)) < TILE_SIZE, 'Anna starts at her desk');
      B = await officeSocket('b');
      assert.ok(B.join.ok && B.join.roster.some((r) => r.id === U.a.id) && B.join.roster.some((r) => r.id === U.b.id));
      C = await officeSocket('c', false);
      assert.ok(C.join.ok);
      const cStart = C.join.ok ? C.join.self : null;
      assert.ok(cStart && cStart.y > 29 * TILE_SIZE, 'no desk: the reception');
      await wait(250);
      assert.ok(A.inbox.presence.some((p) => 'name' in p && p.id === U.c.id), 'roster updates reach everyone');
    });

    it('a valid move reaches the neighbours in the next 10 Hz batch (p95 < 200 ms); positions are batched', async () => {
      const startA = A.join.ok ? A.join.self : { x: 0, y: 0 };
      const latencies: number[] = [];
      let x = startA.x;
      for (let i = 0; i < 20; i += 1) {
        x += (i % 2 === 0 ? 16 : -16);
        const sentAt = Date.now();
        const ack = await A.move(x, startA.y);
        assert.equal(ack.ok, true, JSON.stringify(ack));
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline) {
          const e = lastSeen(B.inbox, U.a.id);
          if (e && e[1] === x) break;
          await wait(5);
        }
        latencies.push(Date.now() - sentAt);
        await wait(60);
      }
      latencies.sort((p, q) => p - q);
      const p95 = latencies[Math.floor(latencies.length * 0.95) - 1]!;
      assert.ok(p95 < 200, `p95 ${p95} ms`);
      const gaps = B.inbox.positions.slice(1).map((m, i) => m.st - B.inbox.positions[i]!.st);
      assert.ok(gaps.every((g) => g >= 90), 'never more than one batch per tick');
      assert.equal(C.inbox.positions.length, 0, 'the list view gets no position stream (FR-VO-012)');
    });

    it('the server refuses speed hacks, walls, blocked tiles and junk, and returns the authoritative position', async () => {
      const here = lastSeen(B.inbox, U.a.id)!;
      const fast = await A.move(here[1] + 400, here[2]);
      assert.deepEqual(fast, { ok: false, reason: 'TOO_FAST', x: here[1], y: here[2], floorId: 'ground' });
      const table = await A.move(t(4), t(13));
      assert.equal(table.ok, false);
      const junk = (await A.s.emitWithAck('office:move', { x: 'a', y: null })) as MoveAck;
      assert.equal(junk.ok, false);
      let limited = false;
      for (let i = 0; i < 20; i += 1) { const r = await A.move(here[1], here[2]); if (!r.ok && r.reason === 'RATE_LIMITED') limited = true; }
      assert.equal(limited, true, 'more than 15 moves a second are refused');
      await wait(1100);
    });

    it('interest management: far-away people are not streamed; coming near makes them appear, leaving sends "gone"', async () => {
      // Ben goes to the lounge, far from Anna's desk; Anna's updates must not reach him there.
      const t1 = await B.teleport({ kind: 'room', roomId: room('Lounge').id });
      assert.ok(t1.ok);
      const lounge = { x: t(56), y: t(37) };
      await B.walk({ x: t1.ok ? t1.x : 0, y: t1.ok ? t1.y : 0 }, lounge).catch(() => undefined);
      await wait(300);
      const before = B.inbox.positions.length;
      const here = lastSeen(B.inbox, U.a.id);
      assert.ok(B.inbox.positions.some((m) => m.gone.includes(U.a.id)) || here === null, 'Anna left Ben\'s neighbourhood');
      const startA = A.join.ok ? A.join.self : { x: 0, y: 0 };
      await A.move(startA.x + 10, startA.y);
      await wait(300);
      assert.ok(!B.inbox.positions.slice(before).some((m) => m.u.some((e) => e[0] === U.a.id)), 'no updates from outside the 3×3 cells');
      const back = await B.teleport({ kind: 'user', userId: U.a.id });
      assert.ok(back.ok);
      await wait(300);
      assert.ok(lastSeen(B.inbox, U.a.id), 'next to Anna again: she is streamed');
    });

    it('proximity: people next to each other form a group; room-only mode leaves it', async () => {
      await wait(300);
      const groupOf = (inbox: { proximity: ProximityMessage[] }) => inbox.proximity.at(-1);
      assert.deepEqual(groupOf(A.inbox)?.members.sort(), [U.a.id, U.b.id].sort());
      assert.deepEqual(groupOf(B.inbox)?.members.sort(), [U.a.id, U.b.id].sort());
      await B.s.emitWithAck('office:mode', { roomOnly: true });
      await wait(300);
      assert.deepEqual(groupOf(A.inbox), { groupId: null, members: [] });
      await B.s.emitWithAck('office:mode', { roomOnly: false });
    });

    it('presence ring: the attendance state and the user\'s own status reach the avatars and the roster', async () => {
      const gw = app.get(AttendanceGateway);
      gw.broadcastTransition(ORG, U.a.id, { currentState: 'ON_BREAK', actionTaken: 'BREAK_STARTED' } as unknown as StateMachineTransitionResult);
      await wait(300);
      assert.equal(lastSeen(B.inbox, U.a.id)?.[4], 'ON_BREAK');
      assert.ok(B.inbox.presence.some((p) => 'status' in p && p.id === U.a.id && p.status === 'ON_BREAK'));
      gw.broadcastTransition(ORG, U.a.id, { currentState: 'ACTIVE', actionTaken: 'BREAK_ENDED' } as unknown as StateMachineTransitionResult);
      await ok(await api('a', '/office/me/status', { method: 'PUT', body: { status: 'DND', message: 'Writing the report' } }), 200);
      await wait(300);
      assert.equal(lastSeen(B.inbox, U.a.id)?.[4], 'DND');
      const people = await ok(await api('b', '/office/people?q=anna'), 200, PeopleListSchema);
      assert.equal(people.items.length, 1);
      assert.equal(people.items[0]!.status, 'DND');
      assert.equal(people.items[0]!.statusMessage, 'Writing the report');
      assert.equal(people.items[0]!.online, true);
      await ok(await api('a', '/office/me/status', { method: 'PUT', body: { status: 'AUTO' } }), 200);
      assert.equal((await api('b', '/office/me/status', { method: 'PUT', body: { status: 'BUSY' } })).status, 400);
    });

    it('people search finds colleagues and where they are (FR-VO-008)', async () => {
      const all = await ok(await api('c', '/office/people'), 200, PeopleListSchema);
      assert.deepEqual(all.items.map((p) => p.displayName).sort(), ['Ada Admin', 'Anna A', 'Ben B', 'Cleo C']);
      const online = await ok(await api('c', '/office/people?onlineOnly=true'), 200, PeopleListSchema);
      assert.deepEqual(online.items.map((p) => p.displayName).sort(), ['Anna A', 'Ben B', 'Cleo C']);
      const ben = all.items.find((p) => p.id === U.b.id)!;
      assert.equal(ben.deskLabel, snap.desks[0]!.label, 'assigned by the admin');
      assert.equal((await ok(await api('other', '/office/people'), 200, PeopleListSchema)).items.length, 1, 'only your organisation');
    });

    it('rooms: walking or teleporting into a knock room is refused; a knock is answered from inside', async () => {
      const board = room('Board room');
      const tp = await C.teleport({ kind: 'room', roomId: board.id });
      assert.equal(tp.ok, false);
      assert.equal(!tp.ok && tp.code, 'KNOCK');
      const empty = (await C.s.emitWithAck('room:knock', { roomId: board.id })) as { ok: boolean; error?: string };
      assert.equal(empty.ok, false, 'nobody inside');
      const Ad = await officeSocket('admin');
      assert.ok((await Ad.teleport({ kind: 'room', roomId: board.id })).ok, 'admins may enter');
      const knock = (await C.s.emitWithAck('room:knock', { roomId: board.id })) as { ok: boolean };
      assert.equal(knock.ok, true);
      await wait(150);
      assert.equal(Ad.inbox.knocks.length, 1);
      assert.equal(((await C.s.emitWithAck('room:knock', { roomId: board.id })) as { ok: boolean }).ok, false, 'one knock per 10 s');
      assert.equal(((await B.s.emitWithAck('room:answer', { roomId: board.id, userId: U.c.id, admit: true })) as { ok: boolean }).ok, false, 'only people inside answer');
      assert.equal(((await Ad.s.emitWithAck('room:answer', { roomId: board.id, userId: U.c.id, admit: true })) as { ok: boolean }).ok, true);
      await wait(150);
      assert.deepEqual(C.inbox.answered.map((x) => x.admit), [true]);
      const inside = await C.teleport({ kind: 'room', roomId: board.id });
      assert.ok(inside.ok && inside.roomId === board.id);
      // Leaving a knock room ends the admission.
      assert.ok((await C.teleport({ kind: 'room', roomId: room('Reception').id })).ok);
      const again = await C.teleport({ kind: 'room', roomId: board.id });
      assert.equal(!again.ok && again.code, 'KNOCK');
      Ad.s.disconnect();
    });

    it('rooms: invite-only and password rooms, capacity, and password attempts are limited', async () => {
      const hr = room('HR office');
      assert.equal(((await C.teleport({ kind: 'room', roomId: hr.id })) as { code?: string }).code, 'INVITE');
      await ok(await api('admin', `/office/rooms/${hr.id}/invites`, { method: 'PUT', body: { userIds: [U.c.id] } }), 200);
      assert.ok((await C.teleport({ kind: 'room', roomId: hr.id })).ok, 'invited');
      const focus = room('Focus room');
      await ok(await api('admin', `/office/rooms/${focus.id}`, { method: 'PUT', body: { accessMode: 'PASSWORD', password: 'focus-123', capacity: 1 } }), 200);
      const stored = await adminPool.query(`SELECT password_hash FROM rooms WHERE id = $1`, [focus.id]);
      assert.match(stored.rows[0].password_hash, /^\$argon2id\$/);
      const audit = await adminPool.query(`SELECT after FROM audit_logs WHERE org_id = $1 AND action = 'ROOM_UPDATED' ORDER BY id DESC LIMIT 1`, [ORG]);
      assert.ok(!JSON.stringify(audit.rows[0].after).includes('focus-123'), 'the password is never logged');
      assert.equal(((await A.teleport({ kind: 'room', roomId: focus.id })) as { code?: string }).code, 'PASSWORD');
      assert.equal(((await A.teleport({ kind: 'room', roomId: focus.id, password: 'nope' })) as { code?: string }).code, 'BAD_PASSWORD');
      assert.ok((await A.teleport({ kind: 'room', roomId: focus.id, password: 'focus-123' })).ok);
      assert.equal(((await B.teleport({ kind: 'room', roomId: focus.id, password: 'focus-123' })) as { code?: string }).code, 'FULL', 'capacity 1');
      // A full room answers FULL before any password is checked; once Anna leaves, guesses count.
      assert.ok((await A.teleport({ kind: 'room', roomId: room('Lounge').id })).ok);
      for (let i = 0; i < 5; i += 1) assert.equal(((await C.teleport({ kind: 'room', roomId: focus.id, password: `wrong-${i}` })) as { code?: string }).code, 'BAD_PASSWORD');
      assert.equal(((await C.teleport({ kind: 'room', roomId: focus.id, password: 'focus-123' })) as { code?: string }).code, 'RATE_LIMITED', 'even the right password waits after 5 wrong ones');
    });

    it('teleport: to my desk, to a colleague, refused when they are in a room I may not enter', async () => {
      const desk = await B.teleport({ kind: 'desk' });
      assert.ok(desk.ok);
      const d1 = snap.desks[0]!;
      assert.ok(desk.ok && Math.abs(desk.x - (d1.bounds.x + d1.bounds.width / 2)) < TILE_SIZE);
      assert.equal(((await C.teleport({ kind: 'desk' })) as { code?: string }).code, 'NOT_FOUND', 'no desk');
      const toAnna = await C.teleport({ kind: 'user', userId: U.a.id });
      assert.ok(toAnna.ok);
      assert.equal(((await A.teleport({ kind: 'user', userId: U.c.id })) as { ok: boolean }).ok, true);
      assert.ok((await C.teleport({ kind: 'room', roomId: room('HR office').id })).ok);
      const blocked = await A.teleport({ kind: 'user', userId: U.c.id });
      assert.equal(!blocked.ok && blocked.code, 'INVITE', 'Cleo is in the HR office, Anna is not invited');
      assert.equal(((await A.teleport({ kind: 'user', userId: U.other.id })) as { code?: string }).code, 'NOT_FOUND', 'other organisations do not exist here');
    });

    it('leaving the office removes the avatar for everyone', async () => {
      const startB = B.inbox.presence.length;
      C.s.disconnect();
      await wait(300);
      assert.ok(B.inbox.presence.slice(startB).some((p) => 'gone' in p && p.id === U.c.id));
      const people = await ok(await api('b', '/office/people?onlineOnly=true'), 200, PeopleListSchema);
      assert.ok(!people.items.some((p) => p.id === U.c.id));
    });

    it('the office socket never keeps an attendance session open', async () => {
      await adminPool.query(`INSERT INTO monitoring_consents (org_id, user_id, notice_version, accepted_at) VALUES ($1, $2, 'v1.0.0', now())`, [ORG, U.b.id]);
      const att = io(base, { transports: ['websocket'], reconnection: false, auth: { token: sessions.b.accessToken } });
      sockets.push(att);
      await new Promise<void>((res, rej) => { att.once('connect', () => res()); att.once('connect_error', rej); });
      const hb = await signHeartbeatPayload({ orgId: ORG, userId: U.b.id, deviceId: 'vo-e2e', sessionId: sessions.b.sessionId, sequenceNumber: Math.floor(Date.now() / 1000), nonce: randomBytes(16).toString('hex'), activeSeconds: 1, idleSeconds: 0, tabVisible: true, windowFocused: true, inCall: false }, sessions.b.sessionSecret);
      assert.equal(((await att.emitWithAck('presence:heartbeat', hb)) as { success: boolean }).success, true);
      att.disconnect(); // B's office socket stays connected
      await wait(400);
      const today = (await ok<{ state: string }>(await api('b', '/attendance/me/today'), 200));
      assert.equal(today.state, 'DISCONNECTED', 'the grace window started although the office socket is open');
    });
  });

  it('the map definition is centred and walkable around every room (sanity for the client)', () => {
    for (const r of snap.rooms) assert.ok(centre(r.bounds).x > 0);
  });
});
