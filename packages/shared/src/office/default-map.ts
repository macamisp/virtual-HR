/**
 * The default office every organisation starts with (ADR 015): generated in code, original
 * layout, no external artwork. 60 × 40 tiles (1920 × 1280 px):
 *
 *   ┌───────────┬───────────┬──────────┬────────────┐
 *   │ Meeting A │ Meeting B │ Meeting C│ Board room │   meeting band (doors on the bottom wall)
 *   ├──▯▯───────┴──▯▯───────┴──▯▯──────┼──▯▯────────┤
 *   │                                   ▯ Focus room │
 *   │   open area: 20 desks (4 × 5)     ├────────────┤
 *   │                                   ▯ HR office  │
 *   ├────▯▯▯▯────────────────▯▯▯▯▯▯─────┴────────────┤
 *   │ Reception (spawn)  ▯   Lounge                  │
 *   └────────────────────┴───────────────────────────┘
 */
import { TILE_SIZE } from './map.ts';
import type { MapObject, OfficeDefinition, OfficeMap } from './map.ts';

const W = 60;
const H = 40;
export const FLOOR = { VOID: 0, CARPET: 1, WOOD: 2, MEETING: 3, PRIVATE: 4, RECEPTION: 5 } as const;

export function generateDefaultFloor(): OfficeMap {
  const floor = new Array<number>(W * H).fill(FLOOR.CARPET);
  const walls = new Array<number>(W * H).fill(0);
  const set = (layer: number[], x: number, y: number, v: number) => { if (x >= 0 && y >= 0 && x < W && y < H) layer[y * W + x] = v; };
  const fill = (layer: number[], x0: number, y0: number, x1: number, y1: number, v: number) => { for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) set(layer, x, y, v); };
  const hwall = (y: number, x0: number, x1: number, gaps: number[] = []) => { for (let x = x0; x <= x1; x += 1) if (!gaps.includes(x)) set(walls, x, y, 1); };
  const vwall = (x: number, y0: number, y1: number, gaps: number[] = []) => { for (let y = y0; y <= y1; y += 1) if (!gaps.includes(y)) set(walls, x, y, 1); };

  // Outer walls.
  hwall(0, 0, W - 1); hwall(H - 1, 0, W - 1); vwall(0, 0, H - 1); vwall(W - 1, 0, H - 1);
  // Meeting band: rooms on rows 1..9, wall on row 10 with a two-tile door per room.
  hwall(10, 1, W - 2, [7, 8, 22, 23, 37, 38, 51, 52]);
  vwall(15, 1, 9); vwall(30, 1, 9); vwall(44, 1, 9);
  fill(floor, 1, 1, 14, 9, FLOOR.MEETING); fill(floor, 16, 1, 29, 9, FLOOR.MEETING); fill(floor, 31, 1, 43, 9, FLOOR.MEETING); fill(floor, 45, 1, 58, 9, FLOOR.MEETING);
  // Private rooms on the right, doors on their left wall.
  vwall(45, 11, 28, [14, 15, 23, 24]);
  hwall(19, 46, W - 2); hwall(28, 46, W - 2);
  fill(floor, 46, 11, 58, 18, FLOOR.PRIVATE); fill(floor, 46, 20, 58, 27, FLOOR.PRIVATE);
  // Bottom band: reception and lounge, with wide openings from the open area.
  hwall(29, 1, 44, [8, 9, 10, 11, 30, 31, 32, 33, 34, 35]);
  vwall(21, 30, 38, [33, 34, 35]);
  fill(floor, 1, 30, 20, 38, FLOOR.RECEPTION); fill(floor, 22, 30, 58, 38, FLOOR.WOOD);
  // The bottom-right corner below the HR office is part of the lounge; close it from the open area.
  hwall(29, 45, W - 2);

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
