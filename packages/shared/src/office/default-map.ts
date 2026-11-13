/**
 * The default office every organisation starts with (ADR 015, 055): generated in code, original
 * layout, no external artwork. 100 × 40 tiles (3200 × 1280 px): the main office (columns 0..59,
 * unchanged since ADR 015 apart from one doorway) and the campus to its right (columns 60..99).
 *
 *   ┌───────────┬───────────┬──────────┬────────────┬───────────────────────────┐
 *   │ Meeting A │ Meeting B │ Meeting C│ Board room │                           │
 *   ├──▯▯───────┴──▯▯───────┴──▯▯──────┼──▯▯────────┤   Garden & Relax          │
 *   │                                   ▯ Focus room │   (fountain, trees,       │
 *   │   open area: 20 desks (4 × 5)     ├────────────┤    benches, flowers)      │
 *   │                                   ▯ HR office  ├────▯▯▯────────▯▯▯────────┤
 *   ├────▯▯▯▯────────────────▯▯▯▯▯▯─────┴────────────┤ Café &      │ Arcade &    │
 *   │ Reception (spawn)  ▯   Lounge                  ▯ Chill       ▯ Play        │
 *   └────────────────────┴───────────────────────────┴─────────────┴─────────────┘
 *
 * The campus is reached from the Lounge only. It never touches the meeting, focus or HR rooms
 * (no doorway on their walls), so room permissions are unchanged.
 */
import { TILE_SIZE } from './map.ts';
import type { MapObject, OfficeDefinition, OfficeMap } from './map.ts';

const W = 100;
const H = 40;
/** The main office: columns 0..M-1. Its geometry is the original 60 × 40 office. */
const M = 60;
export const FLOOR = { VOID: 0, CARPET: 1, WOOD: 2, MEETING: 3, PRIVATE: 4, RECEPTION: 5, GRASS: 6, CAFE: 7, ARCADE: 8, PATH: 9 } as const;
/** ADR 055: the frontend-only campus mini-games a furniture object can open (property `game`). */
export const CAMPUS_GAMES = ['tictactoe', 'memory', 'puzzle'] as const;
export type CampusGame = (typeof CAMPUS_GAMES)[number];

export function generateDefaultFloor(): OfficeMap {
  const floor = new Array<number>(W * H).fill(FLOOR.CARPET);
  const walls = new Array<number>(W * H).fill(0);
  const set = (layer: number[], x: number, y: number, v: number) => { if (x >= 0 && y >= 0 && x < W && y < H) layer[y * W + x] = v; };
  const fill = (layer: number[], x0: number, y0: number, x1: number, y1: number, v: number) => { for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) set(layer, x, y, v); };
  const hwall = (y: number, x0: number, x1: number, gaps: number[] = []) => { for (let x = x0; x <= x1; x += 1) if (!gaps.includes(x)) set(walls, x, y, 1); };
  const vwall = (x: number, y0: number, y1: number, gaps: number[] = []) => { for (let y = y0; y <= y1; y += 1) if (!gaps.includes(y)) set(walls, x, y, 1); };

  // Outer walls; the main office's right wall has one doorway, from the Lounge into the café.
  hwall(0, 0, W - 1); hwall(H - 1, 0, W - 1); vwall(0, 0, H - 1); vwall(W - 1, 0, H - 1);
  vwall(M - 1, 0, H - 1, [33, 34, 35]);
  // Meeting band: rooms on rows 1..9, wall on row 10 with a two-tile door per room.
  hwall(10, 1, M - 2, [7, 8, 22, 23, 37, 38, 51, 52]);
  vwall(15, 1, 9); vwall(30, 1, 9); vwall(44, 1, 9);
  fill(floor, 1, 1, 14, 9, FLOOR.MEETING); fill(floor, 16, 1, 29, 9, FLOOR.MEETING); fill(floor, 31, 1, 43, 9, FLOOR.MEETING); fill(floor, 45, 1, 58, 9, FLOOR.MEETING);
  // Private rooms on the right, doors on their left wall.
  vwall(45, 11, 28, [14, 15, 23, 24]);
  hwall(19, 46, M - 2); hwall(28, 46, M - 2);
  fill(floor, 46, 11, 58, 18, FLOOR.PRIVATE); fill(floor, 46, 20, 58, 27, FLOOR.PRIVATE);
  // Bottom band: reception and lounge, with wide openings from the open area.
  hwall(29, 1, 44, [8, 9, 10, 11, 30, 31, 32, 33, 34, 35]);
  vwall(21, 30, 38, [33, 34, 35]);
  fill(floor, 1, 30, 20, 38, FLOOR.RECEPTION); fill(floor, 22, 30, 58, 38, FLOOR.WOOD);
  // The bottom-right corner below the HR office is part of the lounge; close it from the open area.
  hwall(29, 45, M - 2);
  // Campus (ADR 055): the garden across the top, the café and the arcade below it.
  hwall(20, M, W - 2, [68, 69, 70, 88, 89, 90]);
  vwall(79, 21, H - 2, [28, 29, 30]);
  fill(floor, M, 1, W - 2, 19, FLOOR.GRASS);
  fill(floor, 75, 6, 82, 13, FLOOR.PATH); // the fountain square
  fill(floor, 68, 12, 90, 13, FLOOR.PATH); // and the paths to the two doors
  fill(floor, 68, 12, 70, 19, FLOOR.PATH); fill(floor, 88, 12, 90, 19, FLOOR.PATH);
  fill(floor, M, 21, 78, H - 2, FLOOR.CAFE);
  fill(floor, 80, 21, W - 2, H - 2, FLOOR.ARCADE);

  let id = 1;
  const px = (t: number) => t * TILE_SIZE;
  const obj = (name: string, x: number, y: number, w: number, h: number, props: Record<string, string | number | boolean> = {}, type = ''): MapObject => ({
    id: id++, name, type, x: px(x), y: px(y), width: px(w), height: px(h),
    properties: Object.entries(props).map(([n, v]) => ({ name: n, type: typeof v === 'number' ? 'int' : typeof v === 'boolean' ? 'bool' : 'string', value: v })),
  });

  const rooms: MapObject[] = [
    obj('Meeting room A', 1, 1, 14, 9, { type: 'MEETING', capacity: 8, access: 'OPEN' }),
    obj('Meeting room B', 16, 1, 14, 9, { type: 'MEETING', capacity: 8, access: 'OPEN' }),
    obj('Meeting room C', 31, 1, 13, 9, { type: 'MEETING', capacity: 12, access: 'OPEN' }),
    obj('Board room', 45, 1, 14, 9, { type: 'MEETING', capacity: 16, access: 'KNOCK' }),
    obj('Focus room', 46, 11, 13, 8, { type: 'PRIVATE', capacity: 2, access: 'KNOCK' }),
    obj('HR office', 46, 20, 13, 8, { type: 'PRIVATE', capacity: 3, access: 'INVITE' }),
    obj('Reception', 1, 30, 20, 9, { type: 'OPEN', capacity: 30, access: 'OPEN' }),
    obj('Lounge', 22, 30, 37, 9, { type: 'OPEN', capacity: 40, access: 'OPEN' }),
    // ADR 055: open areas, no room call, no access rule.
    obj('Garden', M, 1, 39, 19, { type: 'OPEN', capacity: 60, access: 'OPEN' }),
    obj('Café', M, 21, 19, 18, { type: 'OPEN', capacity: 40, access: 'OPEN' }),
    obj('Arcade', 80, 21, 19, 18, { type: 'OPEN', capacity: 40, access: 'OPEN' }),
  ];
  const desks: MapObject[] = [];
  const furniture: MapObject[] = [];
  // 4 rows × 5 desks; a desk is a 2 × 2 area: table on top (blocks), seat below.
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 5; c += 1) {
      const x = 4 + c * 8;
      const y = 13 + r * 4;
      desks.push(obj(`Desk ${String.fromCharCode(65 + r)}${c + 1}`, x, y, 2, 2));
      furniture.push(obj('Table', x, y, 2, 1, { collides: true, kind: 'table' }));
    }
  }
  // Meeting tables in the middle of each meeting room; sofas in the lounge; a reception counter.
  furniture.push(obj('Table', 5, 4, 6, 2, { collides: true, kind: 'table' }), obj('Table', 20, 4, 6, 2, { collides: true, kind: 'table' }),
    obj('Table', 34, 4, 7, 2, { collides: true, kind: 'table' }), obj('Table', 48, 3, 8, 3, { collides: true, kind: 'table' }),
    obj('Sofa', 26, 32, 5, 1, { collides: true, kind: 'sofa' }), obj('Sofa', 36, 32, 5, 1, { collides: true, kind: 'sofa' }),
    obj('Sofa', 46, 35, 5, 1, { collides: true, kind: 'sofa' }), obj('Counter', 4, 31, 8, 1, { collides: true, kind: 'counter' }),
    obj('Plant', 2, 12, 1, 1, { collides: true, kind: 'plant' }), obj('Plant', 43, 12, 1, 1, { collides: true, kind: 'plant' }));
  // ---- Campus furniture (ADR 055). Solid pieces collide like any other furniture; `game` pieces
  // open a frontend-only mini-game when someone stands next to them.
  const solid = (name: string, x: number, y: number, w: number, h: number, kind: string, extra: Record<string, string> = {}) =>
    furniture.push(obj(name, x, y, w, h, { collides: true, kind, ...extra }));
  // Café & Chill
  solid('Coffee counter', 61, 21, 6, 2, 'coffee-counter');
  solid('Bookshelf', 73, 21, 5, 1, 'bookshelf');
  for (const [x, y] of [[64, 26], [68, 26], [72, 26], [68, 30], [72, 30]] as const) solid('Café table', x, y, 1, 1, 'cafe-table');
  solid('Sofa', 64, 35, 5, 1, 'sofa');
  solid('Coffee table', 65, 37, 3, 1, 'coffee-table');
  solid('Sofa', 72, 35, 5, 1, 'sofa');
  solid('Plant', 60, 38, 1, 1, 'plant'); solid('Plant', 78, 38, 1, 1, 'plant'); solid('Plant', 78, 21, 1, 1, 'plant');
  // Arcade & Play
  CAMPUS_GAMES.forEach((g, i) => {
    solid('Arcade cabinet', 81 + i * 2, 21, 1, 2, 'arcade', { game: g });
    solid('Arcade cabinet', 92 + i * 2, 21, 1, 2, 'arcade', { game: g });
  });
  solid('Ping-pong table', 84, 26, 4, 2, 'ping-pong');
  solid('Chess table', 93, 26, 2, 2, 'chess-table');
  solid('Board-game table', 83, 32, 2, 2, 'game-table', { game: 'tictactoe' });
  solid('Board-game table', 89, 32, 2, 2, 'game-table', { game: 'memory' });
  solid('Sofa', 92, 37, 5, 1, 'sofa');
  solid('Beanbag', 95, 32, 1, 1, 'beanbag'); solid('Beanbag', 97, 34, 1, 1, 'beanbag');
  solid('Plant', 80, 38, 1, 1, 'plant'); solid('Plant', 98, 38, 1, 1, 'plant');
  // Garden & Relax
  solid('Fountain', 77, 8, 4, 4, 'fountain');
  for (const [x, y] of [[62, 2], [72, 2], [86, 2], [95, 2], [62, 16], [95, 16]] as const) solid('Tree', x, y, 2, 2, 'tree');
  solid('Bench', 71, 9, 3, 1, 'bench'); solid('Bench', 85, 9, 3, 1, 'bench'); solid('Bench', 77, 15, 4, 1, 'bench');
  solid('Flower bed', 64, 9, 3, 2, 'flowers'); solid('Flower bed', 91, 9, 3, 2, 'flowers');
  solid('Flower bed', 78, 3, 2, 1, 'flowers'); solid('Flower bed', 73, 16, 2, 2, 'flowers'); solid('Flower bed', 84, 16, 2, 2, 'flowers');
  solid('Lounger', 92, 13, 1, 2, 'lounger'); solid('Lounger', 94, 13, 1, 2, 'lounger');
  solid('Lounger', 63, 12, 1, 2, 'lounger'); solid('Lounger', 65, 12, 1, 2, 'lounger');
  const spawn = [{ id: id++, name: 'spawn', type: '', x: px(10) + TILE_SIZE / 2, y: px(35) + TILE_SIZE / 2, width: 0, height: 0 }];

  return {
    type: 'map', orientation: 'orthogonal', infinite: false, width: W, height: H, tilewidth: TILE_SIZE, tileheight: TILE_SIZE,
    layers: [
      { type: 'tilelayer', name: 'floor', width: W, height: H, data: floor },
      { type: 'tilelayer', name: 'walls', width: W, height: H, data: walls },
      { type: 'objectgroup', name: 'rooms', objects: rooms },
      { type: 'objectgroup', name: 'desks', objects: desks },
      { type: 'objectgroup', name: 'furniture', objects: furniture },
      { type: 'objectgroup', name: 'spawn', objects: spawn },
    ],
  };
}

export function defaultOffice(): OfficeDefinition {
  return { name: 'Main office', floors: [{ id: 'ground', name: 'Ground floor', map: generateDefaultFloor() }] };
}
