/**
 * Virtual office pure rules (FR-VO-001, 002, 003, 005, 013; ADR 015): map schema, collision,
 * movement validation, pathfinding, interest cells, proximity groups and the status mapping.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGrid, centre, defaultOffice, displayStatus, findPath, generateDefaultFloor, InterestGrid, INTEREST_CELL, isClosedRoom, mapDesks, mapRooms,
  mediaRoute, MOVE_SPEED, nearestWalkable, OfficeDefinitionSchema, OfficeMapSchema, proximityGroups, segmentClear, spawnPoint, TILE_SIZE, validateMove, walkable,
} from '../../../packages/shared/src/office/index.ts';
import type { OfficeMap } from '../../../packages/shared/src/office/index.ts';

const map = generateDefaultFloor();
const grid = buildGrid(map);
const t = (n: number) => n * TILE_SIZE + TILE_SIZE / 2;

describe('Default office map (FR-VO-001)', () => {
  it('is valid Tiled-style JSON with floors, walls, rooms, desks and a spawn', () => {
    assert.ok(OfficeMapSchema.safeParse(map).success);
    assert.ok(OfficeDefinitionSchema.safeParse(defaultOffice()).success);
    const rooms = mapRooms(map);
    assert.deepEqual(rooms.map((r) => r.name), ['Meeting room A', 'Meeting room B', 'Meeting room C', 'Board room', 'Focus room', 'HR office', 'Reception', 'Lounge']);
    assert.deepEqual([...new Set(rooms.map((r) => r.type))].sort(), ['MEETING', 'OPEN', 'PRIVATE']);
    assert.ok(rooms.some((r) => r.access === 'KNOCK') && rooms.some((r) => r.access === 'INVITE'));
    assert.equal(mapDesks(map).length, 20);
    const s = spawnPoint(map);
    assert.ok(walkable(grid, s.x, s.y), 'spawn is walkable');
  });

  it('every room and every desk seat can be reached from the spawn', () => {
    const s = spawnPoint(map);
    for (const r of mapRooms(map)) assert.ok(findPath(grid, s, centre(r.bounds)), `path to ${r.name}`);
    for (const d of mapDesks(map)) assert.ok(findPath(grid, s, { x: d.bounds.x + TILE_SIZE, y: d.bounds.y + TILE_SIZE * 1.5 }), `path to ${d.label}`);
  });

  it('rejects malformed maps: wrong layer size, objects outside the map, no walls, oversized', () => {
    const bad = (m: unknown) => OfficeMapSchema.safeParse(m).success;
    const clone = (): OfficeMap => JSON.parse(JSON.stringify(map)) as OfficeMap;
    const short = clone();
    (short.layers[0] as { data: number[] }).data.pop();
    assert.equal(bad(short), false);
    const outside = clone();
    (outside.layers[2] as { objects: Array<{ x: number }> }).objects[0]!.x = 99_999;
    assert.equal(bad(outside), false);
    const noWalls = clone();
    noWalls.layers = noWalls.layers.filter((l) => l.name !== 'walls');
    assert.equal(bad(noWalls), false);
    assert.equal(bad({ ...clone(), width: 1000 }), false);
    assert.equal(OfficeDefinitionSchema.safeParse({ name: 'x', floors: [{ id: 'a', name: 'A', map }, { id: 'a', name: 'B', map }] }).success, false, 'duplicate floor ids');
  });
});

describe('Collision and movement validation (FR-VO-002)', () => {
  it('walls, furniture and the outside are not walkable; open floor is', () => {
    assert.equal(walkable(grid, t(0), t(20)), false, 'outer wall');
    assert.equal(walkable(grid, t(4), t(13)), false, 'desk table');
    assert.equal(walkable(grid, t(4), t(14)), true, 'desk seat');
    assert.equal(walkable(grid, -5, 10), false);
    assert.equal(walkable(grid, Number.NaN, 10), false);
  });

  it('accepts a normal step, refuses speed hacks, wall jumps and blocked targets', () => {
    const a = { x: t(10), y: t(20) };
    assert.deepEqual(validateMove(grid, a, { x: a.x + 18, y: a.y }, 100), { ok: true });
    assert.deepEqual(validateMove(grid, a, { x: a.x + MOVE_SPEED, y: a.y }, 100), { ok: false, reason: 'TOO_FAST' });
    assert.deepEqual(validateMove(grid, a, { x: a.x + 20_000, y: a.y }, 60_000), { ok: false, reason: 'NOT_WALKABLE' }, 'a long pause does not licence a teleport');
    // Through the wall on row 10 between the open area and meeting room A (no door at x = 3).
    const below = { x: t(3), y: t(11) };
    const above = { x: t(3), y: t(9) };
    assert.deepEqual(validateMove(grid, below, above, 1000), { ok: false, reason: 'THROUGH_WALL' });
    assert.deepEqual(validateMove(grid, a, { x: t(4), y: t(13) }, 1000), { ok: false, reason: 'NOT_WALKABLE' });
  });

  it('click-to-move finds a smoothed path through the door, never through walls', () => {
    const from = { x: t(3), y: t(12) };
    const to = { x: t(3), y: t(5) };
    const path = findPath(grid, from, to)!;
    assert.ok(path.length >= 2 && path.length < 10, 'a few smoothed waypoints');
    let prev = from;
    for (const p of path) { assert.ok(segmentClear(grid, prev, p), 'each leg is clear'); prev = p; }
    assert.ok(Math.hypot(prev.x - to.x, prev.y - to.y) < TILE_SIZE);
    assert.equal(findPath(grid, from, to, (p) => p.y > TILE_SIZE * 10), null, 'a forbidden room makes the target unreachable');
  });

  it('nearestWalkable moves a point off a wall', () => {
    const p = nearestWalkable(grid, { x: t(4), y: t(13) })!;
    assert.ok(walkable(grid, p.x, p.y));
  });
});

describe('Interest management (FR-VO-013)', () => {
  it('a user sees the 3×3 cells around them on their own floor only', () => {
    const g = new InterestGrid([
      { id: 'me', floorId: 'f1', x: 10, y: 10 },
      { id: 'near', floorId: 'f1', x: INTEREST_CELL + 5, y: 10 },
      { id: 'far', floorId: 'f1', x: INTEREST_CELL * 3, y: 10 },
      { id: 'upstairs', floorId: 'f2', x: 10, y: 10 },
    ]);
    assert.deepEqual([...g.neighbourhood('f1', 10, 10)].sort(), ['me', 'near']);
  });
});

describe('Proximity groups (FR-VO-005, without media)', () => {
  it('joins people within the radius transitively; closed rooms are groups; room-only users stay alone', () => {
    const e = (id: string, x: number, extra: Partial<{ closedRoomId: string; roomOnly: boolean; floorId: string }> = {}) => ({ id, floorId: extra.floorId ?? 'f', x, y: 100, closedRoomId: extra.closedRoomId ?? null, roomOnly: extra.roomOnly ?? false });
    const groups = proximityGroups([
      e('a', 100), e('b', 180), e('c', 260), // chain a-b-c within 96
      e('d', 600), // alone
      e('e', 620, { roomOnly: true }), // near d but room-only
      e('f', 100, { floorId: 'g' }), // other floor
      e('m1', 1000, { closedRoomId: 'R' }), e('m2', 1400, { closedRoomId: 'R' }),
    ], 96);
    assert.deepEqual([...groups.entries()].sort(), [['a', ['a', 'b', 'c']], ['room:R', ['m1', 'm2']]]);
  });

  it('a room\'s type, not its access mode, decides whether it is closed (an open-access meeting room is closed)', () => {
    const rooms = mapRooms(map);
    const closed = Object.fromEntries(rooms.map((r) => [r.name, isClosedRoom(r)]));
    assert.deepEqual(closed, {
      'Meeting room A': true, 'Meeting room B': true, 'Meeting room C': true, 'Board room': true, 'Focus room': true, 'HR office': true, Reception: false, Lounge: false,
    });
    assert.ok(rooms.some((r) => r.type === 'MEETING' && r.access === 'OPEN'), 'the default map has open-access meeting rooms (the case that broke)');
  });

  it('200 people are grouped quickly', () => {
    const people = Array.from({ length: 200 }, (_, i) => ({ id: `u${String(i).padStart(3, '0')}`, floorId: 'f', x: (i % 20) * 60, y: Math.floor(i / 20) * 60, closedRoomId: null, roomOnly: false }));
    const t0 = performance.now();
    for (let i = 0; i < 10; i += 1) proximityGroups(people, 96);
    assert.ok((performance.now() - t0) / 10 < 20, 'under 20 ms per tick');
  });
});

describe('Audio route from the avatar\'s room (FR-MEET-002, FR-VO-005; regression 2026-10-29)', () => {
  const rooms = mapRooms(map).map((r, i) => ({ id: `room-${i}`, name: r.name, type: r.type }));
  const id = (name: string) => rooms.find((r) => r.name === name)!.id;
  const alone = { groupId: null, members: [] };
  const route = (roomId: string | null, proximity: { groupId: string | null; members: string[] } = alone, roomOnly = false) => mediaRoute({ roomId, rooms, roomOnly, proximity });

  it('inside any closed room, whatever its access mode, the route is that room\'s call', () => {
    for (const name of ['Meeting room A', 'Meeting room B', 'Meeting room C', 'Board room', 'Focus room', 'HR office']) {
      assert.deepEqual(route(id(name), { groupId: `room:${id(name)}`, members: ['u1', 'u2'] }), { key: `room:${id(name)}`, kind: 'room' }, name);
    }
  });

  it('different rooms are different calls; leaving a room ends its call', () => {
    assert.notEqual(route(id('Meeting room A'))!.key, route(id('Meeting room B'))!.key);
    assert.equal(route(null), null, 'alone in the open area');
    assert.equal(route(id('Reception')), null, 'alone in an open-type area');
  });

  it('in the open area (and open-type areas) a proximity group of two or more is a call; room-only mode opts out', () => {
    const near = { groupId: 'u1', members: ['u1', 'u2'] };
    assert.deepEqual(route(null, near), { key: 'prox:u1', kind: 'proximity' });
    assert.deepEqual(route(id('Lounge'), near), { key: 'prox:u1', kind: 'proximity' });
    assert.equal(route(null, { groupId: 'u1', members: ['u1'] }), null);
    assert.equal(route(null, near, true), null);
  });

  it('a stale room group never becomes a proximity call (the server refuses those with 409)', () => {
    assert.equal(route(null, { groupId: `room:${id('Meeting room A')}`, members: ['u1', 'u2'] }), null);
  });

  it('agrees with the server\'s grouping for two people standing together in every room', () => {
    for (const r of mapRooms(map)) {
      const rid = id(r.name);
      const p = nearestWalkable(grid, centre(r.bounds))!;
      const groups = proximityGroups(['u1', 'u2'].map((u) => ({ id: u, floorId: 'f', x: p.x, y: p.y, closedRoomId: isClosedRoom(r) ? rid : null, roomOnly: false })), 96);
      const [gid, members] = [...groups.entries()][0]!;
      const want = isClosedRoom(r) ? { key: `room:${rid}`, kind: 'room' } : { key: `prox:${gid}`, kind: 'proximity' };
      assert.deepEqual(route(rid, { groupId: gid, members }), want, r.name);
    }
  });
});

describe('Presence on avatars (FR-VO-003)', () => {
  it('the attendance engine decides Active, Idle, Break and Offline; Away and DND are the user\'s choice', () => {
    assert.equal(displayStatus('ACTIVE', 'AUTO', true), 'ACTIVE');
    assert.equal(displayStatus('IDLE', 'AUTO', true), 'IDLE');
    assert.equal(displayStatus('PAUSED', 'AUTO', true), 'AWAY');
    assert.equal(displayStatus('ON_BREAK', 'AUTO', true), 'ON_BREAK');
    assert.equal(displayStatus('ON_BREAK', 'AWAY', true), 'ON_BREAK', 'a break is a fact, not a choice');
    assert.equal(displayStatus('IN_MEETING', 'AUTO', true), 'IN_MEETING');
    assert.equal(displayStatus('ACTIVE', 'DND', true), 'DND');
    assert.equal(displayStatus('ACTIVE', 'AWAY', true), 'AWAY');
    assert.equal(displayStatus('ACTIVE', 'AUTO', false), 'OFFLINE');
    assert.equal(displayStatus(null, 'AUTO', true), 'ACTIVE', 'in the office but not tracked yet');
  });
});
