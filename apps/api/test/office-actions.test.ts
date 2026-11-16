/**
 * Avatar action rules on the office world itself (ADR 056): the seat list, and sitting refused
 * through a wall, in a room you may not enter, on a taken chair or out of reach; pair reach;
 * actions and requests running out on the tick. No server, no database.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_MS, AVATAR_RADIUS, buildGrid, defaultOffice, generateDefaultFloor, mapRooms, mapSeats, nearestSeat, PAIR_REACH, SEAT_REACH, TILE_SIZE as T, walkable,
} from '../../../packages/shared/src/office/index.ts';
import { OfficeWorld } from '../src/office/office-world.ts';
import type { Avatar, RoomInfo, WorldEmitter } from '../src/office/office-world.ts';

const map = generateDefaultFloor();
const grid = buildGrid(map);
const seats = mapSeats(map);

function world(): OfficeWorld {
  const rooms: RoomInfo[] = mapRooms(map).map((r, i) => ({ id: `room-${i}`, floorId: 'ground', name: r.name, type: r.type, capacity: r.capacity, accessMode: r.access, bounds: r.bounds, passwordHash: null }));
  return new OfficeWorld('org', 'office', defaultOffice(), rooms, [], new Map(), 96);
}
function avatar(w: OfficeWorld, userId: string, x: number, y: number): Avatar {
  const a: Avatar = { userId, name: userId, floorId: 'ground', x: 0, y: 0, dir: 0, roomId: null, lastMoveAt: 0, version: 0, attendance: null, manual: 'AUTO', message: '', roomOnly: false, isAdmin: false, sockets: new Map([[`s-${userId}`, { positions: true, viewing: true }]]), ct: null, goneAt: null, goneSid: null, avatarKey: 'sage' };
  w.avatars.set(userId, a);
  w.place(a, 'ground', { x, y }, 0);
  return a;
}

describe('Avatar action rules (ADR 056)', () => {
  it('every seat is a walkable spot with a stable id; each meeting room has chairs; desks have one each', () => {
    assert.equal(seats.length, 90);
    assert.equal(new Set(seats.map((s) => s.id)).size, seats.length);
    for (const s of seats) assert.ok(walkable(grid, s.x, s.y), `${s.id} is walkable`);
    assert.equal(seats.filter((s) => s.kind === 'desk').length, 20);
    for (const r of mapRooms(map).filter((x) => x.type === 'MEETING')) {
      const n = seats.filter((s) => s.x > r.bounds.x && s.x < r.bounds.x + r.bounds.width && s.y > r.bounds.y && s.y < r.bounds.y + r.bounds.height).length;
      assert.ok(n >= 12, `${r.name}: ${n} chairs`);
    }
    const d = seats.find((s) => s.kind === 'desk')!;
    assert.equal(nearestSeat(seats, { x: d.x, y: d.y + 20 })?.id, d.id);
    assert.equal(nearestSeat(seats, { x: d.x, y: d.y + 20 }, (s) => s.id !== d.id), null, 'a taken chair is not offered');
    assert.equal(nearestSeat(seats, { x: d.x, y: d.y + SEAT_REACH + 1 }), null, 'out of reach');
  });

  it('sitting: in reach and free; never through a wall, never into a room you may not enter; one person per chair', () => {
    const w = world();
    const desk = seats.find((s) => s.kind === 'desk')!;
    const a = avatar(w, 'a', desk.x, desk.y + 30);
    assert.deepEqual(w.sit(a, desk.id, 1000), { ok: true });
    assert.deepEqual({ x: a.x, y: a.y, kind: a.action?.kind, seat: a.action?.seat }, { x: desk.x, y: desk.y, kind: 'sit', seat: desk.id });
    assert.equal(w.seatOccupant('ground', desk.id), a);
    const b = avatar(w, 'b', desk.x + 20, desk.y + 20);
    assert.deepEqual(w.sit(b, desk.id, 1000), { ok: false, code: 'TAKEN' });
    assert.deepEqual(w.sit(b, 'desk:nope', 1000), { ok: false, code: 'NO_SEAT' });
    const far = seats.find((s) => Math.hypot(s.x - b.x, s.y - b.y) > SEAT_REACH)!;
    assert.deepEqual(w.sit(b, far.id, 1000), { ok: false, code: 'TOO_FAR' });
    // Through a wall: impossible by geometry. A wall tile is 32 px and an avatar 10 px from it at
    // the least, so a chair on the far side is always beyond reach.
    assert.ok(SEAT_REACH < T + 2 * AVATAR_RADIUS, 'no chair is ever in reach through a wall');
    // Through furniture: the straight line to the chair must be walkable (here, across the desk top).
    const c = avatar(w, 'c', 0, 0);
    Object.assign(c, { x: desk.x, y: desk.y - 40 });
    assert.deepEqual(w.sit(c, desk.id === a.action?.seat ? seats.filter((x) => x.kind === 'desk')[1]!.id : desk.id, 1000).ok, false);
    const other = seats.filter((x) => x.kind === 'desk')[1]!;
    Object.assign(c, { x: other.x, y: other.y - 40 });
    assert.deepEqual(w.sit(c, other.id, 1000), { ok: false, code: 'BLOCKED' });
    // The board room is knock-to-enter: standing in its doorway, its nearest chair is refused.
    const board = w.rooms.find((x) => x.name === 'Board room')!;
    const door = { x: 51 * T + 16, y: 10 * T + 16 };
    const inBoard = seats.filter((s) => s.x > board.bounds.x && s.x < board.bounds.x + board.bounds.width && s.y > board.bounds.y && s.y < board.bounds.y + board.bounds.height)
      .sort((p, q) => Math.hypot(p.x - door.x, p.y - door.y) - Math.hypot(q.x - door.x, q.y - door.y))[0]!;
    const d = avatar(w, 'd', door.x, door.y);
    if (Math.hypot(inBoard.x - door.x, inBoard.y - door.y) <= SEAT_REACH) assert.deepEqual(w.sit(d, inBoard.id, 1000), { ok: false, code: 'ROOM' });
    else assert.deepEqual(w.sit(d, inBoard.id, 1000), { ok: false, code: 'TOO_FAR' });
    // With a grant (admitted after a knock) the same chair is fine once inside.
    w.grant('d', board.id);
    assert.equal(w.mayEnter('d', board, false), null);
  });

  it('pair reach: same floor and room, close together', () => {
    const w = world();
    const a = avatar(w, 'a', 30 * T, 15 * T);
    const b = avatar(w, 'b', 30 * T + PAIR_REACH - 1, 15 * T);
    assert.ok(w.pairReach(a, b));
    w.place(b, 'ground', { x: 30 * T + PAIR_REACH + 10, y: 15 * T }, 0);
    assert.ok(!w.pairReach(a, b));
    // Either side of the Lounge-Café doorway: close, but different rooms.
    const l = avatar(w, 'l', 58 * T + 16, 34 * T + 16);
    const k = avatar(w, 'k', 60 * T + 16, 34 * T + 16);
    assert.notEqual(l.roomId, k.roomId);
    assert.ok(!w.pairReach(l, k));
  });

  it('the tick ends actions on time, keeps sitting, and closes lapsed or orphaned requests', () => {
    const w = world();
    const a = avatar(w, 'a', 30 * T, 15 * T);
    const b = avatar(w, 'b', 31 * T, 15 * T);
    const sent: Array<{ to: string; event: string; reason: string }> = [];
    const emit: WorldEmitter = { positions: () => undefined, proximity: () => undefined, roster: () => undefined, personal: (to, event, p) => sent.push({ to, event, reason: (p as { reason: string }).reason }) };
    w.setAction(a, 'wave', 0);
    w.tick(emit, ACTION_MS.wave - 1);
    assert.equal(a.action?.kind, 'wave');
    w.tick(emit, ACTION_MS.wave);
    assert.equal(a.action ?? null, null, 'the wave ended');
    const desk = seats.find((s) => s.kind === 'desk')!;
    w.place(b, 'ground', { x: desk.x, y: desk.y + 20 }, 0);
    assert.ok(w.sit(b, desk.id, 0).ok);
    w.tick(emit, 10 * 60_000);
    assert.equal(b.action?.kind, 'sit', 'sitting lasts until standing');
    const r = w.openRequest('hug', 'a', 'b', 0, 1000);
    w.tick(emit, 999);
    assert.ok(w.requests.has(r.id));
    w.tick(emit, 1000);
    assert.ok(!w.requests.has(r.id));
    assert.deepEqual(sent.map((x) => `${x.to}:${x.reason}`), ['a:timeout', 'b:timeout']);
    sent.length = 0;
    const r2 = w.openRequest('highfive', 'a', 'b', 0, 60_000);
    w.remove('b');
    w.tick(emit, 2000);
    assert.ok(!w.requests.has(r2.id));
    assert.deepEqual(sent.map((x) => `${x.to}:${x.reason}`), ['a:gone', 'b:gone']);
    assert.equal(w.seatOccupant('ground', desk.id), null, 'the chair is free once its sitter has left');
  });
});
