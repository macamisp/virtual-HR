'use client';

/**
 * The isometric office (ADR 061, phase B): original pixel art painted natively in the isometric
 * view, not the top-down art skewed. It reads the same map as the collision grid and never changes
 * it: floors, walls, rooms, desks, seats and furniture are exactly where the map puts them; only how
 * they look changes.
 *
 * - Floors are pre-painted 48 x 24 diamond stamps (wood planks, checker tiles, carpet, parquet,
 *   lawn, flagstones), stamped into canvas chunks with rugs and soft light. Nothing on the floor
 *   blocks anything.
 * - Walls stand up: every wall tile is an upright piece sorted with the avatars. Back walls along
 *   the map's far edges are tall; walls between rooms are medium and fade while the user is behind
 *   them; front walls are a low kerb. Faces are dressed by the room in front of them (brick,
 *   painted plaster with a skirting stripe, panelling, hedge).
 * - Furniture is drawn from each furniture rectangle as an outlined, shaded block with its own
 *   details: desks with monitors, chairs at every seat, sofas, counters, shelves, arcade cabinets
 *   with a marquee, a reclined screen and a control deck, cocktail game tables, café tables, the
 *   fountain, benches, beds and trees.
 *
 * All artwork is original. Like the reference, it uses dark outlines, a lit left face and a shaded
 * right face, but no logo, brand or character from it.
 */
import { mapSeats, objectLayer, prop, TILE_SIZE, tileLayer } from '@hrvo/shared';
import type { MapObject, OfficeMap, Seat } from '@hrvo/shared';
import { BRICK, buildAtlas, CREAM, GLASS, GOLD, GOLD_LIGHT, GRASS, hash, INDIGO, INK, LEAF, MAPLE, NAVY, NEON, NIGHT, OAK, Painter, pick, SLATE, STONE, TEAL, TERRA, VIOLET, WALNUT, WATER } from './pixel-kit';
import type { AtlasPiece, AtlasSprite } from './pixel-kit';
import { ISO_K } from './projection';
import type { Pt } from './projection';

const T = TILE_SIZE;
const K = ISO_K;
const TW = 2 * T * K; // diamond width (48)
const TH = T * K; // diamond height (24)
const CHUNK = 1024;
const FLOOR = { CARPET: 1, WOOD: 2, MEETING: 3, PRIVATE: 4, RECEPTION: 5, GRASS: 6, CAFE: 7, ARCADE: 8, PATH: 9 } as const;
const OUTLINE = 0x2a2230;

/** A map point at height z, in view pixels. */
const V = (x: number, y: number, z = 0): Pt => ({ x: (x - y) * K, y: ((x + y) * K) / 2 - z });

const shade = (c: number, f: number): number => {
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((c >> s) & 255) * f)));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};

// ---------------------------------------------------------------- isometric primitives

interface Faces { top: number; left: number; right: number; line?: number }
const facesOf = (c: number, line = OUTLINE): Faces => ({ top: shade(c, 1.12), left: c, right: shade(c, 0.78), line });

/** South face of a block (the lit left face on screen): along x at y, from z0 to z1. */
const southQ = (x0: number, x1: number, y: number, z0: number, z1: number): Pt[] => [V(x0, y, z0), V(x1, y, z0), V(x1, y, z1), V(x0, y, z1)];
/** East face (the shaded right face): along y at x. */
const eastQ = (x: number, y0: number, y1: number, z0: number, z1: number): Pt[] => [V(x, y1, z0), V(x, y0, z0), V(x, y0, z1), V(x, y1, z1)];
const topQ = (x0: number, y0: number, x1: number, y1: number, z: number): Pt[] => [V(x0, y0, z), V(x1, y0, z), V(x1, y1, z), V(x0, y1, z)];

function outline(p: Painter, pts: Pt[], colour: number, alpha = 1): void {
  for (let i = 0; i < pts.length; i += 1) { const a = pts[i]!; const b = pts[(i + 1) % pts.length]!; p.line(colour, a.x, a.y, b.x, b.y, alpha); }
}

/** An outlined block on the footprint (x, y, w, h) from z0 to z1. */
function box(p: Painter, x: number, y: number, w: number, h: number, z0: number, z1: number, c: Faces, sides = { s: true, e: true }): void {
  if (sides.s) p.poly(c.left, southQ(x, x + w, y + h, z0, z1));
  if (sides.e) p.poly(c.right, eastQ(x + w, y, y + h, z0, z1));
  const top = topQ(x, y, x + w, y + h, z1);
  p.poly(c.top, top);
  if (c.line === undefined) return;
  // Silhouette and the near vertical edge; a light line on the top's front edges.
  const s = V(x, y + h, z0); const se = V(x + w, y + h, z0); const e = V(x + w, y, z0);
  const n = V(x, y, z1); const ne = V(x + w, y, z1); const nw = V(x, y + h, z1); const f = V(x + w, y + h, z1);
  const L = c.line;
  p.line(L, s.x, s.y, se.x, se.y); p.line(L, se.x, se.y, e.x, e.y); p.line(L, e.x, e.y, ne.x, ne.y); p.line(L, s.x, s.y, nw.x, nw.y);
  p.line(L, nw.x, nw.y, n.x, n.y); p.line(L, n.x, n.y, ne.x, ne.y);
  p.line(shade(c.top, 1.15), nw.x + 1, nw.y, f.x, f.y, 0.9); p.line(shade(c.left, 0.7), f.x, f.y, se.x, se.y);
}

/** A point on a quad by its own coordinates (u across, v up), for details drawn on a face. */
function on(q: Pt[], u: number, v: number): Pt {
  const [a, b, c, d] = q as [Pt, Pt, Pt, Pt];
  const bottom = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  const top = { x: d.x + (c.x - d.x) * u, y: d.y + (c.y - d.y) * u };
  return { x: bottom.x + (top.x - bottom.x) * v, y: bottom.y + (top.y - bottom.y) * v };
}
const sub = (q: Pt[], u0: number, v0: number, u1: number, v1: number): Pt[] => [on(q, u0, v0), on(q, u1, v0), on(q, u1, v1), on(q, u0, v1)];

/** A soft floor shadow under a footprint. */
const floorShadow = (p: Painter, x: number, y: number, w: number, h: number, a = 0.22) => p.poly(INK, topQ(x - 2, y - 2, x + w + 6, y + h + 6, 0), a);

// ---------------------------------------------------------------- the map, read once

interface Scene {
  w: number; h: number; floor: number[];
  wall: (x: number, y: number) => boolean;
  open: (x: number, y: number) => boolean;
  furniture: MapObject[]; desks: MapObject[]; seats: Seat[];
}

function sceneOf(map: OfficeMap): Scene {
  const w = map.width;
  const h = map.height;
  const floor = tileLayer(map, 'floor') ?? [];
  const walls = tileLayer(map, 'walls') ?? [];
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h;
  const wall = (x: number, y: number) => inside(x, y) && (walls[y * w + x] ?? 0) !== 0;
  const open = (x: number, y: number) => inside(x, y) && !wall(x, y) && (floor[y * w + x] ?? 0) !== 0;
  return { w, h, floor, wall, open, furniture: objectLayer(map, 'furniture'), desks: objectLayer(map, 'desks'), seats: mapSeats(map) };
}
const floorAt = (s: Scene, tx: number, ty: number): number => (s.open(tx, ty) ? s.floor[ty * s.w + tx] ?? 0 : 0);
const kindOf = (f: MapObject): string => String(prop(f, 'kind', 'table')).toLowerCase();
const floorUnder = (s: Scene, f: MapObject): number => s.floor[Math.floor((f.y + f.height / 2) / T) * s.w + Math.floor((f.x + f.width / 2) / T)] ?? 0;
const isDesk = (s: Scene, f: MapObject) => s.desks.some((d) => d.x < f.x + f.width && d.x + d.width > f.x && d.y < f.y + f.height && d.y + d.height > f.y);

// ---------------------------------------------------------------- floor stamps

/** A point of a tile (map px inside the tile, 0..32) in the stamp's own pixels. */
const L = (mx: number, my: number): Pt => ({ x: (mx - my) * K + TH, y: ((mx + my) * K) / 2 });
const lq = (x0: number, y0: number, x1: number, y1: number): Pt[] => [L(x0, y0), L(x1, y0), L(x1, y1), L(x0, y1)];

function stamp(paint: (p: Painter) => void): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = TW; c.height = TH;
  const ctx = c.getContext('2d');
  if (ctx) { ctx.imageSmoothingEnabled = false; paint(new Painter(ctx)); }
  return c;
}

/** Planks along x (the seams run down to the right), staggered joints, a fine grain. */
function planks(p: Painter, tones: readonly number[], seam: number, v: number): void {
  for (let k = 0; k < 4; k += 1) {
    const y0 = k * 8;
    p.poly(pick(tones, hash(k, v, 7)), lq(0, y0, T, y0 + 8));
    p.poly(shade(pick(tones, hash(k, v, 7)), 1.1), lq(0, y0, T, y0 + 1.5));
    const a = L(0, y0 + 8); const b = L(T, y0 + 8);
    p.line(seam, a.x, a.y, b.x, b.y);
    const jx = 4 + (hash(k, v, 9) % 24);
    const j0 = L(jx, y0); const j1 = L(jx, y0 + 8);
    p.line(seam, j0.x, j0.y, j1.x, j1.y);
    const g0 = L((jx + 12) % T, y0 + 4); const g1 = L(((jx + 12) % T) + 6, y0 + 4);
    p.line(shade(seam, 1.2), g0.x, g0.y, g1.x, g1.y, 0.5);
  }
}

/** Square tiles, 2 x 2 per map tile, with grout. */
function checker(p: Painter, a: number, b: number, grout: number, v: number, motif?: number): void {
  for (let j = 0; j < 2; j += 1) for (let i = 0; i < 2; i += 1) {
    const c = (i + j + v) % 2 === 0 ? a : b;
    const q = lq(i * 16, j * 16, i * 16 + 16, j * 16 + 16);
    p.poly(c, q);
    p.poly(shade(c, 1.08), lq(i * 16, j * 16, i * 16 + 16, j * 16 + 2));
    if (motif !== undefined && c === a) { const m = L(i * 16 + 8, j * 16 + 8); p.r(motif, m.x - 1, m.y, 3, 1); p.r(motif, m.x, m.y - 1, 1, 3); }
  }
  for (const k of [0, 16]) { const s0 = L(k, 0); const s1 = L(k, T); p.line(grout, s0.x, s0.y, s1.x, s1.y, 0.8); const t0 = L(0, k); const t1 = L(T, k); p.line(grout, t0.x, t0.y, t1.x, t1.y, 0.8); }
}

function speckles(p: Painter, n: number, colours: readonly number[], v: number, salt: number): void {
  for (let i = 0; i < n; i += 1) { const h = hash(i, v, salt); const q = L(2 + (h % 28), 2 + ((h >>> 8) % 28)); p.r(pick(colours, h >>> 4), q.x, q.y, 1, 1); }
}

function floorStamps(): Map<number, HTMLCanvasElement[]> {
  const out = new Map<number, HTMLCanvasElement[]>();
  const make = (v: number, paint: (p: Painter, variant: number) => void) => out.set(v, [0, 1, 2, 3].map((n) => stamp((p) => paint(p, n))));
  make(FLOOR.WOOD, (p, n) => planks(p, [OAK.light, OAK.base, OAK.base, OAK.mid], OAK.dark, n));
  // The arcade: warm honey boards like the reference room.
  make(FLOOR.ARCADE, (p, n) => planks(p, [0xd9a35f, 0xcf9853, 0xc78d4b, 0xdcab6a], 0x9c6a35, n + 4));
  make(FLOOR.CARPET, (p, n) => {
    p.poly(pick([TEAL.base, TEAL.mid], n), lq(0, 0, T, T));
    for (let i = 4; i < T; i += 8) { const a = L(i, 0); const b = L(i, T); p.line(TEAL.line, a.x, a.y, b.x, b.y, 0.6); }
    speckles(p, 10, [TEAL.light, TEAL.dark], n, 11);
    const c = L(16, 16); p.r(TEAL.dark, c.x - 1, c.y, 3, 1);
  });
  make(FLOOR.MEETING, (p, n) => {
    p.poly(pick([0xbfcbdc, 0xb8c5d7], n), lq(0, 0, T, T));
    speckles(p, 8, [0xd9e1ea, SLATE.light], n, 12);
    const c = L(16, 16); p.r(SLATE.base, c.x - 2, c.y, 5, 1); p.r(SLATE.base, c.x, c.y - 1, 1, 3);
  });
  make(FLOOR.PRIVATE, (p, n) => {
    for (let j = 0; j < 2; j += 1) for (let i = 0; i < 2; i += 1) {
      const across = (i + j + n) % 2 === 0;
      for (let k = 0; k < 2; k += 1) {
        const tone = pick([MAPLE.light, MAPLE.base, MAPLE.mid], hash(i, j + k, n + 20));
        if (across) p.poly(tone, lq(i * 16, j * 16 + k * 8, i * 16 + 16, j * 16 + k * 8 + 8));
        else p.poly(tone, lq(i * 16 + k * 8, j * 16, i * 16 + k * 8 + 8, j * 16 + 16));
      }
    }
    for (const k of [0, 16]) { const a = L(k, 0); const b = L(k, T); p.line(MAPLE.line, a.x, a.y, b.x, b.y, 0.8); const c = L(0, k); const d = L(T, k); p.line(MAPLE.line, c.x, c.y, d.x, d.y, 0.8); }
  });
  // Reception: white and pale blue tiles, like the reference's raised floor.
  make(FLOOR.RECEPTION, (p, n) => checker(p, 0xf4f6f8, 0xc9dceb, 0x9fb3c6, n));
  // The café: one big terracotta or cream tile per map tile, a small teal star on the cream ones.
  make(FLOOR.CAFE, (p, n) => {
    const cream = n % 2 === 0;
    p.poly(cream ? CREAM.light : pick([TERRA.light, 0xd99475], n >> 1), lq(0, 0, T, T));
    p.poly(cream ? 0xffffff : 0xe6ab90, lq(0, 0, T, 2), 0.6);
    if (cream) { const c = L(16, 16); p.r(TEAL.dark, c.x - 2, c.y, 5, 1); p.r(TEAL.dark, c.x, c.y - 1, 1, 3); }
    const a = L(0, 0); const b = L(T, 0); const d = L(0, T); p.line(TERRA.dark, a.x, a.y, b.x, b.y, 0.6); p.line(TERRA.dark, a.x, a.y, d.x, d.y, 0.6);
  });
  make(FLOOR.GRASS, (p, n) => {
    p.poly(pick([GRASS.base, GRASS.mid, GRASS.light, GRASS.base], n), lq(0, 0, T, T));
    for (let i = 0; i < 9; i += 1) { const h = hash(i, n, 61); const q = L(2 + (h % 28), 2 + ((h >>> 7) % 28)); p.r(GRASS.dark, q.x, q.y - 1, 1, 2); p.r(GRASS.deep, q.x + 2, q.y - 2, 1, 3); p.r(GRASS.light, q.x + 1, q.y, 1, 1); }
    if (n === 2) { const q = L(12, 18); p.r(pick([0xf6f1e4, GOLD_LIGHT, TERRA.light], n), q.x, q.y, 2, 2); }
  });
  make(FLOOR.PATH, (p, n) => {
    p.poly(STONE.line, lq(0, 0, T, T));
    const stones = [[1, 1, 15, 14], [17, 1, 31, 10], [1, 16, 12, 31], [14, 16, 31, 31], [17, 12, 31, 15]] as const;
    stones.forEach(([x0, y0, x1, y1], i) => { const c = pick([STONE.base, STONE.mid, STONE.light], hash(i, n, 64)); p.poly(c, lq(x0, y0, x1, y1)); p.poly(shade(c, 1.08), lq(x0, y0, x1, y0 + 2)); });
  });
  out.set(0, [stamp((p) => p.poly(0xe0dcd3, lq(0, 0, T, T)))]);
  return out;
}

// ---------------------------------------------------------------- floor chunks (floor, rugs, light)

/** A rug on the floor: an edge, a field, an inner line. */
function isoRug(p: Painter, x: number, y: number, w: number, h: number, c: { edge: number; field: number; line: number }): void {
  p.poly(INK, topQ(x + 2, y + 2, x + w + 2, y + h + 2, 0), 0.12);
  p.poly(c.edge, topQ(x, y, x + w, y + h, 0));
  p.poly(c.field, topQ(x + 4, y + 4, x + w - 4, y + h - 4, 0));
  outline(p, topQ(x + 7, y + 7, x + w - 7, y + h - 7, 0), c.line);
}

function floorLight(p: Painter, cx: number, cy: number, r: number, colour = 0xffd27a): void {
  const c = V(cx, cy);
  for (const f of [1, 0.7, 0.45]) p.ellipse(colour, c.x, c.y, Math.round(r * f * K * 1.4), Math.round((r * f * K * 1.4) / 2), 0.06);
}

function paintFloor(p: Painter, s: Scene, stamps: Map<number, HTMLCanvasElement[]>, view: { x: number; y: number; w: number; h: number }): void {
  for (let ty = 0; ty < s.h; ty += 1) for (let tx = 0; tx < s.w; tx += 1) {
    // Walls are thin slabs: the floor of the room beside them runs underneath (never walkable there).
    const fl = s.open(tx, ty) ? s.floor[ty * s.w + tx] ?? 0 : s.wall(tx, ty) ? floorAt(s, tx, ty + 1) || floorAt(s, tx + 1, ty) || floorAt(s, tx, ty - 1) || floorAt(s, tx - 1, ty) : 0;
    if (!fl) continue;
    const top = V(tx * T, ty * T);
    const left = top.x - TH;
    if (left > view.x + view.w || left + TW < view.x || top.y > view.y + view.h || top.y + TH < view.y) continue;
    const set = stamps.get(fl) ?? stamps.get(0)!;
    // Café tiles alternate as a checkerboard (stamps 0 and 2 are cream, 1 and 3 terracotta).
    const pickN = fl === FLOOR.CAFE ? ((tx + ty) % 2) + 2 * (hash(tx, ty, 3) % 2) : hash(tx, ty, 3) % set.length;
    p.image(set[pickN % set.length]!, left, top.y);
  }
  // Wall shadows on the floor in front of the far walls.
  for (let ty = 0; ty < s.h; ty += 1) for (let tx = 0; tx < s.w; tx += 1) {
    if (!s.open(tx, ty)) continue;
    if (s.wall(tx, ty - 1)) p.poly(INK, topQ(tx * T, ty * T, tx * T + T, ty * T + 7, 0), 0.14);
    if (s.wall(tx - 1, ty)) p.poly(INK, topQ(tx * T, ty * T, tx * T + 6, ty * T + T, 0), 0.1);
  }
  // Rugs and light: a rug under each workstation, patterned rugs under meeting tables, sofas and game tables.
  for (const d of s.desks) isoRug(p, d.x - 8, d.y - 4, d.width + 16, d.height + 8, { edge: TEAL.ink, field: 0xddd2b8, line: 0xc4b594 });
  for (const f of s.furniture) {
    const kind = kindOf(f);
    const fl = floorUnder(s, f);
    if (kind === 'table' && !isDesk(s, f) && f.width >= 3 * T) isoRug(p, f.x - 30, f.y - 30, f.width + 60, f.height + 60, { edge: SLATE.deep, field: 0xd9dfe9, line: GOLD });
    else if (kind === 'sofa') isoRug(p, f.x + 6, f.y + f.height + 4, f.width - 12, 40, fl === FLOOR.ARCADE ? { edge: VIOLET.deep, field: 0xb04a8c, line: NEON.pink } : { edge: TERRA.deep, field: 0xe8cdb4, line: TEAL.deep });
    else if (kind === 'ping-pong') isoRug(p, f.x - 22, f.y - 18, f.width + 44, f.height + 36, { edge: INDIGO.dark, field: 0x3f5fb0, line: NEON.cyan });
    else if (kind === 'game-table' || kind === 'chess-table') isoRug(p, f.x - 20, f.y - 20, f.width + 40, f.height + 40, { edge: 0x1c4f5c, field: 0x2c7c88, line: NEON.yellow });
    else if (kind === 'counter') isoRug(p, f.x + 16, f.y + f.height + 8, f.width - 32, 26, { edge: NAVY.base, field: 0xb9c6dc, line: GOLD });
    if (kind === 'cafe-table') floorLight(p, f.x + f.width / 2, f.y + f.height / 2, 40);
    if (kind === 'arcade') { const c = V(f.x + f.width / 2, f.y + f.height + 8); const g = cabinetColours(f).glow; p.ellipse(g, c.x, c.y, 22, 9, 0.12); p.ellipse(g, c.x, c.y, 13, 5, 0.12); }
  }
  for (const d of s.desks) floorLight(p, d.x + d.width / 2, d.y + d.height / 2, 44);
}

// ---------------------------------------------------------------- walls

const TALL = 76;
const MID = 52;
const LOW = 10;

type Material = 'brick' | 'plaster' | 'panel' | 'boards' | 'hedge' | 'navy';
interface Finish { kind: Material; base: number; stripe: number; skirt: number }

/** How a wall face looks, from the floor in front of it (and which side it faces). */
function finish(fl: number, side: 's' | 'e'): Finish {
  switch (fl) {
    case FLOOR.ARCADE: return side === 'e' ? { kind: 'brick', base: 0xa5543c, stripe: 0, skirt: 0x5a2c22 } : { kind: 'plaster', base: 0xa9cfe6, stripe: 0x2d6fb3, skirt: 0x2d6fb3 };
    case FLOOR.WOOD: return { kind: 'brick', base: BRICK.base, stripe: 0, skirt: OAK.deep };
    case FLOOR.CAFE: return side === 'e' ? { kind: 'brick', base: 0xb3613f, stripe: 0, skirt: OAK.deep } : { kind: 'plaster', base: 0xf3e3c3, stripe: TEAL.deep, skirt: TERRA.dark };
    case FLOOR.CARPET: return { kind: 'plaster', base: 0xcfe3dc, stripe: TEAL.deep, skirt: TEAL.ink };
    case FLOOR.MEETING: return { kind: 'plaster', base: 0xc9d8ea, stripe: NAVY.light, skirt: NAVY.base };
    case FLOOR.PRIVATE: return { kind: 'boards', base: OAK.base, stripe: 0, skirt: OAK.line };
    case FLOOR.RECEPTION: return { kind: 'navy', base: NAVY.light, stripe: GOLD, skirt: NAVY.deep };
    case FLOOR.GRASS: case FLOOR.PATH: return { kind: 'hedge', base: LEAF.base, stripe: 0, skirt: LEAF.deep };
    default: return { kind: 'plaster', base: CREAM.base, stripe: OAK.mid, skirt: OAK.deep };
  }
}

/** Paints the texture of one wall face (a quad with u across, v up) and its skirting. */
function wallFace(p: Painter, q: Pt[], f: Finish, z: number, tx: number, ty: number, right: boolean): void {
  const dim = right ? 0.8 : 1;
  p.poly(shade(f.base, dim), q);
  const rows = Math.max(1, Math.round(z / 6));
  if (f.kind === 'brick') {
    for (let r = 0; r < rows; r += 1) {
      const v0 = r / rows; const v1 = (r + 1) / rows;
      const off = r % 2 ? 0.25 : 0;
      for (let u = -off; u < 1; u += 0.5) {
        const a = Math.max(0, u); const b = Math.min(1, u + 0.5);
        if (b - a < 0.05) continue;
        p.poly(shade(pick([f.base, shade(f.base, 0.9), shade(f.base, 1.1), shade(f.base, 0.95)], hash(tx * 7 + Math.round(u * 4), ty * 31 + r, right ? 2 : 1)), dim), sub(q, a + 0.03, v0 + 0.04, b - 0.03, v1 - 0.04));
      }
      const m0 = on(q, 0, v1); const m1 = on(q, 1, v1); p.line(shade(BRICK.mortar, dim), m0.x, m0.y, m1.x, m1.y, 0.55);
    }
  } else if (f.kind === 'boards') {
    for (let u = 0; u < 1; u += 0.25) { p.poly(shade(pick([OAK.base, OAK.mid, OAK.light], hash(tx, ty, Math.round(u * 8))), dim), sub(q, u, 0, u + 0.25, 1)); const a = on(q, u, 0); const b = on(q, u, 1); p.line(shade(OAK.dark, dim), a.x, a.y, b.x, b.y, 0.8); }
  } else if (f.kind === 'hedge') {
    for (let i = 0; i < 14; i += 1) { const h = hash(tx * 14 + i, ty, right ? 5 : 4); const c = on(q, (h % 100) / 100, ((h >>> 8) % 100) / 100); p.r(shade(pick([LEAF.light, LEAF.base, LEAF.dark], h >>> 3), dim), c.x - 1, c.y - 1, 3, 2); }
    return;
  } else if (f.kind === 'navy') {
    for (const u of [0.5]) { const a = on(q, u, 0.12); const b = on(q, u, 0.9); p.line(shade(NAVY.base, dim), a.x, a.y, b.x, b.y); }
  } else if (f.kind === 'panel') {
    const a = on(q, 0.5, 0.1); const b = on(q, 0.5, 0.9); p.line(shade(f.stripe, dim), a.x, a.y, b.x, b.y);
  }
  // Skirting at the bottom, a dado stripe a third of the way up (plaster and navy walls).
  p.poly(shade(f.skirt, dim), sub(q, 0, 0, 1, Math.min(0.35, 5 / z)));
  if (f.stripe && (f.kind === 'plaster' || f.kind === 'navy') && z > 30) p.poly(shade(f.stripe, dim), sub(q, 0, 0.3, 1, 0.3 + 3 / z));
}

/** Things on tall walls, one tile wide, inside the face quad: windows, posters, shelves, signs. */
function wallArt(p: Painter, q: Pt[], fl: number, tx: number, ty: number, right: boolean): void {
  const h = hash(tx, ty, right ? 41 : 40);
  if (h % 3 !== 0) return;
  const dim = right ? 0.82 : 1;
  const kind = h >>> 4;
  const frame = (u0: number, v0: number, u1: number, v1: number, edge: number, field: number) => { p.poly(shade(edge, dim), sub(q, u0, v0, u1, v1)); p.poly(shade(field, dim), sub(q, u0 + 0.06, v0 + 0.04, u1 - 0.06, v1 - 0.04)); };
  if (fl === FLOOR.ARCADE || fl === FLOOR.CAFE || fl === FLOOR.WOOD) {
    switch (kind % 4) {
      case 0: { // a framed poster: a sunset over a grid (original)
        frame(0.15, 0.45, 0.85, 0.92, NIGHT, 0x3b1d5e);
        p.poly(shade(NEON.orange, dim), sub(q, 0.35, 0.62, 0.65, 0.76)); p.poly(shade(NEON.pink, dim), sub(q, 0.21, 0.58, 0.79, 0.61));
        for (const u of [0.3, 0.45, 0.6, 0.75]) { const a = on(q, u, 0.48); const b = on(q, u, 0.58); p.line(shade(NEON.purple, dim), a.x, a.y, b.x, b.y); }
        return;
      }
      case 1: { // a neon star
        const c = on(q, 0.5, 0.68); p.ellipse(NEON.yellow, c.x, c.y, 7, 7, 0.18); p.r(NEON.yellow, c.x - 4, c.y, 9, 1); p.r(NEON.yellow, c.x, c.y - 4, 1, 9); p.r(NEON.white, c.x - 1, c.y - 1, 3, 3);
        return;
      }
      case 2: { // a shelf with a plant and figures
        const a = on(q, 0.1, 0.55); const b = on(q, 0.9, 0.55); p.line(OAK.deep, a.x, a.y, b.x, b.y); p.line(OAK.light, a.x, a.y - 1, b.x, b.y - 1);
        const c = on(q, 0.3, 0.58); p.r(TERRA.base, c.x - 2, c.y - 4, 5, 4); p.ellipse(LEAF.base, c.x, c.y - 7, 4, 3);
        const d = on(q, 0.68, 0.58); p.r(NEON.cyan, d.x - 1, d.y - 6, 2, 6); p.r(NEON.pink, d.x + 3, d.y - 5, 2, 5);
        return;
      }
      default: { // a framed rocket poster (original)
        frame(0.2, 0.42, 0.8, 0.9, GOLD, 0x141a3a);
        const c = on(q, 0.5, 0.66); p.r(NEON.white, c.x - 1, c.y - 6, 3, 9); p.r(0xe5484d, c.x - 1, c.y - 8, 3, 2); p.r(NEON.orange, c.x - 1, c.y + 3, 3, 3);
      }
    }
    return;
  }
  if (fl === FLOOR.GRASS || fl === FLOOR.PATH) return;
  switch (kind % 4) {
    case 0: case 1: { // a window with sky and a sill
      frame(0.14, 0.42, 0.86, 0.9, 0xf4f1ea, GLASS.base);
      p.poly(shade(GLASS.light, dim), sub(q, 0.22, 0.6, 0.45, 0.85));
      const a = on(q, 0.5, 0.45); const b = on(q, 0.5, 0.88); p.line(0xf4f1ea, a.x, a.y, b.x, b.y);
      return;
    }
    case 2: // a whiteboard with notes
      frame(0.1, 0.45, 0.9, 0.85, 0x8d97a6, 0xfbfbf8);
      for (const [v, c] of [[0.72, NAVY.base], [0.62, TERRA.base], [0.54, LEAF.base]] as const) { const a = on(q, 0.2, v); const b = on(q, 0.6, v); p.line(c, a.x, a.y, b.x, b.y); }
      return;
    default: { // a clock
      const c = on(q, 0.5, 0.66); p.ellipse(OAK.deep, c.x, c.y, 6, 6); p.ellipse(CREAM.light, c.x, c.y, 4, 4); p.r(NAVY.deep, c.x, c.y - 3, 1, 4); p.r(NAVY.deep, c.x, c.y, 3, 1);
    }
  }
}

interface WallTile { tx: number; ty: number; z: number }

function wallHeight(s: Scene, tx: number, ty: number): number {
  const front = s.open(tx, ty + 1) || s.open(tx + 1, ty);
  const behind = s.open(tx, ty - 1) || s.open(tx - 1, ty);
  if (!front) return LOW;
  return behind ? MID : TALL;
}

/** How far a wall slab stays in from a tile edge that has no wall beyond it: walls are thin, as in the reference. */
const INSET = 11;

/** A wall tile's slab: thin, reaching the tile edge only towards neighbouring walls, so corners join. */
function slabOf(s: Scene, tx: number, ty: number): { x0: number; y0: number; x1: number; y1: number } {
  const x = tx * T; const y = ty * T;
  return { x0: s.wall(tx - 1, ty) ? x : x + INSET, x1: s.wall(tx + 1, ty) ? x + T : x + T - INSET, y0: s.wall(tx, ty - 1) ? y : y + INSET, y1: s.wall(tx, ty + 1) ? y + T : y + T - INSET };
}

function drawWall(p: Painter, s: Scene, w: WallTile): void {
  const { x0, y0, x1, y1 } = slabOf(s, w.tx, w.ty);
  const z = w.z;
  const zOf = (tx: number, ty: number) => (s.wall(tx, ty) ? wallHeight(s, tx, ty) : 0);
  const zs = zOf(w.tx, w.ty + 1);
  const ze = zOf(w.tx + 1, w.ty);
  // South face (left on screen) and east face (right), only where nothing taller stands in front.
  if (zs < z) {
    const q = southQ(x0, x1, y1, zs, z);
    const fl = floorAt(s, w.tx, w.ty + 1) || floorAt(s, w.tx - 1, w.ty + 1) || floorAt(s, w.tx + 1, w.ty + 1) || floorAt(s, w.tx + 1, w.ty);
    wallFace(p, q, finish(fl, 's'), z - zs, w.tx, w.ty, false);
    if (z >= MID && zs === 0 && x1 - x0 > T * 0.8) wallArt(p, q, fl, w.tx, w.ty, false);
  }
  if (ze < z) {
    const q = eastQ(x1, y0, y1, ze, z);
    const fl = floorAt(s, w.tx + 1, w.ty) || floorAt(s, w.tx + 1, w.ty - 1) || floorAt(s, w.tx + 1, w.ty + 1) || floorAt(s, w.tx, w.ty + 1);
    wallFace(p, q, finish(fl, 'e'), z - ze, w.tx, w.ty, true);
    if (z >= MID && ze === 0 && y1 - y0 > T * 0.8) wallArt(p, q, fl, w.tx, w.ty, true);
  }
  // Top: a narrow cut capping, a light front edge.
  p.poly(z === TALL ? 0x4a4258 : 0x6a6176, topQ(x0, y0, x1, y1, z));
  const a = V(x0, y1, z); const b = V(x1, y1, z); const c = V(x1, y0, z);
  p.line(0x9a91a7, a.x, a.y, b.x, b.y); p.line(0x8a8197, b.x, b.y, c.x, c.y);
  // Outline the silhouette edges where the wall ends.
  if (!s.wall(w.tx, w.ty + 1) && !s.wall(w.tx - 1, w.ty)) { const s0 = V(x0, y1, 0); const s1 = V(x0, y1, z); p.line(OUTLINE, s0.x, s0.y, s1.x, s1.y); }
  if (!s.wall(w.tx + 1, w.ty) && !s.wall(w.tx, w.ty + 1)) { const e0 = V(x1, y1, 0); const e1 = V(x1, y1, z); p.line(OUTLINE, e0.x, e0.y, e1.x, e1.y, 0.7); }
  if (!s.wall(w.tx + 1, w.ty) && !s.wall(w.tx, w.ty - 1)) { const e0 = V(x1, y0, 0); const e1 = V(x1, y0, z); p.line(OUTLINE, e0.x, e0.y, e1.x, e1.y); }
}

// ---------------------------------------------------------------- furniture

interface CabinetColours { body: number; trim: number; glow: number; screen: number }
const CABINET_SETS: CabinetColours[] = [
  { body: 0xd8402f, trim: 0xffc53d, glow: NEON.orange, screen: 0x1b2b55 },
  { body: 0x5b3fb8, trim: NEON.pink, glow: NEON.pink, screen: 0x1a1b3a },
  { body: 0x2563b8, trim: NEON.cyan, glow: NEON.cyan, screen: 0x10223f },
  { body: 0x1f8a5b, trim: 0xd8f05a, glow: NEON.lime, screen: 0x0f2a22 },
  { body: 0x262a35, trim: 0xff7a3d, glow: NEON.orange, screen: 0x1a1d29 },
  { body: 0xc8325e, trim: 0x52e3ff, glow: NEON.cyan, screen: 0x24122a },
];
function cabinetColours(f: MapObject): CabinetColours { return CABINET_SETS[(Math.floor(f.x / T) + Math.floor(f.y / T)) % CABINET_SETS.length]!; }

/** A tiny game picture on a screen quad: a grid for tic-tac-toe, tiles for memory, a 3 x 3 puzzle. */
function screenArt(p: Painter, q: Pt[], game: string): void {
  if (game === 'tictactoe') {
    for (const u of [0.38, 0.62]) { const a = on(q, u, 0.15); const b = on(q, u, 0.85); p.line(NEON.white, a.x, a.y, b.x, b.y); }
    for (const v of [0.38, 0.62]) { const a = on(q, 0.15, v); const b = on(q, 0.85, v); p.line(NEON.white, a.x, a.y, b.x, b.y); }
    const o = on(q, 0.25, 0.75); p.r(NEON.pink, o.x - 1, o.y - 1, 3, 3); const x = on(q, 0.5, 0.5); p.r(NEON.cyan, x.x - 1, x.y - 1, 3, 3);
  } else {
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) {
      if (game === 'puzzle' && i === 2 && j === 0) continue;
      const c = on(q, 0.22 + i * 0.28, 0.22 + j * 0.28);
      p.r(pick([NEON.pink, NEON.yellow, NEON.cyan, NEON.lime, NEON.purple], i * 3 + j + (game === 'memory' ? 0 : 2)), c.x - 1, c.y - 1, 3, 2);
    }
  }
  p.poly(0xffffff, sub(q, 0.08, 0.7, 0.35, 0.92), 0.18); // glare
}

/** An upright arcade cabinet: the classic side profile, a lit marquee, a reclined screen, a control deck. */
function arcadeCabinet(p: Painter, f: MapObject): void {
  const c = cabinetColours(f);
  const game = String(prop(f, 'game', 'tictactoe'));
  const x0 = f.x + 3; const x1 = f.x + f.width - 3;
  const y0 = f.y + 2; const yf = f.y + f.height - 4; // back and front
  const yb = y0 + (yf - y0) * 0.55; // where the tall part ends
  floorShadow(p, x0, y0, x1 - x0, yf - y0, 0.3);
  // Side profile on the east face (the cabinet's long side), in (y, z) pairs.
  const prof: Array<[number, number]> = [[y0, 0], [yf, 0], [yf, 26], [yb + 6, 32], [yb, 58], [yb + 3, 66], [y0, 66]];
  const side = prof.map(([y, z]) => V(x1, y, z));
  // The west side is hidden behind; the tall back's front, the screen and the deck face the viewer.
  p.poly(shade(c.body, 0.75), side);
  // Front (south) faces: kick plate and coin door, the deck, the screen, the marquee.
  const kick = southQ(x0, x1, yf, 0, 26);
  p.poly(c.body, kick);
  p.poly(NIGHT, sub(kick, 0.3, 0.3, 0.7, 0.72));
  for (const u of [0.42, 0.58]) { const s = on(kick, u, 0.55); p.r(0xff5a3c, s.x, s.y, 1, 2); }
  const deck: Pt[] = [V(x0, yf, 26), V(x1, yf, 26), V(x1, yb + 6, 32), V(x0, yb + 6, 32)];
  p.poly(0x1f2230, deck);
  const stick = on(deck, 0.3, 0.5); p.r(NIGHT, stick.x, stick.y - 4, 1, 4); p.r(0xe5484d, stick.x - 1, stick.y - 6, 3, 3);
  for (let i = 0; i < 3; i += 1) { const b = on(deck, 0.55 + i * 0.13, 0.45); p.r(pick([NEON.yellow, NEON.cyan, NEON.pink], i), b.x, b.y - 1, 2, 2); }
  const screen: Pt[] = [V(x0, yb + 6, 32), V(x1, yb + 6, 32), V(x1, yb, 58), V(x0, yb, 58)];
  p.poly(NIGHT, screen);
  const glass = sub(screen, 0.1, 0.08, 0.9, 0.92);
  p.poly(c.screen, glass);
  screenArt(p, glass, game);
  const marquee: Pt[] = [V(x0, yb, 58), V(x1, yb, 58), V(x1, yb + 3, 66), V(x0, yb + 3, 66)];
  p.poly(c.trim, marquee);
  p.poly(0xffffff, sub(marquee, 0.1, 0.35, 0.9, 0.65), 0.45);
  p.poly(shade(c.body, 1.15), topQ(x0, y0, x1, yb + 3, 66));
  // Side livery: a stripe and a lit trim line along the profile.
  p.poly(c.trim, [V(x1, yf - 4, 6), V(x1, y0 + 4, 6), V(x1, y0 + 4, 12), V(x1, yf - 4, 12)], 0.85);
  p.poly(shade(c.trim, 0.8), [V(x1, yb - 2, 40), V(x1, y0 + 4, 40), V(x1, y0 + 4, 50), V(x1, yb - 3, 50)], 0.6);
  outline(p, side, OUTLINE);
  outline(p, [V(x0, yf, 0), V(x1, yf, 0), V(x1, yf, 26), V(x0, yf, 26)], OUTLINE);
  const l0 = V(x0, yf, 0); const l1 = V(x0, yf, 26); const l2 = V(x0, yb + 6, 32); const l3 = V(x0, yb, 58); const l4 = V(x0, yb + 3, 66); const l5 = V(x0, y0, 66);
  for (const [a, b] of [[l0, l1], [l1, l2], [l2, l3], [l3, l4], [l4, l5]] as const) p.line(OUTLINE, a.x, a.y, b.x, b.y);
}

/** A cocktail game table (sit-down cabinet): the game is on its glass top; or a chess board. */
function gameTable(p: Painter, f: MapObject, chess: boolean): void {
  const x = f.x + 6; const y = f.y + 6; const w = f.width - 12; const h = f.height - 12;
  floorShadow(p, x, y, w, h);
  box(p, x + w / 2 - 5, y + h / 2 - 5, 10, 10, 0, 12, facesOf(0x3a3f4b));
  box(p, x, y, w, h, 12, 24, facesOf(chess ? WALNUT.base : 0x2c3a5c));
  const top = topQ(x + 4, y + 4, x + w - 4, y + h - 4, 24);
  if (chess) {
    for (let i = 0; i < 6; i += 1) for (let j = 0; j < 6; j += 1) p.poly((i + j) % 2 ? 0xf2e6cf : 0x3b2a1e, sub(top, i / 6, j / 6, (i + 1) / 6, (j + 1) / 6));
  } else {
    p.poly(NIGHT, top);
    const glass = sub(top, 0.12, 0.12, 0.88, 0.88);
    p.poly(0x10223f, glass);
    screenArt(p, glass, String(prop(f, 'game', 'tictactoe')));
    const panel = southQ(x + 6, x + w - 6, y + h, 16, 22);
    p.poly(0x1f2230, panel);
    const b = on(panel, 0.5, 0.5); p.r(NEON.yellow, b.x - 1, b.y, 2, 1); p.r(0xe5484d, b.x + 3, b.y, 2, 1);
  }
}

function stool(p: Painter, cx: number, cy: number, colour = 0xe5484d): void {
  box(p, cx - 1, cy - 1, 3, 3, 0, 14, facesOf(0x3a3f4b));
  const c = V(cx, cy, 14);
  p.ellipse(OUTLINE, c.x, c.y + 1, 7, 4); p.ellipse(colour, c.x, c.y, 6, 3); p.ellipse(shade(colour, 1.2), c.x - 1, c.y - 1, 3, 1);
}

/** A chair at a seat; its back is on the side away from the table (paint only, seats stay walkable). */
function chair(p: Painter, seat: Seat): void {
  const { x, y } = seat;
  if (seat.kind === 'bench') return; // FR-VO-019: the bench or sofa is the seat
  if (seat.kind === 'game') { stool(p, x, y); return; }
  const col = seat.kind === 'desk' ? 0x3d4452 : seat.kind === 'cafe' ? OAK.base : NAVY.light;
  const c = facesOf(col);
  box(p, x - 2, y - 2, 4, 4, 0, 10, facesOf(0x2f3542));
  box(p, x - 8, y - 8, 16, 16, 10, 14, c);
  const back = { up: [x - 8, y + 5, 16, 3], down: [x - 8, y - 8, 16, 3], left: [x + 5, y - 8, 3, 16], right: [x - 8, y - 8, 3, 16] }[seat.facing];
  if (back) box(p, back[0]!, back[1]!, back[2]!, back[3]!, 14, seat.kind === 'desk' ? 26 : 24, c);
}

/** Draw order of a chair against the person sitting on it: a back in front of them sorts after. */
function chairDepth(seat: Seat): number {
  const d = seat.x + seat.y;
  if (seat.kind === 'game') return d - 8;
  return seat.facing === 'up' || seat.facing === 'left' ? d + 8 : d - 8;
}

function desk(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  floorShadow(p, x, y, w, h, 0.18);
  for (const [lx, ly] of [[x + 2, y + 2], [x + w - 5, y + 2], [x + 2, y + h - 5], [x + w - 5, y + h - 5]] as const) box(p, lx, ly, 3, 3, 0, 18, facesOf(OAK.dark));
  box(p, x, y, w, h - 2, 18, 22, facesOf(OAK.base, OAK.line));
  // Monitor on a stand, its screen to the chair (south).
  box(p, x + w - 22, y + 6, 4, 3, 22, 26, facesOf(0x4b5563));
  box(p, x + w - 30, y + 3, 20, 4, 26, 40, facesOf(0x2b3140));
  const scr = southQ(x + w - 29, x + w - 11, y + 7, 28, 39);
  p.poly(pick([0x8fc7e8, 0xa8dcc0, 0x9fb8f0], hash(x, y, 31)), scr);
  for (const v of [0.75, 0.55, 0.35]) { const a = on(scr, 0.12, v); const b = on(scr, 0.12 + 0.4 + (hash(x, Math.round(v * 9), 5) % 30) / 100, v); p.line(0xffffff, a.x, a.y, b.x, b.y, 0.6); }
  p.poly(0xc9ced6, topQ(x + w - 30, y + 14, x + w - 12, y + 20, 22)); // keyboard
  // Something personal on the left: a mug, a plant or a lamp.
  const v = hash(x, y, 77) % 3;
  if (v === 0) box(p, x + 10, y + 8, 5, 5, 22, 28, facesOf(CREAM.light));
  else if (v === 1) { box(p, x + 9, y + 7, 7, 7, 22, 28, facesOf(TERRA.base)); const c = V(x + 12, y + 10, 34); p.ellipse(LEAF.dark, c.x, c.y, 5, 4); p.ellipse(LEAF.base, c.x - 1, c.y - 1, 3, 2); }
  else { box(p, x + 10, y + 8, 2, 2, 22, 36, facesOf(NAVY.deep)); const c = V(x + 11, y + 9, 38); p.r(GOLD_LIGHT, c.x - 3, c.y - 2, 7, 3); }
}

function meetingTable(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  floorShadow(p, x, y, w, h);
  for (const [lx, ly] of [[x + 6, y + 6], [x + w - 10, y + 6], [x + 6, y + h - 10], [x + w - 10, y + h - 10]] as const) box(p, lx, ly, 4, 4, 0, 18, facesOf(OAK.deep));
  box(p, x, y, w, h, 18, 22, facesOf(OAK.base, OAK.line));
  p.poly(NAVY.base, topQ(x + 20, y + h / 2 - 4, x + w - 20, y + h / 2 + 4, 22));
  for (let i = x + 14; i < x + w - 14; i += 32) {
    const v = hash(i, y, 41) % 3;
    if (v === 0) box(p, i, y + 6, 12, 8, 22, 24, facesOf(0x9aa3af)); // laptop
    else if (v === 1) p.poly(CREAM.light, topQ(i, y + h - 16, i + 9, y + h - 8, 22)); // paper
  }
  const c = V(x + w / 2, y + h / 2, 30); p.ellipse(LEAF.dark, c.x, c.y, 6, 4); p.ellipse(LEAF.base, c.x - 1, c.y - 2, 4, 2);
}

function sofa(p: Painter, f: MapObject, colour: number): void {
  const { x, y, width: w, height: h } = f;
  floorShadow(p, x, y, w, h);
  box(p, x, y, w, h, 0, 12, facesOf(shade(colour, 0.85)));
  box(p, x, y, w, 9, 12, 30, facesOf(colour)); // back rest along the far side
  box(p, x, y + 9, 7, h - 9, 12, 20, facesOf(colour));
  box(p, x + w - 7, y + 9, 7, h - 9, 12, 20, facesOf(colour));
  for (let cx = x + 8; cx < x + w - 10; cx += Math.max(18, (w - 16) / 3)) p.poly(shade(colour, 1.18), topQ(cx + 1, y + 10, cx + Math.max(16, (w - 16) / 3) - 2, y + h - 2, 13));
  box(p, x + 10, y + 7, 8, 4, 14, 26, facesOf(CREAM.light)); // cushions
  box(p, x + w - 19, y + 7, 8, 4, 14, 26, facesOf(TEAL.dark));
}

function counter(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  floorShadow(p, x, y, w, h);
  box(p, x, y, w, h, 0, 26, { top: NAVY.base, left: NAVY.base, right: NAVY.mid, line: OUTLINE });
  const front = southQ(x, x + w, y + h, 0, 26);
  p.poly(GOLD, sub(front, 0, 0.18, 1, 0.24)); p.poly(GOLD, sub(front, 0, 0.82, 1, 0.86));
  for (let u = 0.1; u < 1; u += 0.2) p.poly(NAVY.light, sub(front, u, 0.3, u + 0.12, 0.75), 0.6);
  box(p, x - 1, y - 1, w + 2, h + 2, 26, 29, facesOf(CREAM.base));
  box(p, x + 10, y + 4, 14, 4, 29, 40, facesOf(0x2b3140));
  p.poly(0x8fc7e8, southQ(x + 11, x + 23, y + 8, 31, 39));
  const b = V(x + w / 2, y + h / 2, 32); p.r(GOLD, b.x - 3, b.y, 7, 2); p.r(GOLD_LIGHT, b.x - 1, b.y - 2, 3, 2);
  const v = V(x + w - 18, y + h / 2, 29); p.r(TERRA.base, v.x - 3, v.y - 6, 6, 6); p.ellipse(LEAF.base, v.x, v.y - 10, 5, 4);
}

function coffeeCounter(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  floorShadow(p, x, y, w, h);
  box(p, x, y, w, h, 0, 26, facesOf(OAK.dark));
  const front = southQ(x, x + w, y + h, 0, 26);
  for (let u = 0.08; u < 1; u += 0.16) { const a = on(front, u, 0.1); const b = on(front, u, 0.85); p.line(OAK.deep, a.x, a.y, b.x, b.y); }
  p.poly(NAVY.deep, sub(front, 0.72, 0.25, 0.94, 0.8)); // menu board
  for (const v of [0.68, 0.55, 0.42]) { const a = on(front, 0.75, v); const b = on(front, 0.9, v); p.line(CREAM.base, a.x, a.y, b.x, b.y); }
  box(p, x - 1, y - 1, w + 2, h + 2, 26, 29, facesOf(CREAM.base));
  box(p, x + 8, y + 6, 28, 18, 29, 48, facesOf(0x9aa3af)); // espresso machine
  p.poly(TERRA.base, southQ(x + 8, x + 36, y + 24, 40, 43));
  box(p, x + 42, y + 8, 9, 9, 29, 46, facesOf(0x3a3f4b)); // grinder
  for (let i = 0; i < 3; i += 1) box(p, x + 58 + i * 7, y + 30, 4, 4, 29, 34, facesOf(CREAM.light));
  if (w > 120) { box(p, x + w - 54, y + 10, 42, 22, 29, 42, { top: GLASS.light, left: GLASS.base, right: GLASS.dark, line: 0x6b8fa8 }); for (let i = 0; i < 4; i += 1) { const c = V(x + w - 48 + i * 10, y + 28, 32); p.r(pick([0xd9a05b, 0xb7703c, 0xe7c38a], i), c.x - 2, c.y - 2, 5, 3); } }
}

function bookshelf(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  box(p, x, y, w, h, 0, 58, facesOf(OAK.deep));
  const front = southQ(x + 2, x + w - 2, y + h, 3, 56);
  p.poly(OAK.line, front);
  const rows = 4;
  for (let r = 0; r < rows; r += 1) {
    const v0 = r / rows; const v1 = (r + 1) / rows;
    const sh0 = on(front, 0, v0); const sh1 = on(front, 1, v0); p.line(OAK.base, sh0.x, sh0.y, sh1.x, sh1.y);
    let u = 0.02;
    while (u < 0.97) {
      const hv = hash(Math.round(u * 100), r, f.x);
      const bw = 0.025 + (hv % 3) * 0.008;
      if (hv % 9 === 0) { const c = on(front, u + 0.03, v0 + 0.3); p.r(TERRA.base, c.x - 2, c.y - 2, 5, 3); p.ellipse(LEAF.base, c.x, c.y - 5, 3, 2); u += 0.07; continue; }
      p.poly(pick([NAVY.base, TERRA.base, CREAM.base, TEAL.deep, GOLD, NAVY.light, TERRA.dark, LEAF.dark], hv >>> 4), sub(front, u, v0 + 0.06, Math.min(0.98, u + bw), v1 - (hv % 4 === 0 ? 0.3 : 0.12)));
      u += bw + 0.006;
    }
  }
}

function cafeTable(p: Painter, f: MapObject): void {
  const cx = f.x + f.width / 2; const cy = f.y + f.height / 2;
  floorShadow(p, cx - 10, cy - 10, 20, 20);
  box(p, cx - 2, cy - 2, 4, 4, 0, 18, facesOf(0x3a3f4b));
  const t = V(cx, cy, 18);
  p.ellipse(OUTLINE, t.x, t.y + 2, 16, 8); p.ellipse(OAK.dark, t.x, t.y + 1, 15, 7); p.ellipse(CREAM.base, t.x, t.y, 15, 7); p.ellipse(CREAM.light, t.x - 3, t.y - 2, 8, 3);
  p.r(TERRA.base, t.x - 7, t.y - 3, 4, 4); p.r(0x5b3a29, t.x - 6, t.y - 3, 2, 1); p.r(CREAM.light, t.x + 2, t.y - 1, 6, 3); p.r(0xd9a05b, t.x + 3, t.y - 1, 4, 2);
  // A pendant lamp above.
  const l = V(cx, cy, 60); p.line(0x2f3542, l.x, l.y - 14, l.x, l.y); p.ellipse(0x2f3542, l.x, l.y + 2, 6, 3); p.r(GOLD_LIGHT, l.x - 3, l.y + 4, 7, 2);
}

function coffeeTable(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  floorShadow(p, x, y, w, h);
  box(p, x + 4, y + 4, w - 8, h - 8, 0, 12, facesOf(OAK.base));
  p.poly(TEAL.dark, topQ(x + 12, y + 8, x + 26, y + 18, 12)); p.poly(CREAM.light, topQ(x + 30, y + 10, x + 40, y + 20, 12));
}

function plant(p: Painter, cx: number, cy: number, big = true): void {
  const k = big ? 1 : 0.75;
  floorShadow(p, cx - 7 * k, cy - 7 * k, 14 * k, 14 * k);
  box(p, cx - 6 * k, cy - 6 * k, 12 * k, 12 * k, 0, 12 * k, facesOf(TERRA.base));
  const c = V(cx, cy, 12 * k);
  for (const [dx, dy, r, col] of [[0, -14, 9, LEAF.deep], [-5, -10, 6, LEAF.dark], [5, -11, 6, LEAF.dark], [-2, -18, 6, LEAF.base], [3, -15, 4, LEAF.base], [-3, -20, 3, LEAF.light]] as const) p.ellipse(col, c.x + dx * k, c.y + dy * k, Math.round(r * k), Math.round(r * k * 0.8));
}

function tree(p: Painter, f: MapObject): void {
  const cx = f.x + f.width / 2; const cy = f.y + f.height / 2;
  const g = V(cx, cy); p.ellipse(INK, g.x, g.y, 30, 12, 0.2);
  box(p, cx - 4, cy - 4, 8, 8, 0, 30, facesOf(0x7a5236));
  const c = V(cx, cy, 30);
  for (const [dx, dy, r, col] of [[0, -22, 30, LEAF.deep], [-12, -14, 18, LEAF.dark], [12, -16, 18, LEAF.dark], [0, -32, 20, LEAF.base], [-8, -26, 12, LEAF.base], [10, -28, 10, LEAF.light], [-4, -38, 8, LEAF.light]] as const) p.ellipse(col, c.x + dx, c.y + dy, r, Math.round(r * 0.85));
}

function fountain(p: Painter, f: MapObject): void {
  const cx = f.x + f.width / 2; const cy = f.y + f.height / 2;
  const r = Math.min(f.width, f.height) / 2 - 4;
  const rx = Math.round(r * K * Math.SQRT2);
  const ry = Math.round(rx / 2);
  const base = V(cx, cy, 0); const rim = V(cx, cy, 14);
  p.ellipse(INK, base.x, base.y + 2, rx + 3, ry + 2, 0.2);
  p.ellipse(STONE.dark, base.x, base.y, rx, ry);
  p.r(STONE.mid, base.x - rx, rim.y, rx * 2 + 1, base.y - rim.y);
  p.ellipse(STONE.light, rim.x, rim.y, rx, ry);
  p.ellipse(WATER.mid, rim.x, rim.y + 1, rx - 5, ry - 3);
  p.ellipse(WATER.base, rim.x - 4, rim.y, rx - 12, ry - 6);
  p.ellipse(WATER.light, rim.x - 8, rim.y - 2, 6, 2);
  box(p, cx - 5, cy - 5, 10, 10, 0, 34, facesOf(STONE.base));
  const top = V(cx, cy, 34); p.ellipse(STONE.light, top.x, top.y, 9, 4);
  for (let i = 0; i < 9; i += 1) { const a = (i / 9) * Math.PI * 2; p.r(WATER.light, Math.round(top.x + Math.cos(a) * 9), Math.round(top.y - 6 + Math.abs(Math.sin(a)) * 8), 1, 3); }
  p.r(0xffffff, top.x - 1, top.y - 12, 2, 10, 0.8);
}

function bench(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  floorShadow(p, x, y, w, h);
  for (const lx of [x + 4, x + w - 8]) box(p, lx, y + 6, 4, h - 10, 0, 12, facesOf(0x3a3f4b));
  for (let k = 0; k < 3; k += 1) box(p, x, y + 8 + k * 6, w, 5, 12, 14, facesOf(OAK.base));
  box(p, x, y + 2, w, 4, 14, 26, facesOf(OAK.mid));
}

function flowers(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  floorShadow(p, x, y, w, h);
  box(p, x, y, w, h, 0, 10, facesOf(OAK.dark));
  p.poly(0x5b3a29, topQ(x + 3, y + 3, x + w - 3, y + h - 3, 10));
  for (let i = 0; i < Math.floor((w * h) / 90); i += 1) {
    const hv = hash(i, f.x, f.y);
    const c = V(x + 5 + (hv % (w - 10)), y + 5 + ((hv >>> 8) % (h - 10)), 12);
    p.r(LEAF.dark, c.x, c.y, 1, 3); p.r(pick([0xe0595c, GOLD_LIGHT, 0xf6f1e4, VIOLET.light, TERRA.light], hv >>> 4), c.x - 1, c.y - 2, 3, 2);
  }
}

function lounger(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  floorShadow(p, x, y, w, h);
  box(p, x + 3, y + 3, w - 6, h - 6, 0, 10, facesOf(0xf6f1e4));
  box(p, x + 3, y + 3, w - 6, 12, 10, 18, facesOf(0x4fa3c7));
  for (let k = y + 18; k < y + h - 6; k += 6) p.poly(0x4fa3c7, topQ(x + 4, k, x + w - 4, k + 2, 10));
}

function pingPong(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  floorShadow(p, x, y, w, h);
  for (const [lx, ly] of [[x + 8, y + 8], [x + w - 12, y + 8], [x + 8, y + h - 12], [x + w - 12, y + h - 12]] as const) box(p, lx, ly, 4, 4, 0, 18, facesOf(0x3a3f4b));
  box(p, x, y, w, h, 18, 22, facesOf(0x2f6e4f));
  const top = topQ(x + 2, y + 2, x + w - 2, y + h - 2, 22);
  outline(p, top, 0xffffff, 0.9);
  const m0 = V(x + 2, y + h / 2, 22); const m1 = V(x + w - 2, y + h / 2, 22); p.line(0xffffff, m0.x, m0.y, m1.x, m1.y, 0.8);
  p.poly(0xe9eef2, eastQ(x + w / 2, y - 2, y + h + 2, 22, 30), 0.85);
  const n0 = V(x + w / 2, y - 2, 30); const n1 = V(x + w / 2, y + h + 2, 30); p.line(0x3a3f4b, n0.x, n0.y, n1.x, n1.y);
  const b1 = V(x + 20, y + 14, 23); p.r(0xe5484d, b1.x - 3, b1.y - 2, 6, 3); const b2 = V(x + w - 24, y + h - 14, 23); p.r(0x2563b8, b2.x - 3, b2.y - 2, 6, 3);
}

function beanbag(p: Painter, f: MapObject): void {
  const c = V(f.x + f.width / 2, f.y + f.height / 2, 0);
  const col = pick([0xe5a33a, 0x3fb3b0, VIOLET.base], Math.floor(f.x / T));
  p.ellipse(INK, c.x, c.y + 2, 15, 7, 0.2); p.ellipse(shade(col, 0.8), c.x, c.y - 4, 14, 9); p.ellipse(col, c.x - 1, c.y - 7, 12, 7); p.ellipse(shade(col, 1.2), c.x - 4, c.y - 10, 5, 3);
}

/** FR-VO-019: a swimming pool sunk into a stone deck: tiled water, lane ropes, a ladder. */
function isoPool(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  box(p, x, y, w, h, 0, 4, facesOf(STONE.light, 0x9a8d74));
  const ix = x + 10; const iy = y + 10; const iw = w - 20; const ih = h - 20;
  p.poly(0x2f7fa6, topQ(ix - 2, iy - 2, ix + iw + 2, iy + ih + 2, 4));
  p.poly(WATER.base, topQ(ix, iy, ix + iw, iy + ih, 2));
  p.poly(WATER.mid, topQ(ix, iy, ix + iw, iy + 6, 2));
  for (let gx = ix + 10; gx < ix + iw; gx += 10) { const a = V(gx, iy, 2); const b = V(gx, iy + ih, 2); p.line(WATER.light, a.x, a.y, b.x, b.y, 0.35); }
  for (const k of [1, 2]) {
    const ly = iy + (ih * k) / 3;
    for (let lx = ix + 2; lx < ix + iw - 4; lx += 8) { const a = V(lx, ly, 3); const b = V(lx + 5, ly, 3); p.line(Math.round(lx / 8) % 2 ? 0xe5484d : 0xffffff, a.x, a.y, b.x, b.y); }
  }
  for (const lx of [ix + iw - 12, ix + iw - 4]) box(p, lx, iy - 3, 2, 2, 2, 18, facesOf(0xc0c6ce));
  const r0 = V(ix + iw - 12, iy - 2, 14); const r1 = V(ix + iw - 4, iy - 2, 14); p.line(0xe5e7eb, r0.x, r0.y, r1.x, r1.y);
}

/** FR-VO-019: a garden pond: a pebble rim, water, lily pads with a flower, reeds. */
function isoPond(p: Painter, f: MapObject): void {
  const c = V(f.x + f.width / 2, f.y + f.height / 2);
  const rx = Math.round(((f.width + f.height) / 2) * K * 0.72);
  const ry = Math.round(rx / 2);
  p.ellipse(INK, c.x, c.y + 2, rx + 2, ry + 1, 0.18);
  p.ellipse(STONE.dark, c.x, c.y, rx, ry);
  for (let i = 0; i < 28; i += 1) { const a = (i / 28) * Math.PI * 2; p.r(pick([STONE.light, STONE.base, STONE.mid], i), Math.round(c.x + Math.cos(a) * (rx - 3)) - 2, Math.round(c.y + Math.sin(a) * (ry - 2)) - 1, 4, 2); }
  p.ellipse(WATER.dark, c.x, c.y + 1, rx - 6, ry - 4);
  p.ellipse(WATER.mid, c.x - 2, c.y, rx - 10, ry - 6);
  p.ellipse(WATER.base, c.x - 6, c.y - 1, Math.max(4, rx - 22), Math.max(2, ry - 10));
  for (const [dx, dy] of [[-18, 3], [14, -3], [4, 5]] as const) { p.ellipse(LEAF.dark, c.x + dx, c.y + dy, 6, 3); p.ellipse(LEAF.base, c.x + dx - 1, c.y + dy - 1, 5, 2); }
  p.r(0xf6a5b5, c.x + 12, c.y - 6, 4, 2); p.r(GOLD_LIGHT, c.x + 13, c.y - 6, 2, 1);
  for (let i = 0; i < 6; i += 1) { const rxx = c.x + rx - 12 + i * 2; p.r(LEAF.dark, rxx, c.y - ry - 8 + (i % 3), 1, 12); p.r(0x8a5a35, rxx, c.y - ry - 9 + (i % 3), 1, 3); }
}

function cabinet(p: Painter, f: MapObject): void {
  floorShadow(p, f.x, f.y, f.width, f.height);
  box(p, f.x, f.y, f.width, f.height, 0, 28, facesOf(OAK.base));
}

function furnitureItem(p: Painter, s: Scene, f: MapObject): void {
  const kind = kindOf(f);
  const fl = floorUnder(s, f);
  switch (kind) {
    case 'arcade': arcadeCabinet(p, f); return;
    case 'game-table': gameTable(p, f, false); return;
    case 'chess-table': gameTable(p, f, true); return;
    case 'ping-pong': pingPong(p, f); return;
    case 'sofa': sofa(p, f, fl === FLOOR.ARCADE ? VIOLET.base : fl === FLOOR.CAFE ? TEAL.dark : TERRA.base); return;
    case 'counter': counter(p, f); return;
    case 'coffee-counter': coffeeCounter(p, f); return;
    case 'bookshelf': bookshelf(p, f); return;
    case 'cafe-table': cafeTable(p, f); return;
    case 'coffee-table': coffeeTable(p, f); return;
    case 'plant': plant(p, f.x + f.width / 2, f.y + f.height / 2); return;
    case 'tree': tree(p, f); return;
    case 'fountain': fountain(p, f); return;
    case 'pool': isoPool(p, f); return;
    case 'pond': isoPond(p, f); return;
    case 'bench': bench(p, f); return;
    case 'flowers': flowers(p, f); return;
    case 'lounger': lounger(p, f); return;
    case 'beanbag': beanbag(p, f); return;
    case 'table': if (isDesk(s, f)) desk(p, f); else if (f.width >= 3 * T) meetingTable(p, f); else cabinet(p, f); return;
    default: cabinet(p, f);
  }
}

/** How far a piece reaches above and around its footprint, in view pixels. */
function extent(x: number, y: number, w: number, h: number, up: number, margin = 14): { x: number; y: number; width: number; height: number } {
  const left = V(x, y + h).x - margin;
  const right = V(x + w, y).x + margin;
  const top = V(x, y).y - up - 4;
  const bottom = V(x + w, y + h).y + Math.min(margin, 8);
  return { x: Math.floor(left), y: Math.floor(top), width: Math.ceil(right - left), height: Math.ceil(bottom - top) };
}

const RISE: Record<string, number> = { pool: 24, pond: 24, arcade: 80, tree: 140, bookshelf: 70, 'coffee-counter': 56, fountain: 60, plant: 46, counter: 48, sofa: 36, table: 50 };

// ---------------------------------------------------------------- output

export interface IsoChunk { canvas: HTMLCanvasElement; x: number; y: number }
export interface IsoPieceInfo { fade: boolean; game: number | null }
export interface IsoEnvironment {
  chunks: IsoChunk[];
  props: { canvas: HTMLCanvasElement; sprites: AtlasSprite[] } | null;
  /** One entry per prop sprite, same order: may it fade when the user stands behind it; the game object id it shows. */
  info: IsoPieceInfo[];
}

/** The whole isometric scene of one floor: floor chunks and the standing pieces (walls, furniture, chairs). */
export function renderIsoEnvironment(map: OfficeMap): IsoEnvironment {
  const s = sceneOf(map);
  const W = s.w * T; const H = s.h * T;
  const minX = -H * K; const maxX = W * K; const maxY = ((W + H) * K) / 2;
  const stamps = floorStamps();
  const chunks: IsoChunk[] = [];
  for (let y = 0; y < maxY; y += CHUNK) for (let x = minX; x < maxX; x += CHUNK) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(CHUNK, Math.ceil(maxX - x));
    canvas.height = Math.min(CHUNK, Math.ceil(maxY - y));
    const ctx = canvas.getContext('2d');
    if (ctx) { ctx.imageSmoothingEnabled = false; ctx.translate(-Math.floor(x), -y); paintFloor(new Painter(ctx), s, stamps, { x, y, w: canvas.width, h: canvas.height }); }
    chunks.push({ canvas, x: Math.floor(x), y });
  }
  const pieces: Array<AtlasPiece & { info: IsoPieceInfo }> = [];
  for (let ty = 0; ty < s.h; ty += 1) for (let tx = 0; tx < s.w; tx += 1) {
    if (!s.wall(tx, ty)) continue;
    const wt: WallTile = { tx, ty, z: wallHeight(s, tx, ty) };
    pieces.push({ ...extent(tx * T, ty * T, T, T, wt.z, 2), depth: (tx + ty + 1) * T, draw: (p) => drawWall(p, s, wt), info: { fade: wt.z >= MID, game: null } });
  }
  for (const f of s.furniture) {
    const kind = kindOf(f);
    const rise = RISE[kind] ?? 40;
    const game = prop(f, 'game', '') ? f.id : null;
    pieces.push({ ...extent(f.x, f.y, f.width, f.height, rise), depth: f.x + f.width / 2 + f.y + f.height / 2, draw: (p) => furnitureItem(p, s, f), info: { fade: false, game } });
  }
  for (const seat of s.seats.filter((x) => x.kind !== 'bench')) pieces.push({ ...extent(seat.x - 10, seat.y - 10, 20, 20, 34), depth: chairDepth(seat), draw: (p) => chair(p, seat), info: { fade: false, game: null } });
  const valid = pieces.filter((q) => q.width > 0 && q.height > 0);
  return { chunks, props: buildAtlas(valid), info: valid.map((q) => q.info) };
}
