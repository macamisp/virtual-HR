/**
 * Office campus (ADR 055): the default map's campus extension and the frontend-only mini-game
 * rules. The map is what the server validates movement against, so these are the guarantees the
 * campus must keep: the original office is untouched, the campus joins it only through the Lounge,
 * every area and game is reachable, and the games are deterministic and fair.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildGrid, CAMPUS_GAMES, distanceToRect, emptyBoard, findPath, gameObjects, GAME_REACH, generateDefaultFloor, mapRooms, memoryDeal, memoryFlip, memoryHide, memoryWon,
  nearestWalkable, objectLayer, OfficeMapSchema, prop, puzzleMove, puzzleShuffle, puzzleSolved, seededRandom, spawnPoint, TILE_SIZE as T, ticComputerMove, ticPlay, ticResult, tileLayer, walkable,
} from '../../../packages/shared/src/office/index.ts';
import type { Mark, TicBoard } from '../../../packages/shared/src/office/index.ts';

const map = generateDefaultFloor();
const W = map.width;
const floor = tileLayer(map, 'floor')!;
const walls = tileLayer(map, 'walls')!;
const grid = buildGrid(map);

/** Fingerprints of the original 60 x 40 office (ADR 015 / 054), taken before the campus was added. */
const ORIGINAL_TILES = '79ae155066bb093d50c28af8833dd33115bd96d4558a57217b78376f2d4b4f16';
/**
 * The 59 original objects WITH their ids and properties, as in the map production stores today
 * (78aef7e). The ids matter: the server matches rooms and desks to their rows by object id when a
 * map is replaced, so a renumbered desk would carry someone else's assignment.
 */
const ORIGINAL_OBJECTS = 'a5cd696409bd0343eea0e503136c268dded2cea628b87ecc69a8194ba38fbe24';
const ORIGINAL_MAX_ID = 59;

describe('Office campus map (ADR 055)', () => {
  it('is a valid map: 100 x 40 tiles, eleven rooms, the twenty desks', () => {
    OfficeMapSchema.parse(map);
    assert.equal(map.width, 100);
    assert.equal(map.height, 40);
    assert.deepEqual(mapRooms(map).map((r) => r.name), ['Meeting room A', 'Meeting room B', 'Meeting room C', 'Board room', 'Focus room', 'HR office', 'Reception', 'Lounge', 'Garden', 'Café', 'Arcade']);
    assert.equal(objectLayer(map, 'desks').length, 20);
  });

  it('leaves the original office exactly as it was, apart from one doorway from the Lounge', () => {
    const parts: string[] = [];
    for (let y = 0; y < 40; y += 1) for (let x = 0; x < 60; x += 1) { if (x === 59 && y >= 33 && y <= 35) continue; parts.push(`${floor[y * W + x]}/${walls[y * W + x]}`); }
    assert.equal(createHash('sha256').update(parts.join(',')).digest('hex'), ORIGINAL_TILES, 'every original tile');
    const objs = ['rooms', 'desks', 'furniture', 'spawn'].flatMap((l) => objectLayer(map, l).filter((o) => o.id <= ORIGINAL_MAX_ID).map((o) => JSON.stringify([l, o.id, o.name, o.x, o.y, o.width, o.height, o.properties ?? []])));
    assert.equal(objs.length, 59);
    assert.equal(createHash('sha256').update(objs.join('\n')).digest('hex'), ORIGINAL_OBJECTS, 'every original room, desk, furniture piece and the spawn, with its id');
    // Campus objects only take ids after the original ones; every id is unique.
    const all = ['rooms', 'desks', 'furniture', 'spawn'].flatMap((l) => objectLayer(map, l));
    assert.equal(new Set(all.map((o) => o.id)).size, all.length);
    for (const o of all) if (o.id > ORIGINAL_MAX_ID) assert.ok(o.x >= 59 * T, `object ${o.id} (${o.name}) is a campus object`);
    assert.deepEqual(spawnPoint(map), { x: 10 * T + T / 2, y: 35 * T + T / 2 });
  });

  it('joins the campus to the office only through the Lounge, never through a meeting, focus or HR room', () => {
    const openings: number[] = [];
    for (let y = 0; y < 40; y += 1) if (walls[y * W + 59] === 0) openings.push(y);
    assert.deepEqual(openings, [33, 34, 35]);
    const lounge = mapRooms(map).find((r) => r.name === 'Lounge')!;
    for (const y of openings) assert.ok(y * T >= lounge.bounds.y && y * T < lounge.bounds.y + lounge.bounds.height, 'the doorway opens from the Lounge');
    // The campus areas are open areas: no room call, no access rule, nobody locked out.
    for (const name of ['Garden', 'Café', 'Arcade']) {
      const r = mapRooms(map).find((x) => x.name === name)!;
      assert.equal(r.type, 'OPEN');
      assert.equal(r.access, 'OPEN');
    }
    // The access-controlled rooms keep their modes.
    const access = Object.fromEntries(mapRooms(map).map((r) => [r.name, r.access]));
    assert.equal(access['Board room'], 'KNOCK'); assert.equal(access['Focus room'], 'KNOCK'); assert.equal(access['HR office'], 'INVITE');
  });

  it('every room and every game can be reached from the spawn; no furniture blocks a doorway', () => {
    const start = spawnPoint(map);
    for (const r of mapRooms(map)) {
      const p = nearestWalkable(grid, { x: r.bounds.x + r.bounds.width / 2, y: r.bounds.y + r.bounds.height / 2 }, 8);
      assert.ok(p && findPath(grid, start, p, () => true), `${r.name} is reachable`);
    }
    const games = gameObjects(map);
    assert.equal(games.length, 8);
    assert.deepEqual([...new Set(games.map((g) => g.game))].sort(), [...CAMPUS_GAMES].sort());
    for (const { object, game } of games) {
      const spots = [{ x: object.x + object.width / 2, y: object.y + object.height + T / 2 }, { x: object.x - T / 2, y: object.y + object.height / 2 }, { x: object.x + object.width + T / 2, y: object.y + object.height / 2 }];
      const ok = spots.some((s) => walkable(grid, s.x, s.y) && distanceToRect(s, object) <= GAME_REACH && findPath(grid, start, s, () => true));
      assert.ok(ok, `${game} at ${object.x / T},${object.y / T} has a reachable place to stand within reach`);
      assert.equal(prop(object, 'collides', false), true, 'game furniture is solid');
    }
    for (const [x0, x1, y] of [[68, 70, 20], [88, 90, 20]] as const) for (let x = x0; x <= x1; x += 1) assert.ok(walkable(grid, x * T + T / 2, y * T + T / 2), `garden door ${x},${y}`);
    for (let y = 28; y <= 30; y += 1) assert.ok(walkable(grid, 79 * T + T / 2, y * T + T / 2), `café-arcade door 79,${y}`);
    for (let y = 33; y <= 35; y += 1) assert.ok(walkable(grid, 59 * T + T / 2, y * T + T / 2), `lounge-café door 59,${y}`);
  });
});

describe('Campus mini-games (ADR 055)', () => {
  it('Tic-Tac-Toe: rows, columns and diagonals win; a full board is a draw; illegal moves are refused', () => {
    const b = (s: string): TicBoard => [...s].map((c) => (c === 'X' || c === 'O' ? c : null));
    assert.deepEqual(ticResult(b('XXX......')), { winner: 'X', line: [0, 1, 2] });
    assert.deepEqual(ticResult(b('O..O..O..')), { winner: 'O', line: [0, 3, 6] });
    assert.deepEqual(ticResult(b('..X.X.X..')), { winner: 'X', line: [2, 4, 6] });
    assert.equal(ticResult(b('XOXXOOOXX')), 'draw');
    assert.equal(ticResult(emptyBoard()), null);
    assert.equal(ticPlay(b('X........'), 0, 'O'), null, 'taken');
    assert.equal(ticPlay(b('XXX......'), 5, 'O'), null, 'game over');
    assert.equal(ticPlay(emptyBoard(), 9, 'X'), null, 'off the board');
    assert.deepEqual(ticPlay(emptyBoard(), 4, 'X'), b('....X....'));
  });

  it('Tic-Tac-Toe: the perfect computer never loses, whatever the person plays', () => {
    let games = 0;
    const explore = (board: TicBoard) => {
      const r = ticResult(board);
      if (r) { games += 1; assert.ok(r === 'draw' || r.winner === 'O', `the computer lost: ${board.map((m) => m ?? '.').join('')}`); return; }
      for (let i = 0; i < 9; i += 1) {
        const mine = ticPlay(board, i, 'X');
        if (!mine) continue;
        if (ticResult(mine)) { explore(mine); continue; }
        const reply = ticComputerMove(mine, 'O' as Mark, 'perfect');
        explore(ticPlay(mine, reply!, 'O')!);
      }
    };
    explore(emptyBoard());
    assert.ok(games > 100, `explored ${games} games`);
    // The easy computer always plays a legal move, and can be beaten.
    const rnd = seededRandom(7);
    for (let k = 0; k < 50; k += 1) {
      const board = emptyBoard();
      board[k % 9] = 'X';
      const m = ticComputerMove(board, 'O', 'easy', rnd);
      assert.ok(m !== null && board[m] === null);
    }
    assert.equal(ticComputerMove([...'XOXXOOOXX'] as TicBoard, 'O'), null, 'no move on a finished board');
  });

  it('Memory Match: a seeded deal of pairs; matches stay, misses turn back; all pairs win', () => {
    const s0 = memoryDeal(8, 42);
    assert.deepEqual(memoryDeal(8, 42), s0, 'the same seed deals the same cards');
    assert.notDeepEqual(memoryDeal(8, 43).cards, s0.cards);
    assert.equal(s0.cards.length, 16);
    for (let f = 0; f < 8; f += 1) assert.equal(s0.cards.filter((c) => c.face === f).length, 2);
    const faces = s0.cards.map((c) => c.face);
    const a = 0;
    const twin = faces.indexOf(faces[a]!, a + 1);
    const other = faces.findIndex((f) => f !== faces[a]);
    // A miss: both stay open until hidden, and count as a move.
    let s = memoryFlip(memoryFlip(s0, a), other);
    assert.deepEqual(s.open, [a, other]);
    assert.equal(s.moves, 1);
    assert.deepEqual(memoryHide(s).open, []);
    // Turning a third card first hides the unmatched pair.
    s = memoryFlip(s, twin);
    assert.deepEqual(s.open, [twin]);
    // A match stays face up; turning a matched or open card again does nothing.
    s = memoryFlip(s, a);
    assert.ok(s.cards[a]!.matched && s.cards[twin]!.matched);
    assert.equal(memoryFlip(s, a), s);
    // Solving everything wins.
    let all = s0;
    for (let f = 0; f < 8; f += 1) { const [i, j] = faces.flatMap((x, k) => (x === f ? [k] : [])); all = memoryFlip(memoryFlip(all, i!), j!); }
    assert.ok(memoryWon(all));
    assert.equal(all.moves, 8);
  });

  it('Sliding puzzle: shuffles are solvable and never already solved; only pieces next to the gap move', () => {
    const solved = [1, 2, 3, 4, 5, 6, 7, 8, 0];
    assert.ok(puzzleSolved(solved));
    const inversions = (t: number[]) => { const v = t.filter((x) => x !== 0); let n = 0; for (let i = 0; i < v.length; i += 1) for (let j = i + 1; j < v.length; j += 1) if (v[i]! > v[j]!) n += 1; return n; };
    for (let seed = 1; seed <= 200; seed += 1) {
      const t = puzzleShuffle(3, seed);
      assert.deepEqual([...t].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
      assert.equal(inversions(t) % 2, 0, `seed ${seed}: solvable (even inversions on a 3 x 3 board)`);
      assert.ok(!puzzleSolved(t), `seed ${seed}: not already solved`);
    }
    assert.deepEqual(puzzleShuffle(3, 5), puzzleShuffle(3, 5));
    // The gap is at 8: piece 8 (index 7) and piece 6 (index 5) can move; piece 1 cannot.
    assert.equal(puzzleMove(solved, 0), solved);
    assert.deepEqual(puzzleMove(solved, 7), [1, 2, 3, 4, 5, 6, 7, 0, 8]);
    assert.deepEqual(puzzleMove(solved, 5), [1, 2, 3, 4, 5, 0, 7, 8, 6]);
    assert.ok(puzzleSolved(puzzleMove(puzzleMove(solved, 7), 8)), 'and back');
  });
});
