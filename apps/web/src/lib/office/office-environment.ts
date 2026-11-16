'use client';

/**
 * The static office environment as original pixel art (FR-VO-001; ADR 054). Everything is drawn
 * in code with whole-pixel rectangles on a native 32 x 32 grid: no image asset, no gradient, no
 * blur. The scene is painted once per map into canvas chunks; the PixiJS renderer shows them as
 * nearest-neighbour sprites, so nothing here runs per frame.
 *
 * Purely visual. It reads the same map the collision grid reads (floor and wall tiles, rooms,
 * desks, furniture) and never changes it: tiles, walkability, doors, furniture footprints and
 * desk seats are exactly where the map puts them. Decorations (rugs, chairs, corner plants, wall
 * art, windows, light) are paint only; they are not objects and block nothing.
 *
 * Paint order: floors, door sills, wall shadows, light, rugs, walls, wall decor, neon signs, chairs,
 * furniture, corner plants. Variation is a hash of the tile position, so a map always looks the same.
 *
 * ADR 057: the arcade is dressed by the same rules. Its walnut floor, indigo walls, neon signs,
 * posters, rugs and cabinet glow are paint on the floor chunks; its cabinets stay props. Nothing
 * there is an object, so nothing collides and nothing is interactive that was not before.
 *
 * ADR 060: the rest of the office is dressed to the same level: teal carpet and panelling in the
 * open office with a rug under each workstation, marble and a compass medallion in reception,
 * slate meeting rooms, brick lounge, encaustic café floor with subway-tile walls, striped lawn,
 * border bands along every indoor wall, and room-specific wall art. Still paint only.
 *
 * ADR 055: tall things (trees, arcade cabinets, potted plants) are not painted into the floor
 * chunks but into one atlas of "props" that the renderer sorts with the avatars by their base, so
 * a person walking behind a tree is hidden by its canopy and one walking in front is not.
 */
import { mapSeats, objectLayer, prop, TILE_SIZE, tileLayer } from '@hrvo/shared';
import type { MapObject, OfficeMap, Seat } from '@hrvo/shared';
import {
  BLUE, BRICK, buildAtlas, CREAM, GLASS, GOLD, GOLD_LIGHT, GRASS, hash, INDIGO, INK, LEAF, LIGHT, MAPLE, MARBLE, NAVY, NEON, NIGHT, OAK, overlaps, Painter, pick, SAGE, SLATE, STONE, TEAL, TERRA,
  VIOLET, WALNUT, WATER,
} from './pixel-kit';
import type { AtlasPiece, AtlasSprite, Rect } from './pixel-kit';

const T = TILE_SIZE;
/** Chunk edge in px: well under every GPU's texture limit, also for the largest map (200 tiles). */
export const ENV_CHUNK = 1024;

/** Floor styles of the map (packages/shared default-map FLOOR). Anything else gets the fallback. */
const FLOOR = { CARPET: 1, WOOD: 2, MEETING: 3, PRIVATE: 4, RECEPTION: 5, GRASS: 6, CAFE: 7, ARCADE: 8, PATH: 9 } as const;

/** What the painter needs to know about a map, worked out once. */
interface Scene {
  map: OfficeMap;
  w: number;
  h: number;
  floor: number[];
  wall: (x: number, y: number) => boolean;
  /** A tile people can stand on as far as the art is concerned: inside the map, floor, no wall. */
  open: (x: number, y: number) => boolean;
  /** Tiles covered by furniture (whatever its collides flag): decorations stay off them. */
  taken: Set<number>;
  /** Doorway tiles: gaps of up to six tiles in a wall line. 'h' = in a horizontal wall. */
  doors: Map<number, 'h' | 'v'>;
  rooms: Array<Rect & { type: string; name: string }>;
  desks: MapObject[];
  furniture: MapObject[];
  /** ADR 056: the chairs people can sit on (mapSeats). */
  seats: Seat[];
  /** Things hung on wall faces, planned once: whiteboards, bookshelves, the reception plaque. */
  pieces: WallPiece[];
  /** Wall-face tiles those pieces use (no window or picture there). */
  faceUsed: Set<number>;
  /** ADR 057: neon signs on the wall above each row of arcade cabinets. */
  signs: NeonSign[];
  /** ADR 057: what hangs on each arcade wall-face tile (key: tile index). */
  arcadeArt: Map<number, ArcadeArt>;
}

interface NeonSign extends Rect { text: string; colour: number; accent: number }
type ArcadeArt = 'sconce' | 'rocket' | 'planet' | 'star' | 'bolt' | 'planter' | 'sunset';

interface WallPiece { kind: 'board' | 'shelf' | 'plaque'; x: number; y: number; width: number; seed: number }

const MAX_DOOR = 6;

function buildScene(map: OfficeMap): Scene {
  const w = map.width;
  const h = map.height;
  const floor = tileLayer(map, 'floor') ?? [];
  const walls = tileLayer(map, 'walls') ?? [];
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h;
  const wall = (x: number, y: number) => inside(x, y) && (walls[y * w + x] ?? 0) !== 0;
  const open = (x: number, y: number) => inside(x, y) && !wall(x, y) && (floor[y * w + x] ?? 0) !== 0;
  const furniture = objectLayer(map, 'furniture');
  const taken = new Set<number>();
  for (const f of furniture) {
    for (let ty = Math.floor(f.y / T); ty < Math.ceil((f.y + f.height) / T); ty += 1) for (let tx = Math.floor(f.x / T); tx < Math.ceil((f.x + f.width) / T); tx += 1) taken.add(ty * w + tx);
  }
  const doors = new Map<number, 'h' | 'v'>();
  const gap = (x: number, y: number, dx: number, dy: number): boolean => {
    let a = 1;
    while (a <= MAX_DOOR && open(x - dx * a, y - dy * a)) a += 1;
    let b = 1;
    while (b <= MAX_DOOR && open(x + dx * b, y + dy * b)) b += 1;
    return wall(x - dx * a, y - dy * a) && wall(x + dx * b, y + dy * b) && a + b - 1 <= MAX_DOOR;
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!open(x, y)) continue;
      if (open(x, y - 1) && open(x, y + 1) && gap(x, y, 1, 0)) doors.set(y * w + x, 'h');
      else if (open(x - 1, y) && open(x + 1, y) && gap(x, y, 0, 1)) doors.set(y * w + x, 'v');
    }
  }
  const rooms = objectLayer(map, 'rooms').map((o) => ({ x: o.x, y: o.y, width: o.width, height: o.height, name: o.name, type: String(prop(o, 'type', 'OPEN')).toUpperCase() }));
  const scene: Scene = { map, w, h, floor, wall, open, taken, doors, rooms, desks: objectLayer(map, 'desks'), furniture, seats: mapSeats(map), pieces: [], faceUsed: new Set(), signs: [], arcadeArt: new Map() };
  planWallPieces(scene);
  planArcadeWalls(scene);
  return scene;
}

/** A wall tile whose lower part shows its front face: the tile below it is floor. */
const hasFace = (s: Scene, x: number, y: number): boolean => s.wall(x, y) && s.open(x, y + 1);

// ---------------------------------------------------------------- floors

function woodPlanks(p: Painter, x0: number, y0: number, tones: readonly number[], seam: number, salt: number): void {
  // Four 8 px planks per tile; boards are 96 px long with joints staggered per row.
  for (let k = 0; k < 4; k += 1) {
    const y = y0 + k * 8;
    const row = y / 8;
    const off = (hash(row, salt, 7) % 6) * 16;
    let x = x0;
    while (x < x0 + T) {
      const board = Math.floor((x + off) / 96);
      const end = Math.min(x0 + T, (board + 1) * 96 - off);
      const tone = pick(tones, hash(board, row, salt));
      p.r(tone, x, y, end - x, 8);
      p.r(0xffffff, x, y, end - x, 1, 0.12); // top highlight
      p.r(seam, x, y + 7, end - x, 1); // seam between planks
      if ((x + off) % 96 === 0) p.r(seam, x, y, 1, 7); // board joint
      const g = hash(board, row, salt + 3);
      const gx = board * 96 - off + 8 + (g % 70);
      if (gx >= x && gx + 9 <= end) p.r(seam, gx, y + 3 + (g % 3), 9, 1, 0.35); // grain
      x = end;
    }
  }
}

function floorTile(p: Painter, s: Scene, tx: number, ty: number): void {
  const v = s.floor[ty * s.w + tx] ?? 0;
  if (v === 0) return;
  const x = tx * T;
  const y = ty * T;
  const alt = (tx + ty) % 2 === 0;
  const speckle = (n: number, light: number, dark: number, salt: number) => {
    for (let i = 0; i < n; i += 1) {
      const h = hash(tx * 37 + i, ty * 91 + i, salt);
      p.r(h & 1 ? light : dark, x + 1 + (h % 29), y + 1 + ((h >>> 8) % 29), 2, 1);
    }
  };
  switch (v) {
    case FLOOR.CARPET: { // ADR 060: modular teal carpet tiles laid quarter-turn, a fine ribbed weave
      p.r(pick([TEAL.base, TEAL.base, TEAL.mid], hash(tx, ty, 1)), x, y, T, T);
      const across = (tx + ty) % 2 === 0;
      for (let i = 2; i < T - 1; i += 4) { if (across) p.r(TEAL.line, x + 1, y + i, T - 2, 1, 0.75); else p.r(TEAL.line, x + i, y + 1, 1, T - 2, 0.75); }
      speckle(6, TEAL.light, TEAL.dark, 1);
      p.r(TEAL.light, x, y, T - 1, 1, 0.8); p.r(TEAL.light, x, y, 1, T - 1, 0.8);
      p.r(TEAL.dark, x + T - 1, y, 1, T, 0.7); p.r(TEAL.dark, x, y + T - 1, T, 1, 0.7);
      break;
    }
    case FLOOR.WOOD: // oak boards
      woodPlanks(p, x, y, [OAK.light, OAK.base, OAK.base, OAK.mid], OAK.dark, 2);
      break;
    case FLOOR.MEETING: // cool carpet tiles with a small woven motif (ADR 060: a shade deeper, slate motif)
      p.r(alt ? 0xc6d1df : 0xbdc9d9, x, y, T, T);
      speckle(8, BLUE.light, BLUE.line, 3);
      for (let k = -3; k <= 3; k += 1) p.r(SLATE.light, x + 16 - (3 - Math.abs(k)), y + 16 + k, (3 - Math.abs(k)) * 2 + 1, 1);
      p.r(SLATE.dark, x + 16, y + 16, 1, 1);
      p.r(BLUE.line, x + T - 1, y, 1, T); p.r(BLUE.line, x, y + T - 1, T, 1);
      p.r(BLUE.light, x, y, T - 1, 1, 0.7);
      break;
    case FLOOR.PRIVATE: // maple basket-weave parquet: 16 px blocks, alternating direction
      for (let j = 0; j < 2; j += 1) for (let i = 0; i < 2; i += 1) {
        const bx = x + i * 16;
        const by = y + j * 16;
        const across = (tx * 2 + i + ty * 2 + j) % 2 === 0;
        for (let k = 0; k < 2; k += 1) {
          const tone = pick([MAPLE.light, MAPLE.base, MAPLE.base, MAPLE.mid], hash(tx * 2 + i, ty * 2 + j, k + 11));
          if (across) { p.r(tone, bx, by + k * 8, 16, 8); p.r(MAPLE.line, bx, by + k * 8 + 7, 16, 1); }
          else { p.r(tone, bx + k * 8, by, 8, 16); p.r(MAPLE.line, bx + k * 8 + 7, by, 1, 16); }
        }
        p.r(MAPLE.line, bx + 15, by, 1, 16); p.r(MAPLE.line, bx, by + 15, 16, 1);
        p.r(0xffffff, bx, by, 15, 1, 0.18);
      }
      break;
    case FLOOR.RECEPTION: { // ADR 060: polished marble slabs (2 x 2 tiles), veined, gold studs at the corners
      const sx = tx >> 1;
      const sy = ty >> 1;
      const ox = (tx & 1) * T;
      const oy = (ty & 1) * T;
      p.r((sx + sy) % 2 === 0 ? MARBLE.base : MARBLE.grey, x, y, T, T);
      for (let vein = 0; vein < 2; vein += 1) {
        const h = hash(sx, sy, 6 + vein);
        const start = h % 56;
        const slope = vein ? -0.45 : 0.6;
        for (let k = 0; k < 64; k += 1) {
          const vy = Math.round(start + (k - 32) * slope + Math.sin((k + (h >>> 8)) / 5) * 2);
          const lx = k - ox;
          const ly = vy - oy;
          if (lx >= 0 && lx < T && ly >= 0 && ly < T) p.r(vein ? MARBLE.vein : MARBLE.dark, x + lx, y + ly, 1, 1, vein ? 0.55 : 0.4);
        }
      }
      p.r(MARBLE.light, x, y, T, 1, (ty & 1) ? 0 : 0.9); p.r(MARBLE.light, x, y, 1, T, (tx & 1) ? 0 : 0.9);
      if (tx & 1) p.r(MARBLE.vein, x + T - 1, y, 1, T);
      if (ty & 1) p.r(MARBLE.vein, x, y + T - 1, T, 1);
      if (!(tx & 1) && !(ty & 1)) { p.r(GOLD, x, y, 2, 2); p.r(GOLD_LIGHT, x, y, 1, 1); }
      break;
    }
    case FLOOR.GRASS: { // lawn with tufts and the odd flower (ADR 060: mown in two-tile stripes)
      p.r(Math.floor(tx / 2) % 2 ? pick([GRASS.base, GRASS.base, GRASS.light], hash(tx, ty, 61)) : pick([GRASS.mid, GRASS.mid, GRASS.base], hash(tx, ty, 61)), x, y, T, T);
      for (let i = 0; i < 7; i += 1) {
        const h = hash(tx * 13 + i, ty * 7 + i, 62);
        const gx = x + 2 + (h % 27);
        const gy = y + 3 + ((h >>> 7) % 26);
        p.r(GRASS.dark, gx, gy, 1, 2); p.r(GRASS.dark, gx + 2, gy - 1, 1, 3); p.r(GRASS.light, gx + 1, gy + 1, 1, 1);
      }
      const f = hash(tx, ty, 63);
      if (f % 9 === 0) { const fx = x + 6 + (f % 18); const fy = y + 6 + ((f >>> 5) % 18); p.r(pick([0xf6f1e4, GOLD_LIGHT, TERRA.light], f >>> 9), fx, fy, 2, 2); p.r(GOLD, fx + 1, fy + 1, 1, 1); }
      break;
    }
    case FLOOR.PATH: { // flagstones
      p.r(STONE.line, x, y, T, T);
      const stones = [[1, 1, 14, 9], [16, 1, 15, 13], [1, 11, 9, 11], [11, 11, 4, 11], [16, 15, 15, 8], [1, 23, 13, 8], [15, 24, 16, 7]] as const;
      stones.forEach(([sx, sy, sw, sh], i) => {
        const tone = pick([STONE.base, STONE.mid, STONE.light, STONE.base], hash(tx * 7 + i, ty, 64));
        p.r(tone, x + sx, y + sy, sw, sh); p.r(STONE.light, x + sx, y + sy, sw, 1, 0.7); p.r(STONE.dark, x + sx, y + sy + sh - 1, sw, 1, 0.6);
      });
      break;
    }
    case FLOOR.CAFE: { // ADR 060: encaustic cement tiles: cream, terracotta quarter rings that meet as circles, a teal star
      p.r(pick([CREAM.base, CREAM.base, 0xf1e6d0], hash(tx, ty, 65)), x, y, T, T);
      for (const [cx, cy, dx, dy] of [[0, 0, 1, 1], [T, 0, -1, 1], [0, T, 1, -1], [T, T, -1, -1]] as const) {
        for (let k = 0; k < 8; k += 1) { // a soft quarter disc of radius 8 with a cream ring
          const outer = Math.round(Math.sqrt(64 - k * k));
          const inner = k < 5 ? Math.round(Math.sqrt(25 - k * k)) : 0;
          const ry = dy > 0 ? y + cy + k : y + cy - 1 - k;
          const span = (from: number, to: number, c: number) => { if (to > from) p.r(c, dx > 0 ? x + cx + from : x + cx - to, ry, to - from, 1); };
          span(0, outer, TERRA.light);
          span(Math.max(0, inner - 1), inner, CREAM.light);
          if (k < 3) span(0, Math.round(Math.sqrt(9 - k * k)), TERRA.base);
        }
      }
      if ((tx + ty) % 2 === 0) { // a small teal star on every other tile
        for (let k = -3; k <= 3; k += 1) p.r(TEAL.dark, x + 16 - (3 - Math.abs(k)), y + 16 + k, (3 - Math.abs(k)) * 2 + 1, 1);
        p.r(GOLD_LIGHT, x + 16, y + 16, 1, 1);
      }
      p.r(CREAM.dark, x + T - 1, y, 1, T, 0.8); p.r(CREAM.dark, x, y + T - 1, T, 1, 0.8);
      break;
    }
    case FLOOR.ARCADE: { // ADR 057: walnut boards, a small inlay every third tile, a dark border along the walls
      woodPlanks(p, x, y, [WALNUT.light, WALNUT.base, WALNUT.base, WALNUT.mid], WALNUT.dark, 8);
      if (tx % 3 === 1 && ty % 3 === 1) {
        for (let k = -4; k <= 4; k += 1) p.r(WALNUT.deep, x + 16 - (4 - Math.abs(k)), y + 16 + k, (4 - Math.abs(k)) * 2 + 1, 1);
        for (let k = -2; k <= 2; k += 1) p.r(WALNUT.light, x + 16 - (2 - Math.abs(k)), y + 16 + k, (2 - Math.abs(k)) * 2 + 1, 1);
        p.r(GOLD, x + 16, y + 16, 1, 1);
      }
      if (s.wall(tx - 1, ty)) { p.r(WALNUT.deep, x + 5, y, 3, T); p.r(GOLD, x + 9, y, 1, T, 0.5); }
      if (s.wall(tx + 1, ty)) { p.r(WALNUT.deep, x + T - 8, y, 3, T); p.r(GOLD, x + T - 10, y, 1, T, 0.5); }
      if (s.wall(tx, ty - 1)) { p.r(WALNUT.deep, x, y + 5, T, 3); p.r(GOLD, x, y + 9, T, 1, 0.5); }
      if (s.wall(tx, ty + 1)) { p.r(WALNUT.deep, x, y + T - 8, T, 3); p.r(GOLD, x, y + T - 10, T, 1, 0.5); }
      break;
    }
    default: // unknown style: a neutral stone tile
      p.r(alt ? 0xe6e2da : 0xe0dcd3, x, y, T, T);
      p.r(0xcfcabf, x + T - 1, y, 1, T); p.r(0xcfcabf, x, y + T - 1, T, 1);
  }
  floorBand(p, s, tx, ty, v);
}

/** ADR 060: the border band each indoor floor has along its walls (the arcade has its own). */
const BANDS: Partial<Record<number, { deep: number; line: number }>> = {
  [FLOOR.CARPET]: { deep: TEAL.deep, line: TEAL.light },
  [FLOOR.MEETING]: { deep: SLATE.base, line: BLUE.light },
  [FLOOR.PRIVATE]: { deep: OAK.dark, line: MAPLE.light },
  [FLOOR.RECEPTION]: { deep: NAVY.base, line: GOLD },
  [FLOOR.WOOD]: { deep: OAK.deep, line: GOLD },
  [FLOOR.CAFE]: { deep: TERRA.dark, line: TEAL.deep },
};

/** A dark band and a fine line a few pixels in from every wall; it stops at doorways by itself. */
function floorBand(p: Painter, s: Scene, tx: number, ty: number, v: number): void {
  const c = BANDS[v];
  if (!c || s.doors.has(ty * s.w + tx)) return;
  const x = tx * T;
  const y = ty * T;
  if (s.wall(tx - 1, ty)) { p.r(c.deep, x + 4, y, 3, T, 0.85); p.r(c.line, x + 9, y, 1, T, 0.7); }
  if (s.wall(tx + 1, ty)) { p.r(c.deep, x + T - 7, y, 3, T, 0.85); p.r(c.line, x + T - 10, y, 1, T, 0.7); }
  if (s.wall(tx, ty - 1)) { p.r(c.deep, x, y + 4, T, 3, 0.85); p.r(c.line, x, y + 9, T, 1, 0.7); }
  if (s.wall(tx, ty + 1)) { p.r(c.deep, x, y + T - 7, T, 3, 0.85); p.r(c.line, x, y + T - 10, T, 1, 0.7); }
}

/** A doorway keeps its floor and gets an oak sill across the wall's thickness. It stays open. */
function doorSill(p: Painter, tx: number, ty: number, dir: 'h' | 'v'): void {
  const x = tx * T;
  const y = ty * T;
  p.r(OAK.mid, x, y, T, T);
  if (dir === 'h') {
    for (let k = 0; k < 4; k += 1) { p.r(k % 2 ? OAK.base : OAK.mid, x, y + 2 + k * 7, T, 7); p.r(OAK.dark, x, y + 8 + k * 7, T, 1); }
    p.r(OAK.deep, x, y, T, 2); p.r(OAK.deep, x, y + T - 2, T, 2);
    p.r(GOLD, x, y + 2, T, 1, 0.7); p.r(GOLD, x, y + T - 3, T, 1, 0.7);
  } else {
    for (let k = 0; k < 4; k += 1) { p.r(k % 2 ? OAK.base : OAK.mid, x + 2 + k * 7, y, 7, T); p.r(OAK.dark, x + 8 + k * 7, y, 1, T); }
    p.r(OAK.deep, x, y, 2, T); p.r(OAK.deep, x + T - 2, y, 2, T);
    p.r(GOLD, x + 2, y, 1, T, 0.7); p.r(GOLD, x + T - 3, y, 1, T, 0.7);
  }
}

// ---------------------------------------------------------------- walls

const CAP = 13; // px of a faced wall tile that is the wall's top; the rest is its front face

function wallTile(p: Painter, s: Scene, tx: number, ty: number): void {
  const x = tx * T;
  const y = ty * T;
  const face = hasFace(s, tx, ty);
  const capH = face ? CAP : T;
  const n = s.wall(tx, ty - 1);
  const e = s.wall(tx + 1, ty);
  const so = s.wall(tx, ty + 1);
  const we = s.wall(tx - 1, ty);
  // Top of the wall: deep navy, lit from the top-left, dark outer edges.
  p.r(NAVY.mid, x, y, T, capH);
  // The flat top sits inside a slightly darker rim on every side that is not more wall.
  const il = we ? 0 : 3;
  const it = n ? 0 : 3;
  p.r(NAVY.base, x + il, y + it, T - il - (e ? 0 : 4), capH - it - (face || !so ? 4 : 0));
  if (!n) { p.r(NAVY.light, x, y, T, 2); p.r(0x6076a0, x, y, T, 1); }
  if (!we) p.r(NAVY.light, x, y, 1, capH, 0.8);
  if (!e) p.r(NAVY.deep, x + T - 2, y, 2, capH);
  if (face) p.r(NAVY.deep, x, y + CAP - 2, T, 2);
  else if (!so) p.r(NAVY.deep, x, y + T - 2, T, 2);
  if ((tx + ty) % 2 === 0) p.r(NAVY.mid, x + 6, y + (n ? 6 : 7), 20, 1, 0.8); // coping joint
  if (face) {
    // Front face: warm ivory panelling over an oak skirting board; deep indigo in the arcade (ADR 057).
    const fy = y + CAP;
    const below = s.floor[(ty + 1) * s.w + tx] ?? 0;
    const arcade = below === FLOOR.ARCADE;
    const c = faceStyle(below);
    p.r(c.mid, x, fy, T, T - CAP - 4);
    wallSurface(p, c.pattern, c, tx, ty, x, fy);
    p.r(c.line, x, fy, T, 2); // shade under the coping
    p.r(c.base, x, fy + 2, T, 1, c.pattern === 'panel' ? 1 : 0.5);
    p.r(c.skirt, x, y + T - 4, T, 4);
    p.r(c.skirtTop, x, y + T - 4, T, 1);
    p.r(c.skirtLine, x, y + T - 1, T, 1);
    if (!we) p.r(c.line, x, fy, 1, T - CAP - 4);
    if (!e) p.r(c.line, x + T - 1, fy, 1, T - CAP - 4);
    if (arcade) { const tube = Math.floor(tx / 2) % 2 ? NEON.cyan : NEON.pink; p.r(tube, x, fy, T, 2); p.r(NEON.white, x + 1, fy, T - 2, 1, 0.45); p.r(tube, x, fy + 2, T, 2, 0.22); p.r(NIGHT, x, fy, 1, 2); }
    if ((s.floor[(ty + 1) * s.w + tx] ?? 0) === FLOOR.GRASS) ivy(p, tx, ty);
  }
  arcadeTrim(p, s, tx, ty);
  // Door frames: an oak jamb on the wall end beside a doorway (the opening itself is untouched).
  const door = (dx: number, dy: number) => s.doors.has((ty + dy) * s.w + tx + dx);
  if (door(-1, 0)) { p.r(OAK.deep, x, y, 3, T); p.r(OAK.light, x + 2, y, 1, T); p.r(OAK.line, x, y, 1, T); }
  if (door(1, 0)) { p.r(OAK.deep, x + T - 3, y, 3, T); p.r(OAK.light, x + T - 3, y, 1, T); p.r(OAK.line, x + T - 1, y, 1, T); }
  if (door(0, -1)) { p.r(OAK.deep, x, y, T, 3); p.r(OAK.light, x, y + 2, T, 1); p.r(OAK.line, x, y, T, 1); }
  if (door(0, 1)) { p.r(OAK.deep, x, y + T - 3, T, 3); p.r(OAK.light, x, y + T - 3, T, 1); p.r(OAK.line, x, y + T - 1, T, 1); }
}

type Surface = 'panel' | 'boards' | 'brick' | 'subway' | 'stone';
interface FaceStyle { mid: number; line: number; base: number; dark: number; skirt: number; skirtTop: number; skirtLine: number; pattern: Surface }

/**
 * ADR 060: each room's walls by the floor in front of them (ADR 057 did this for the arcade):
 * teal panelling in the open office, slate in meeting rooms, wood boards in private rooms, navy
 * with a gold rail in reception, brick in the lounge, cream subway tile in the café, stone in the
 * garden. Anything else keeps the ivory panelling of ADR 054.
 */
function faceStyle(below: number): FaceStyle {
  const oak = { skirt: OAK.deep, skirtTop: OAK.mid, skirtLine: OAK.line };
  switch (below) {
    case FLOOR.ARCADE: return { mid: INDIGO.mid, line: INDIGO.deep, base: INDIGO.base, dark: INDIGO.dark, skirt: INDIGO.deep, skirtTop: INDIGO.light, skirtLine: NIGHT, pattern: 'panel' };
    case FLOOR.CARPET: return { mid: TEAL.dark, line: TEAL.ink, base: TEAL.line, dark: TEAL.deep, ...oak, pattern: 'panel' };
    case FLOOR.MEETING: return { mid: SLATE.light, line: SLATE.deep, base: 0xb4c0d6, dark: SLATE.base, skirt: NAVY.mid, skirtTop: NAVY.light, skirtLine: NAVY.deep, pattern: 'panel' };
    case FLOOR.PRIVATE: return { mid: OAK.base, line: OAK.line, base: OAK.light, dark: OAK.dark, skirt: OAK.line, skirtTop: OAK.deep, skirtLine: OAK.line, pattern: 'boards' };
    case FLOOR.RECEPTION: return { mid: NAVY.light, line: NAVY.deep, base: 0x5c6f95, dark: NAVY.base, skirt: NAVY.deep, skirtTop: GOLD, skirtLine: NAVY.deep, pattern: 'panel' };
    case FLOOR.WOOD: return { mid: BRICK.base, line: BRICK.dark, base: BRICK.light, dark: BRICK.dark, ...oak, pattern: 'brick' };
    case FLOOR.CAFE: return { mid: CREAM.light, line: CREAM.line, base: CREAM.light, dark: CREAM.dark, skirt: TERRA.dark, skirtTop: TERRA.base, skirtLine: TERRA.deep, pattern: 'subway' };
    case FLOOR.GRASS: return { mid: STONE.mid, line: STONE.line, base: STONE.light, dark: STONE.dark, skirt: STONE.line, skirtTop: STONE.dark, skirtLine: 0x7d715c, pattern: 'stone' };
    default: return { mid: CREAM.mid, line: CREAM.line, base: CREAM.base, dark: CREAM.dark, ...oak, pattern: 'panel' };
  }
}

/** The texture of a wall's front face (15 px between the coping and the skirting board). */
function wallSurface(p: Painter, kind: Surface, c: FaceStyle, tx: number, ty: number, x: number, fy: number): void {
  const fh = T - CAP - 4;
  if (kind === 'panel') {
    p.r(c.dark, x + 15, fy + 3, 1, fh - 3); // panel seam
    p.r(c.dark, x, fy + 11, T, 1, 0.55); // dado line
    p.r(c.base, x + 2, fy + 4, 11, 1, 0.5); p.r(c.base, x + 18, fy + 4, 11, 1, 0.5); // raised panel tops
    return;
  }
  if (kind === 'boards') { // vertical tongue-and-groove boards
    for (let i = 0; i < T; i += 6) { p.r(pick([OAK.base, OAK.mid, OAK.light], hash(tx * 6 + i, ty, 81)), x + i, fy, 6, fh); p.r(c.dark, x + i + 5, fy, 1, fh); }
    p.r(OAK.deep, x, fy + 10, T, 1, 0.6);
    return;
  }
  if (kind === 'brick' || kind === 'subway') {
    const brick = kind === 'brick';
    const bw = brick ? 12 : 10;
    for (let row = 0; row * 4 < fh; row += 1) {
      const off = row % 2 ? Math.floor(bw / 2) : 0;
      for (let bx = -off; bx < T; bx += bw) {
        const tone = brick ? pick([BRICK.base, BRICK.mid, BRICK.light, BRICK.base, BRICK.dark], hash(tx * 8 + Math.floor((bx + off) / bw), ty * 5 + row, 82)) : pick([CREAM.light, 0xfdfaf2, CREAM.base], hash(tx * 8 + bx, row, 83));
        const left = Math.max(0, bx);
        const right = Math.min(T, bx + bw - 1);
        p.r(tone, x + left, fy + row * 4, right - left, 3);
        if (!brick) p.r(0xffffff, x + left, fy + row * 4, right - left, 1, 0.5);
      }
      p.r(brick ? BRICK.mortar : CREAM.dark, x, fy + row * 4 + 3, T, 1, brick ? 0.75 : 0.9);
    }
    return;
  }
  // stone: irregular dressed blocks
  for (let row = 0; row * 5 < fh; row += 1) {
    let bx = -(hash(tx, ty + row, 84) % 8);
    while (bx < T) {
      const bw = 7 + (hash(tx * 9 + bx, row, 85) % 8);
      const left = Math.max(0, bx);
      const right = Math.min(T, bx + bw - 1);
      p.r(pick([STONE.base, STONE.mid, STONE.light, STONE.dark], hash(tx * 9 + bx, ty * 3 + row, 86)), x + left, fy + row * 5, right - left, 4);
      p.r(STONE.light, x + left, fy + row * 5, right - left, 1, 0.6);
      bx += bw;
    }
    p.r(STONE.line, x, fy + row * 5 + 4, T, 1, 0.8);
  }
}

/** Garden walls: ivy climbing the face from the skirting board. */
function ivy(p: Painter, tx: number, ty: number): void {
  const x = tx * T;
  const fy = ty * T + CAP;
  for (let i = 0; i < 9; i += 1) {
    const h = hash(tx * 9 + i, ty, 71);
    const lx = x + (h % 30);
    const top = fy + 2 + ((h >>> 5) % 10);
    p.r(LEAF.deep, lx, top, 1, T - CAP - 4 - (top - fy));
    p.r(h & 1 ? LEAF.base : LEAF.dark, lx - 1, top, 3, 2);
    p.r(LEAF.light, lx, top, 1, 1);
    if (h % 3 === 0) p.r(LEAF.dark, lx + 1, top + 4, 2, 2);
  }
}

/** Soft, stepped shadows the walls cast onto the floor below and to their right. */
function wallShadow(p: Painter, s: Scene, tx: number, ty: number): void {
  if (!s.open(tx, ty)) return;
  const x = tx * T;
  const y = ty * T;
  if (s.wall(tx, ty - 1)) { p.r(INK, x, y, T, 3, 0.13); p.r(INK, x, y + 3, T, 3, 0.06); }
  if (s.wall(tx - 1, ty)) { p.r(INK, x, y, 3, T, 0.09); p.r(INK, x + 3, y, 2, T, 0.04); }
}

// ---------------------------------------------------------------- wall decor (paint on wall faces)

/** A run of free wall-face tiles; reserves it when found. */
function takeFace(s: Scene, tx: number, ty: number, n: number): boolean {
  for (let i = 0; i < n; i += 1) if (!hasFace(s, tx + i, ty) || s.faceUsed.has(ty * s.w + tx + i)) return false;
  for (let i = 0; i < n; i += 1) s.faceUsed.add(ty * s.w + tx + i);
  return true;
}

/** Meeting rooms get a whiteboard on the wall above them, private rooms a bookshelf, a counter a plaque. */
function planWallPieces(s: Scene): void {
  for (const room of s.rooms) {
    const ty = Math.round(room.y / T) - 1;
    const mid = Math.floor((room.x + room.width / 2) / T);
    if (room.type === 'MEETING' && takeFace(s, mid - 1, ty, 3)) s.pieces.push({ kind: 'board', x: (mid - 1) * T + 4, y: ty * T + CAP + 2, width: 88, seed: room.x });
    else if (room.type === 'PRIVATE' && takeFace(s, mid - 1, ty, 2)) s.pieces.push({ kind: 'shelf', x: (mid - 1) * T + 5, y: ty * T + CAP + 1, width: 54, seed: room.x + room.y });
  }
  for (const f of s.furniture) {
    if (kindOf(f) !== 'counter') continue;
    const tx = Math.floor(f.x / T) + 1;
    for (let up = 1; up <= 3; up += 1) {
      const ty = Math.floor(f.y / T) - up;
      if (!takeFace(s, tx, ty, 2)) continue;
      s.pieces.push({ kind: 'plaque', x: tx * T + 8, y: ty * T + CAP + 2, width: 48, seed: 0 });
      break;
    }
  }
}

function wallPiece(p: Painter, piece: WallPiece): void {
  const { x, y } = piece;
  if (piece.kind === 'board') {
    p.r(0x8d97a6, x, y, 88, 12); p.r(0xfbfbf8, x + 2, y + 1, 84, 9);
    p.r(NAVY.base, x + 8, y + 3, 22, 1); p.r(NAVY.base, x + 8, y + 6, 15, 1);
    p.r(TERRA.base, x + 40, y + 3, 1, 6); p.r(TERRA.base, x + 40, y + 8, 14, 1); p.r(TERRA.base, x + 43, y + 6, 3, 2); p.r(TERRA.base, x + 48, y + 4, 3, 4);
    p.r(LEAF.base, x + 62, y + 3, 16, 1); p.r(LEAF.base, x + 62, y + 5, 10, 1); p.r(LEAF.base, x + 62, y + 7, 13, 1);
    p.r(0x6b7482, x + 20, y + 11, 48, 2); p.r(TERRA.base, x + 30, y + 11, 4, 1); p.r(NAVY.base, x + 37, y + 11, 4, 1);
  } else if (piece.kind === 'shelf') {
    p.r(OAK.deep, x, y, 54, 14); p.r(OAK.dark, x + 1, y + 1, 52, 5); p.r(OAK.dark, x + 1, y + 8, 52, 5);
    p.r(OAK.mid, x, y + 6, 54, 1);
    const spines = [NAVY.base, TERRA.base, CREAM.base, SAGE.deep, GOLD, NAVY.light, TERRA.dark, LEAF.dark];
    for (let row = 0; row < 2; row += 1) {
      let bx = x + 2;
      for (let i = 0; bx < x + 50; i += 1) {
        const h = hash(bx, row, piece.seed);
        const bw = 2 + (h % 2);
        const short = h % 3 === 0 ? 1 : 0;
        if (h % 7 !== 0) p.r(pick(spines, h >>> 4), bx, y + 1 + row * 7 + short, bw, 5 - short);
        bx += bw + (i % 5 === 4 ? 2 : 0);
      }
    }
  } else {
    p.r(GOLD, x, y, 48, 12); p.r(NAVY.base, x + 1, y + 1, 46, 10);
    p.r(GOLD, x + 5, y + 3, 6, 6); p.r(NAVY.base, x + 7, y + 5, 2, 2);
    p.r(CREAM.base, x + 15, y + 3, 26, 2); p.r(CREAM.dark, x + 15, y + 7, 18, 1);
  }
}

/** A free wall face that is not a wall end or a door jamb. */
const plainFace = (s: Scene, tx: number, ty: number): boolean => hasFace(s, tx, ty) && !s.faceUsed.has(ty * s.w + tx) && s.wall(tx - 1, ty) && s.wall(tx + 1, ty);
/** Outer walls (nothing but the outside above them) get a window on every third tile. */
const isWindow = (s: Scene, tx: number, ty: number): boolean => tx % 3 === 1 && plainFace(s, tx, ty) && !s.open(tx, ty - 1) && !s.wall(tx, ty - 1) && (s.floor[(ty + 1) * s.w + tx] ?? 0) !== FLOOR.GRASS;
/** A warm lantern on a garden wall, every fourth tile. */
const isLantern = (s: Scene, tx: number, ty: number): boolean => tx % 4 === 2 && plainFace(s, tx, ty) && (s.floor[(ty + 1) * s.w + tx] ?? 0) === FLOOR.GRASS;

function wallDecor(p: Painter, s: Scene, tx: number, ty: number): void {
  const art = s.arcadeArt.get(ty * s.w + tx);
  if (art) { arcadeWallArt(p, art, tx, ty); return; }
  if (!plainFace(s, tx, ty) || (s.floor[(ty + 1) * s.w + tx] ?? 0) === FLOOR.ARCADE) return;
  const x = tx * T;
  const fy = ty * T + CAP;
  if ((s.floor[(ty + 1) * s.w + tx] ?? 0) === FLOOR.GRASS) {
    if (!isLantern(s, tx, ty)) return;
    p.r(NAVY.deep, x + 13, fy + 1, 6, 2); p.r(NAVY.deep, x + 12, fy + 3, 8, 9); p.r(GOLD_LIGHT, x + 13, fy + 4, 6, 7); p.r(0xfff3c4, x + 15, fy + 5, 2, 4);
    p.r(NAVY.deep, x + 12, fy + 12, 8, 1);
    return;
  }
  if (!s.open(tx, ty - 1) && !s.wall(tx, ty - 1)) {
    if (!isWindow(s, tx, ty)) return;
    p.r(OAK.deep, x + 5, fy + 1, 22, 13); p.r(OAK.mid, x + 5, fy + 1, 22, 1);
    p.r(GLASS.base, x + 7, fy + 3, 18, 9); p.r(GLASS.dark, x + 7, fy + 10, 18, 2);
    p.r(GLASS.light, x + 9, fy + 4, 2, 5); p.r(GLASS.light, x + 12, fy + 4, 1, 3); p.r(GLASS.light, x + 19, fy + 5, 2, 4);
    p.r(OAK.deep, x + 15, fy + 3, 2, 9);
    p.r(CREAM.light, x + 4, fy + 14, 24, 1);
    return;
  }
  // ADR 060: inner walls carry something every third tile, from a set that suits the room.
  const kind = roomArt(s, tx, ty);
  if (kind) wallArt(p, kind, x, fy);
}

type RoomArt = 'clock' | 'hills' | 'abstract' | 'cork' | 'chart' | 'screen' | 'diploma' | 'record' | 'sconce' | 'menu' | 'mugs' | 'cup' | 'shelf' | 'photo';
const ROOM_ART: Partial<Record<number, readonly RoomArt[]>> = {
  [FLOOR.CARPET]: ['cork', 'clock', 'chart', 'hills', 'shelf', 'abstract'],
  [FLOOR.MEETING]: ['screen', 'abstract', 'clock', 'hills'],
  [FLOOR.PRIVATE]: ['diploma', 'shelf', 'clock', 'hills'],
  [FLOOR.RECEPTION]: ['sconce', 'photo', 'sconce', 'hills'],
  [FLOOR.WOOD]: ['record', 'sconce', 'abstract', 'shelf', 'record', 'sconce'],
  [FLOOR.CAFE]: ['menu', 'sconce', 'mugs', 'cup', 'sconce'],
};
const DEFAULT_ART: readonly RoomArt[] = ['hills', 'abstract', 'clock'];

/** What hangs on an inner wall-face tile, if anything: every third tile along a wall line. */
function roomArt(s: Scene, tx: number, ty: number): RoomArt | null {
  if ((tx + ty) % 3 !== 0) return null;
  const set = ROOM_ART[s.floor[(ty + 1) * s.w + tx] ?? 0] ?? DEFAULT_ART;
  return pick(set, hash(tx, ty, 21));
}

/** One piece of wall art inside a single wall-face tile (32 x 15 px from `fy`). */
function wallArt(p: Painter, kind: RoomArt, x: number, fy: number): void {
  const frame = (fx: number, fw: number, fh: number, edge: number, field: number) => { p.r(INK, fx + 1, fy + 2 + fh, fw - 1, 1, 0.25); p.r(edge, fx, fy + 2, fw, fh); p.r(field, fx + 1, fy + 3, fw - 2, fh - 2); };
  switch (kind) {
    case 'clock':
      p.ellipse(INK, x + 17, fy + 9, 6, 6, 0.2); p.ellipse(OAK.deep, x + 16, fy + 8, 6, 6); p.ellipse(CREAM.light, x + 16, fy + 8, 4, 4);
      p.r(NAVY.deep, x + 16, fy + 5, 1, 4); p.r(NAVY.deep, x + 16, fy + 8, 3, 1); p.r(TERRA.base, x + 16, fy + 8, 1, 1);
      return;
    case 'hills':
      frame(x + 8, 16, 12, GOLD, CREAM.light);
      p.r(0xf2c79a, x + 9, fy + 3, 14, 4); p.r(TERRA.light, x + 17, fy + 4, 3, 2);
      p.r(SAGE.deep, x + 9, fy + 7, 14, 6); p.r(LEAF.dark, x + 9, fy + 9, 5, 4); p.r(LEAF.base, x + 15, fy + 10, 8, 3);
      return;
    case 'abstract':
      frame(x + 8, 16, 12, OAK.deep, CREAM.light);
      p.r(NAVY.base, x + 10, fy + 4, 5, 8); p.r(TERRA.base, x + 16, fy + 4, 6, 4); p.r(TEAL.dark, x + 16, fy + 9, 6, 3); p.r(GOLD, x + 12, fy + 6, 2, 2);
      return;
    case 'cork': // corkboard with notes and pins
      frame(x + 4, 24, 12, OAK.deep, 0xc89b6a);
      for (let i = 0; i < 9; i += 1) p.r(0xb4865a, x + 6 + ((i * 7) % 20), fy + 4 + ((i * 5) % 8), 1, 1);
      p.r(GOLD_LIGHT, x + 6, fy + 4, 5, 5); p.r(0xf6a5b5, x + 13, fy + 5, 5, 5); p.r(0x9fd3f0, x + 20, fy + 4, 5, 5); p.r(GOLD_LIGHT, x + 15, fy + 9, 6, 3);
      p.r(TERRA.dark, x + 8, fy + 4, 1, 1); p.r(NAVY.base, x + 15, fy + 5, 1, 1); p.r(LEAF.dark, x + 22, fy + 4, 1, 1);
      p.r(NAVY.light, x + 7, fy + 6, 3, 1, 0.6); p.r(NAVY.light, x + 14, fy + 7, 3, 1, 0.6);
      return;
    case 'chart': // framed bar chart
      frame(x + 7, 18, 12, NAVY.deep, 0xfbfbf8);
      for (const [i, hgt, c] of [[0, 4, TEAL.deep], [1, 6, TEAL.dark], [2, 5, TERRA.base], [3, 8, GOLD]] as const) p.r(c, x + 9 + i * 4, fy + 12 - hgt, 3, hgt);
      p.r(NAVY.light, x + 8, fy + 12, 16, 1);
      return;
    case 'screen': // a wall-mounted display with a dashboard
      p.r(INK, x + 4, fy + 14, 25, 1, 0.25); p.r(NIGHT, x + 3, fy + 1, 26, 13); p.r(0x1f3b63, x + 4, fy + 2, 24, 11);
      p.r(0x4f8fd0, x + 5, fy + 3, 9, 4); p.r(0x7ad1b8, x + 15, fy + 3, 12, 1); p.r(0x7ad1b8, x + 15, fy + 5, 8, 1);
      for (const [i, hgt] of [[0, 3], [1, 5], [2, 4], [3, 6], [4, 5]] as const) p.r(i === 3 ? GOLD : 0x8fc7e8, x + 6 + i * 4, fy + 12 - hgt, 3, hgt);
      p.r(0xffffff, x + 4, fy + 2, 6, 1, 0.25);
      return;
    case 'diploma':
      frame(x + 8, 16, 12, GOLD, MARBLE.light);
      p.r(NAVY.base, x + 11, fy + 4, 10, 1); p.r(SLATE.light, x + 10, fy + 6, 12, 1); p.r(SLATE.light, x + 10, fy + 8, 9, 1);
      p.r(TERRA.base, x + 19, fy + 9, 3, 3); p.r(GOLD_LIGHT, x + 20, fy + 10, 1, 1);
      return;
    case 'record': // a framed vinyl record
      frame(x + 8, 16, 12, NIGHT, pick([0xe0595c, TEAL.dark, GOLD, VIOLET.base], x));
      p.ellipse(NIGHT, x + 16, fy + 8, 5, 5); p.ellipse(0x2a2b3a, x + 16, fy + 8, 3, 3); p.r(GOLD_LIGHT, x + 15, fy + 7, 2, 2);
      return;
    case 'sconce': // a brass wall lamp with a warm shade
      p.r(LIGHT, x + 9, fy + 1, 14, 12, 0.08); p.r(LIGHT, x + 11, fy + 2, 10, 10, 0.1);
      p.r(GOLD, x + 15, fy + 9, 2, 4); p.r(OAK.line, x + 13, fy + 12, 6, 1);
      p.r(0xf6e2bd, x + 12, fy + 4, 8, 5); p.r(GOLD_LIGHT, x + 13, fy + 5, 6, 3); p.r(0xd8b77e, x + 12, fy + 8, 8, 1);
      return;
    case 'menu': // a chalkboard menu
      frame(x + 5, 22, 12, OAK.deep, 0x2f4a3a);
      p.r(CREAM.light, x + 8, fy + 4, 9, 1); p.r(CREAM.dark, x + 8, fy + 7, 12, 1); p.r(CREAM.dark, x + 8, fy + 9, 10, 1); p.r(CREAM.dark, x + 8, fy + 11, 13, 1);
      p.r(GOLD_LIGHT, x + 21, fy + 7, 2, 1); p.r(GOLD_LIGHT, x + 21, fy + 9, 2, 1); p.r(GOLD_LIGHT, x + 22, fy + 11, 2, 1);
      return;
    case 'mugs': // a shelf of mugs
      p.r(OAK.deep, x + 4, fy + 10, 24, 2); p.r(OAK.light, x + 4, fy + 10, 24, 1);
      [TERRA.base, TEAL.dark, CREAM.light, GOLD].forEach((c, i) => { p.r(c, x + 6 + i * 6, fy + 5, 4, 5); p.r(0xffffff, x + 6 + i * 6, fy + 5, 4, 1, 0.35); p.r(c, x + 10 + i * 6, fy + 6, 1, 2); });
      return;
    case 'cup': // a small neon coffee cup
      p.r(NIGHT, x + 7, fy + 2, 18, 12);
      p.r(NEON.orange, x + 11, fy + 6, 8, 1); p.r(NEON.orange, x + 11, fy + 6, 1, 5); p.r(NEON.orange, x + 18, fy + 6, 1, 5); p.r(NEON.orange, x + 11, fy + 10, 8, 1);
      p.r(NEON.orange, x + 19, fy + 7, 2, 1); p.r(NEON.orange, x + 20, fy + 7, 1, 3); p.r(NEON.orange, x + 19, fy + 9, 2, 1);
      p.r(NEON.white, x + 13, fy + 3, 1, 2, 0.8); p.r(NEON.white, x + 16, fy + 3, 1, 2, 0.8); p.r(NEON.orange, x + 8, fy + 3, 16, 10, 0.08);
      return;
    case 'shelf': // a floating shelf with a plant and books
      p.r(OAK.deep, x + 5, fy + 10, 22, 2); p.r(OAK.light, x + 5, fy + 10, 22, 1);
      p.r(TERRA.base, x + 7, fy + 6, 6, 4); p.r(TERRA.light, x + 7, fy + 6, 6, 1); p.ellipse(LEAF.dark, x + 10, fy + 4, 4, 3); p.r(LEAF.light, x + 9, fy + 3, 2, 1); p.r(LEAF.base, x + 7, fy + 6, 1, 6);
      p.r(NAVY.base, x + 16, fy + 4, 2, 6); p.r(TERRA.dark, x + 18, fy + 5, 2, 5); p.r(GOLD, x + 20, fy + 4, 2, 6); p.r(TEAL.dark, x + 22, fy + 6, 3, 4);
      return;
    case 'photo': // a pair of framed photographs
      for (const [fx, c] of [[x + 5, TEAL.dark], [x + 18, TERRA.light]] as const) { frame(fx, 10, 11, NIGHT, c); p.ellipse(CREAM.light, fx + 5, fy + 6, 2, 2); p.r(CREAM.light, fx + 2, fy + 9, 6, 3); }
  }
}

// ---------------------------------------------------------------- light, rugs

/** A warm pool of light as three flat steps (no gradient). */
function lightPool(p: Painter, cx: number, cy: number, rx: number, ry: number): void {
  p.ellipse(LIGHT, cx, cy, rx, ry, 0.05);
  p.ellipse(LIGHT, cx, cy, Math.round(rx * 0.72), Math.round(ry * 0.72), 0.05);
  p.ellipse(LIGHT, cx, cy, Math.round(rx * 0.44), Math.round(ry * 0.44), 0.05);
}

function lighting(p: Painter, s: Scene, view: Rect): void {
  for (const r of s.rooms) {
    if (!overlaps(view, r)) continue;
    // The arcade has no warm pool: it glows from its cabinets and neon instead (ADR 057).
    const floorAt = s.floor[Math.floor((r.y + r.height / 2) / T) * s.w + Math.floor((r.x + r.width / 2) / T)] ?? 0;
    if (floorAt === FLOOR.ARCADE) continue;
    lightPool(p, Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2), Math.round(Math.min(r.width * 0.42, 300)), Math.round(Math.min(r.height * 0.4, 130)));
  }
  for (const d of s.desks) {
    if (overlaps(view, d, 48)) lightPool(p, Math.round(d.x + d.width / 2), Math.round(d.y + d.height / 2 + 4), 52, 30);
  }
  // ADR 060: a pendant lamp over every café table throws a warm pool around it.
  for (const f of s.furniture) {
    if (kindOf(f) === 'cafe-table' && overlaps(view, f, 48)) lightPool(p, Math.round(f.x + f.width / 2), Math.round(f.y + f.height / 2 + 4), 40, 26);
  }
  // Each cabinet throws its own colour onto the boards in front of it, in three flat steps.
  for (const f of s.furniture) {
    if (kindOf(f) !== 'arcade' || !overlaps(view, f, 48)) continue;
    const glow = cabinetScheme(s, f).trim;
    const cx = Math.round(f.x + f.width / 2);
    const cy = f.y + f.height + 5;
    p.ellipse(glow, cx, cy, 30, 15, 0.07); p.ellipse(glow, cx, cy, 22, 11, 0.07); p.ellipse(glow, cx, cy, 13, 6, 0.08);
  }
}

/** Lantern glow on the lawn and pendant-lamp pools over café tables. */
function campusLights(p: Painter, s: Scene, tx: number, ty: number): void {
  if (s.wall(tx, ty) && isLantern(s, tx, ty)) lightPool(p, tx * T + 16, (ty + 1) * T + 6, 34, 18);
}

/** Daylight falling onto the floor below a window, in two flat steps. */
function daylight(p: Painter, s: Scene, tx: number, ty: number): void {
  if (!isWindow(s, tx, ty)) return;
  const x = tx * T;
  const y = (ty + 1) * T;
  for (let i = 0; i < 44; i += 4) {
    if (!s.open(tx, ty + 1 + Math.floor(i / T))) break;
    p.r(0xfff0c2, x + 6 + Math.floor(i / 4), y + i, 20, 4, i < 24 ? 0.16 : 0.09);
  }
}

function rug(p: Painter, x: number, y: number, w: number, h: number, edge: number, field: number, line: number): void {
  p.r(INK, x + 1, y + h, w - 2, 1, 0.1);
  p.r(edge, x, y, w, h);
  p.r(field, x + 3, y + 3, w - 6, h - 6);
  p.frame(line, x + 5, y + 5, w - 10, h - 10);
  for (let i = x + 2; i < x + w - 3; i += 4) { p.r(line, i, y - 1, 2, 1); p.r(line, i, y + h, 2, 1); } // fringe
  for (const [cx, cy] of [[x + 8, y + 8], [x + w - 11, y + 8], [x + 8, y + h - 11], [x + w - 11, y + h - 11]] as const) p.r(edge, cx, cy, 3, 3);
}

/** Floor under the whole rectangle (furniture allowed, no wall or doorway): for rugs under furniture. */
function floorOnly(s: Scene, r: Rect): boolean {
  for (let ty = Math.floor(r.y / T); ty <= Math.floor((r.y + r.height - 1) / T); ty += 1) {
    for (let tx = Math.floor(r.x / T); tx <= Math.floor((r.x + r.width - 1) / T); tx += 1) if (!s.open(tx, ty) || s.doors.has(ty * s.w + tx)) return false;
  }
  return true;
}

/** ADR 060: an inlaid compass rose: navy and gold rings, an eight-point star. Flat; blocks nothing. */
function medallion(p: Painter, cx: number, cy: number, r: number): void {
  p.ellipse(INK, cx, cy + 2, r, r, 0.08);
  p.ellipse(NAVY.base, cx, cy, r, r); p.ellipse(GOLD, cx, cy, r - 3, r - 3); p.ellipse(MARBLE.light, cx, cy, r - 5, r - 5);
  p.ellipse(NAVY.light, cx, cy, r - 12, r - 12); p.ellipse(MARBLE.base, cx, cy, r - 14, r - 14);
  for (let i = 0; i < 16; i += 1) { const a = (i * Math.PI) / 8; p.r(GOLD, Math.round(cx + Math.cos(a) * (r - 8)) - 1, Math.round(cy + Math.sin(a) * (r - 8)) - 1, 2, 2); }
  // The star: four long points (navy and gold halves) and four short ones.
  const long = r - 16;
  const short = Math.round(long * 0.55);
  for (let k = 0; k <= long; k += 1) {
    const half = Math.max(0, Math.round((long - k) * 0.28));
    p.r(NAVY.base, cx - half, cy - k, half, 1); p.r(GOLD, cx, cy - k, half + 1, 1);
    p.r(GOLD, cx - half, cy + k, half, 1); p.r(NAVY.base, cx, cy + k, half + 1, 1);
    p.r(NAVY.base, cx + k, cy - half, 1, half); p.r(GOLD, cx + k, cy, 1, half + 1);
    p.r(GOLD, cx - k, cy - half, 1, half); p.r(NAVY.base, cx - k, cy, 1, half + 1);
  }
  for (let k = 0; k <= short; k += 1) {
    const half = Math.max(0, Math.round((short - k) * 0.3));
    for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) p.r(SLATE.light, cx + sx * k - (half >> 1), cy + sy * k - (half >> 1), half + 1, half + 1, 0.9);
  }
  p.ellipse(GOLD, cx, cy, 3, 3); p.r(GOLD_LIGHT, cx - 1, cy - 1, 2, 2);
}

/** Free floor only: every tile under the rectangle is open floor without furniture. */
function clear(s: Scene, r: Rect): boolean {
  for (let ty = Math.floor(r.y / T); ty <= Math.floor((r.y + r.height - 1) / T); ty += 1) {
    for (let tx = Math.floor(r.x / T); tx <= Math.floor((r.x + r.width - 1) / T); tx += 1) if (!s.open(tx, ty) || s.taken.has(ty * s.w + tx) || s.doors.has(ty * s.w + tx)) return false;
  }
  return true;
}

const kindOf = (f: MapObject): string => String(prop(f, 'kind', 'table')).toLowerCase();
const isDeskTable = (s: Scene, f: MapObject): boolean => s.desks.some((d) => overlaps(d, f));
const isBigTable = (s: Scene, f: MapObject): boolean => kindOf(f) === 'table' && !isDeskTable(s, f) && f.width >= 3 * T && f.height >= 2 * T;

function rugs(p: Painter, s: Scene, view: Rect): void {
  for (const f of s.furniture) {
    const kind = kindOf(f);
    if (onArcadeFloor(s, f)) { arcadeRug(p, s, f, view); continue; }
    if (isBigTable(s, f)) {
      // Under a meeting table, kept inside its room.
      const room = s.rooms.find((r) => overlaps(r, f));
      let r: Rect = { x: f.x - 40, y: f.y - 34, width: f.width + 80, height: f.height + 68 };
      if (room) {
        const x0 = Math.max(r.x, room.x + 20);
        const y0 = Math.max(r.y, room.y + 26);
        r = { x: x0, y: y0, width: Math.min(r.x + r.width, room.x + room.width - 20) - x0, height: Math.min(r.y + r.height, room.y + room.height - 14) - y0 };
      }
      if (r.width > f.width && r.height > f.height && overlaps(view, r, 2)) patternRug(p, r, { edge: SLATE.deep, field: 0xd9dfe9, line: GOLD, accent: SLATE.base });
    } else if (kind === 'sofa' && f.width >= f.height) {
      const r = { x: f.x + 8, y: f.y + f.height + 6, width: f.width - 16, height: 44 };
      if (clear(s, r) && overlaps(view, r, 2)) patternRug(p, r, { edge: TERRA.deep, field: 0xe8cdb4, line: TEAL.deep, accent: TERRA.base });
    } else if (kind === 'counter') {
      const r = { x: f.x + 24, y: f.y + f.height + 10, width: f.width - 48, height: 22 };
      if (r.width > 40 && clear(s, r) && overlaps(view, r, 2)) rug(p, r.x, r.y, r.width, r.height, NAVY.light, 0xb9c6dc, GOLD);
    }
  }
  // ADR 060: a wool rug under each workstation (table and chair), so the desks read as places.
  for (const d of s.desks) {
    const r = { x: d.x - 10, y: d.y - 6, width: d.width + 20, height: d.height + 12 };
    if (!overlaps(view, r, 4) || !floorOnly(s, r)) continue;
    rug(p, r.x, r.y, r.width, r.height, TEAL.deep, 0xd9cdb2, 0xc4b594);
  }
  // ADR 060: a compass medallion in the middle of an open room with marble floor (reception).
  for (const room of s.rooms) {
    const cx = Math.round(room.x + room.width / 2);
    const cy = Math.round(room.y + room.height / 2 + T / 2);
    if ((s.floor[Math.floor(cy / T) * s.w + Math.floor(cx / T)] ?? 0) !== FLOOR.RECEPTION) continue;
    const rr = 44;
    if (!clear(s, { x: cx - rr, y: cy - rr, width: rr * 2, height: rr * 2 }) || !overlaps(view, { x: cx - rr, y: cy - rr, width: rr * 2, height: rr * 2 }, 4)) continue;
    medallion(p, cx, cy, rr);
  }
  // An oval rug in the middle of each private room that has free floor there.
  for (const room of s.rooms) {
    if (room.type !== 'PRIVATE' || !overlaps(view, room)) continue;
    const cx = Math.round(room.x + room.width / 2);
    const cy = Math.round(room.y + room.height / 2);
    const rx = Math.round(Math.min(room.width * 0.28, 96));
    const ry = Math.round(Math.min(room.height * 0.24, 52));
    if (!clear(s, { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 })) continue;
    p.ellipse(SAGE.deep, cx, cy, rx, ry); p.ellipse(0xdfe8da, cx, cy, rx - 3, ry - 3);
    p.ellipse(SAGE.dark, cx, cy, rx - 6, ry - 6); p.ellipse(0xe9efe4, cx, cy, rx - 8, ry - 8);
    p.ellipse(TERRA.light, cx, cy, Math.round(rx * 0.3), Math.round(ry * 0.3)); p.ellipse(0xe9efe4, cx, cy, Math.round(rx * 0.3) - 2, Math.round(ry * 0.3) - 2);
  }
}

// ---------------------------------------------------------------- arcade (ADR 057), paint only

const floorUnder = (s: Scene, f: MapObject): number => s.floor[Math.floor((f.y + f.height / 2) / T) * s.w + Math.floor((f.x + f.width / 2) / T)] ?? 0;
const onArcadeFloor = (s: Scene, f: MapObject): boolean => floorUnder(s, f) === FLOOR.ARCADE;

/** 5 x 7 capitals for the neon signs. */
const GLYPHS: Record<string, readonly string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  G: ['.####', '#....', '#....', '#.###', '#...#', '#...#', '.###.'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
};
const SIGN_TEXTS = ['ARCADE', 'GAME ON'];
const SIGN_COLOURS: Array<[number, number]> = [[NEON.pink, NEON.cyan], [NEON.cyan, NEON.yellow]];
const STAR = ['.....#.....', '....###....', '....###....', '###########', '.#########.', '..#######..', '..#######..', '.####.####.', '.###...###.', '##.......##'];
const BOLT = ['....###', '...###.', '..###..', '.######', '...###.', '..###..', '.###...', '.##....', '#......'];

/** A bitmap as a neon tube: a soft halo, the tube, and a bright core. */
function neon(p: Painter, rows: readonly string[], x: number, y: number, scale: number, colour: number): void {
  const each = (fn: (px: number, py: number) => void) => rows.forEach((row, j) => { for (let i = 0; i < row.length; i += 1) if (row[i] === '#') fn(x + i * scale, y + j * scale); });
  each((px, py) => p.r(colour, px - 1, py - 1, scale + 2, scale + 2, 0.2));
  each((px, py) => p.r(colour, px, py, scale, scale));
  each((px, py) => p.r(NEON.white, px, py, 1, 1, 0.55));
}

const textWidth = (text: string, scale: number): number => text.length * 6 * scale - scale;

/**
 * Plans the arcade's wall once: a neon sign above each row of cabinets that stands against a
 * wall, and something for every wall-face tile a cabinet does not hide.
 */
function planArcadeWalls(s: Scene): void {
  const rows = new Map<number, MapObject[]>();
  for (const f of s.furniture) {
    const ty = Math.floor(f.y / T) - 1;
    if (kindOf(f) !== 'arcade' || !onArcadeFloor(s, f) || !hasFace(s, Math.floor(f.x / T), ty)) continue;
    rows.set(ty, [...(rows.get(ty) ?? []), f]);
  }
  for (const [ty, cabinets] of rows) {
    cabinets.sort((a, b) => a.x - b.x);
    // Cabinets no more than three tiles apart share a sign.
    const groups: MapObject[][] = [];
    for (const c of cabinets) { const g = groups[groups.length - 1]; if (g && c.x - (g[g.length - 1]!.x + g[g.length - 1]!.width) <= 3 * T) g.push(c); else groups.push([c]); }
    groups.forEach((g, i) => {
      const text = SIGN_TEXTS[(s.signs.length) % SIGN_TEXTS.length]!;
      const width = textWidth(text, 2) + 10;
      const x = Math.round((g[0]!.x + g[g.length - 1]!.x + g[g.length - 1]!.width) / 2 - width / 2);
      // The board sits on the wall band above the cabinets; every tile under it must be wall face.
      for (let tx = Math.floor(x / T); tx <= Math.floor((x + width - 1) / T); tx += 1) if (!hasFace(s, tx, ty)) return;
      const [colour, accent] = SIGN_COLOURS[i % SIGN_COLOURS.length]!;
      s.signs.push({ x, y: ty * T, width, height: 18, text, colour, accent });
    });
  }
  const kinds: ArcadeArt[] = ['rocket', 'planet', 'star', 'bolt', 'planter', 'sunset'];
  let n = 0;
  for (let ty = 0; ty < s.h; ty += 1) for (let tx = 0; tx < s.w; tx += 1) {
    if (!hasFace(s, tx, ty) || s.faceUsed.has(ty * s.w + tx) || (s.floor[(ty + 1) * s.w + tx] ?? 0) !== FLOOR.ARCADE) continue;
    // A cabinet standing against the wall hides the face behind it.
    if (s.furniture.some((f) => kindOf(f) === 'arcade' && Math.floor(f.x / T) === tx && Math.floor(f.y / T) === ty + 1)) continue;
    const underSign = s.signs.some((g) => g.y === ty * T && g.x < (tx + 1) * T && g.x + g.width > tx * T);
    s.arcadeArt.set(ty * s.w + tx, underSign ? 'sconce' : kinds[n++ % kinds.length]!);
  }
}

function neonSign(p: Painter, g: NeonSign): void {
  p.r(INK, g.x + 1, g.y + g.height, g.width - 2, 1, 0.3);
  p.r(INDIGO.light, g.x, g.y, g.width, g.height); p.r(NIGHT, g.x + 1, g.y + 1, g.width - 2, g.height - 2);
  for (const cx of [g.x + 2, g.x + g.width - 3]) { p.r(g.accent, cx, g.y + 2, 1, 1); p.r(g.accent, cx, g.y + g.height - 3, 1, 1); } // corner lamps
  let x = g.x + 5;
  for (const ch of g.text) { const rows = GLYPHS[ch]; if (rows) neon(p, rows, x, g.y + 2, 2, g.colour); x += 12; }
}

/** What hangs on one arcade wall-face tile. Everything stays inside the tile's own face. */
function arcadeWallArt(p: Painter, kind: ArcadeArt, tx: number, ty: number): void {
  const x = tx * T;
  const fy = ty * T + CAP;
  if (kind === 'sconce') { // a small lamp under the sign
    p.r(GOLD, x + 14, fy + 6, 4, 2); p.r(NIGHT, x + 15, fy + 8, 2, 1);
    p.ellipse(NEON.purple, x + 16, fy + 11, 7, 4, 0.16); p.r(VIOLET.light, x + 13, fy + 9, 6, 4); p.r(NEON.white, x + 14, fy + 10, 4, 2, 0.8); p.r(VIOLET.dark, x + 13, fy + 13, 6, 1);
    return;
  }
  if (kind === 'star') { neon(p, STAR, x + 10, fy + 3, 1, NEON.yellow); return; }
  if (kind === 'bolt') { neon(p, BOLT, x + 12, fy + 4, 1, NEON.cyan); return; }
  if (kind === 'planter') { // a shelf with trailing leaves
    p.r(WALNUT.deep, x + 7, fy + 9, 18, 2); p.r(WALNUT.light, x + 7, fy + 9, 18, 1);
    p.r(TERRA.base, x + 10, fy + 5, 5, 4); p.r(TERRA.light, x + 10, fy + 5, 5, 1); p.r(TERRA.base, x + 18, fy + 6, 4, 3); p.r(TERRA.light, x + 18, fy + 6, 4, 1);
    p.ellipse(LEAF.dark, x + 12, fy + 4, 4, 2); p.r(LEAF.light, x + 11, fy + 3, 2, 1); p.ellipse(LEAF.base, x + 20, fy + 5, 3, 2);
    p.r(LEAF.base, x + 9, fy + 6, 1, 6); p.r(LEAF.dark, x + 15, fy + 5, 1, 8); p.r(LEAF.light, x + 15, fy + 12, 2, 1); p.r(LEAF.base, x + 22, fy + 7, 1, 5); p.r(LEAF.light, x + 8, fy + 11, 2, 1);
    return;
  }
  // A framed poster, 16 x 12, with original artwork.
  const px = x + 8;
  const py = fy + 3;
  p.r(INK, px + 1, py + 12, 15, 1, 0.3);
  p.r(GOLD, px, py, 16, 12);
  if (kind === 'rocket') {
    p.r(0x141a3a, px + 1, py + 1, 14, 10);
    for (const [sx, sy] of [[2, 2], [11, 3], [4, 8], [13, 8]] as const) p.r(NEON.white, px + sx, py + sy, 1, 1);
    p.r(0xe5484d, px + 7, py + 2, 2, 1); p.r(NEON.white, px + 6, py + 3, 4, 5); p.r(NEON.cyan, px + 7, py + 4, 2, 2);
    p.r(0xe5484d, px + 5, py + 6, 1, 2); p.r(0xe5484d, px + 10, py + 6, 1, 2); p.r(NEON.orange, px + 7, py + 8, 2, 2); p.r(NEON.yellow, px + 7, py + 8, 2, 1);
  } else if (kind === 'planet') {
    p.r(VIOLET.deep, px + 1, py + 1, 14, 10);
    for (const [sx, sy] of [[2, 3], [12, 2], [13, 9]] as const) p.r(NEON.white, px + sx, py + sy, 1, 1);
    p.ellipse(NEON.orange, px + 8, py + 6, 3, 3); p.r(NEON.yellow, px + 6, py + 4, 2, 1); p.r(0xc9682a, px + 7, py + 8, 3, 1);
    p.r(NEON.cyan, px + 3, py + 6, 3, 1); p.r(NEON.cyan, px + 11, py + 6, 3, 1); p.r(NEON.cyan, px + 5, py + 7, 7, 1, 0.8);
  } else { // a sun setting over a grid
    p.r(0x3b1d5e, px + 1, py + 1, 14, 3); p.r(0x8a2e77, px + 1, py + 4, 14, 2); p.r(NEON.pink, px + 1, py + 6, 14, 1);
    p.r(NEON.yellow, px + 6, py + 3, 4, 1); p.r(NEON.yellow, px + 5, py + 4, 6, 1); p.r(NEON.orange, px + 5, py + 5, 6, 1); p.r(NEON.orange, px + 4, py + 6, 8, 1);
    p.r(0x141a3a, px + 1, py + 7, 14, 4); p.r(NEON.purple, px + 1, py + 8, 14, 1, 0.8); p.r(NEON.purple, px + 1, py + 10, 14, 1, 0.8);
    for (const gx of [3, 6, 9, 12]) p.r(NEON.purple, px + gx, py + 7, 1, 4, 0.7);
  }
}

/**
 * Neon tubes along the walls beside and below the arcade floor (the wall above it has its own
 * under the coping), with a faint wash of the same colour on the boards.
 */
function arcadeTrim(p: Painter, s: Scene, tx: number, ty: number): void {
  const arcade = (x: number, y: number) => s.open(x, y) && (s.floor[y * s.w + x] ?? 0) === FLOOR.ARCADE && !s.doors.has(y * s.w + x);
  const x = tx * T;
  const y = ty * T;
  const tube = (colour: number, rx: number, ry: number, w: number, h: number, gx: number, gy: number) => {
    p.r(colour, rx, ry, w, h); p.r(NEON.white, w > h ? rx + 1 : rx, w > h ? ry : ry + 1, w > h ? w - 2 : 1, w > h ? 1 : h - 2, 0.45); p.r(NIGHT, rx, ry, w > h ? 1 : w, w > h ? h : 1);
    p.r(colour, w > h ? rx : rx + gx * 2, w > h ? ry + gy * 2 : ry, w > h ? w : 4, w > h ? 4 : h, 0.1);
  };
  if (arcade(tx + 1, ty)) tube(NEON.cyan, x + T - 2, y, 2, T, 1, 0);
  if (arcade(tx - 1, ty)) tube(NEON.pink, x, y, 2, T, -2, 0);
  if (arcade(tx, ty - 1)) tube(NEON.purple, x, y, T, 2, 0, -2);
}

/** A game-area rug with a border, a row of diamonds along each long side and a fringe. */
function patternRug(p: Painter, r: Rect, c: { edge: number; field: number; line: number; accent: number }): void {
  p.r(INK, r.x + 1, r.y + r.height, r.width - 2, 2, 0.16);
  p.r(c.edge, r.x, r.y, r.width, r.height);
  p.r(c.field, r.x + 3, r.y + 3, r.width - 6, r.height - 6);
  p.frame(c.line, r.x + 5, r.y + 5, r.width - 10, r.height - 10);
  p.frame(c.edge, r.x + 7, r.y + 7, r.width - 14, r.height - 14);
  for (let i = r.x + 14; i < r.x + r.width - 16; i += 12) {
    for (const dy of [11, r.height - 14]) { p.r(c.accent, i + 1, r.y + dy, 1, 3); p.r(c.accent, i, r.y + dy + 1, 3, 1); }
  }
  for (let i = r.y + 2; i < r.y + r.height - 3; i += 4) { p.r(c.line, r.x - 1, i, 1, 2); p.r(c.line, r.x + r.width, i, 1, 2); } // fringe
}

/** Rugs under the arcade's play areas. They lie under the furniture and block nothing. */
function arcadeRug(p: Painter, s: Scene, f: MapObject, view: Rect): void {
  const kind = kindOf(f);
  const room = s.rooms.find((r) => overlaps(r, f));
  const inRoom = (r: Rect): Rect | null => {
    if (!room) return r;
    const x0 = Math.max(r.x, room.x + 12);
    const y0 = Math.max(r.y, room.y + 12);
    const out = { x: x0, y: y0, width: Math.min(r.x + r.width, room.x + room.width - 12) - x0, height: Math.min(r.y + r.height, room.y + room.height - 12) - y0 };
    return out.width > f.width && out.height >= 24 ? out : null;
  };
  if (kind === 'ping-pong') {
    const r = inRoom({ x: f.x - 26, y: f.y - 22, width: f.width + 52, height: f.height + 44 });
    if (r && overlaps(view, r, 4)) patternRug(p, r, { edge: INDIGO.dark, field: 0x3f5fb0, line: NEON.cyan, accent: 0x9fc0ff });
  } else if (kind === 'game-table') {
    const r = inRoom({ x: f.x - 30, y: f.y - 26, width: f.width + 60, height: f.height + 52 });
    if (r && overlaps(view, r, 4)) patternRug(p, r, { edge: 0x1c4f5c, field: 0x2c7c88, line: 0x8fe0d8, accent: NEON.yellow });
  } else if (kind === 'chess-table') {
    const cx = Math.round(f.x + f.width / 2);
    const cy = Math.round(f.y + f.height / 2);
    const rx = Math.round(f.width / 2) + 28;
    const ry = Math.round(f.height / 2) + 20;
    if (!inRoom({ x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 }) || !overlaps(view, { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 + 2 }, 4)) return;
    p.ellipse(INK, cx, cy + 2, rx, ry, 0.14);
    p.ellipse(VIOLET.deep, cx, cy, rx, ry); p.ellipse(VIOLET.mid, cx, cy, rx - 3, ry - 3); p.ellipse(NEON.purple, cx, cy, rx - 6, ry - 6); p.ellipse(VIOLET.dark, cx, cy, rx - 8, ry - 8);
    for (let i = 0; i < 12; i += 1) { const a = (i * Math.PI) / 6; p.r(GOLD_LIGHT, Math.round(cx + Math.cos(a) * (rx - 13)), Math.round(cy + Math.sin(a) * (ry - 12)), 2, 2); }
  } else if (kind === 'sofa' && f.width >= f.height) {
    const r = { x: f.x + 8, y: f.y - 52, width: f.width - 16, height: 44 };
    if (clear(s, r) && overlaps(view, r, 4)) patternRug(p, r, { edge: VIOLET.deep, field: 0xb04a8c, line: NEON.pink, accent: NEON.yellow });
  }
}

// ---------------------------------------------------------------- furniture

/** A chair seen from above. `back`: which side the backrest is on. Paint only (seats stay walkable). */
function chair(p: Painter, cx: number, cy: number, back: 'top' | 'bottom', seat: number, dark: number, light: number): void {
  p.r(INK, cx - 6, cy + 7, 13, 2, 0.14);
  p.r(dark, cx - 7, cy - 7, 14, 14);
  p.r(seat, cx - 6, cy - 6, 12, 12);
  p.r(light, cx - 5, cy - 5, 10, 1);
  if (back === 'top') { p.r(dark, cx - 7, cy - 8, 14, 5); p.r(light, cx - 6, cy - 8, 12, 1); }
  else { p.r(dark, cx - 7, cy + 3, 14, 5); p.r(light, cx - 6, cy + 3, 12, 1); }
  p.r(dark, cx - 8, cy - 2, 1, 5); p.r(dark, cx + 7, cy - 2, 1, 5); // arm rests
}

/**
 * ADR 056: a chair at every seat of the map (mapSeats, the same list the server lets people sit
 * on), its back away from the table. Paint only: the seat point itself stays walkable.
 */
function chairs(p: Painter, s: Scene, view: Rect): void {
  for (const seat of s.seats) {
    if (!overlaps(view, { x: seat.x - 12, y: seat.y - 12, width: 24, height: 24 })) continue;
    const cx = Math.round(seat.x);
    const cy = Math.round(seat.y);
    if (seat.kind === 'bench') continue; // FR-VO-019: the bench or sofa is the seat
    if (seat.kind === 'desk') chair(p, cx, cy + 1, 'bottom', 0x4b5563, 0x2f3542, 0x6b7280); // ADR 060: charcoal task chairs
    else if (seat.kind === 'cafe') sideChair(p, cx, cy, seat.facing === 'right' ? 'left' : 'right');
    else chair(p, cx, cy + (seat.facing === 'down' ? 6 : -6), seat.facing === 'down' ? 'top' : 'bottom', NAVY.light, NAVY.mid, 0x6f84ab);
  }
}

/** A café chair seen from above, its back on one side. */
function sideChair(p: Painter, cx: number, cy: number, back: 'left' | 'right'): void {
  p.r(INK, cx - 6, cy + 7, 12, 2, 0.14);
  p.r(OAK.deep, cx - 6, cy - 6, 12, 12); p.r(OAK.base, cx - 5, cy - 5, 10, 10); p.r(OAK.light, cx - 5, cy - 5, 10, 1);
  p.r(OAK.deep, back === 'left' ? cx - 7 : cx + 4, cy - 7, 3, 14);
}

function pottedPlant(p: Painter, cx: number, base: number, big: boolean): void {
  const k = big ? 1 : 0.72;
  const r = (n: number) => Math.max(1, Math.round(n * k));
  p.ellipse(INK, cx, base - 2, r(10), r(3), 0.18);
  p.r(TERRA.dark, cx - r(6), base - r(12), r(12), r(10));
  p.r(TERRA.base, cx - r(6), base - r(12), r(9), r(10));
  p.r(TERRA.light, cx - r(7), base - r(14), r(14), r(3));
  p.r(TERRA.deep, cx - r(5), base - r(3), r(10), 1);
  const top = base - r(14);
  p.ellipse(LEAF.deep, cx, top - r(7), r(11), r(9));
  p.ellipse(LEAF.dark, cx - r(1), top - r(8), r(9), r(7));
  p.ellipse(LEAF.base, cx - r(4), top - r(9), r(5), r(4));
  p.ellipse(LEAF.base, cx + r(4), top - r(5), r(5), r(4));
  p.ellipse(LEAF.light, cx - r(3), top - r(11), r(3), r(2));
  p.r(LEAF.light, cx + r(3), top - r(7), r(3), 1); p.r(LEAF.light, cx - r(7), top - r(5), r(2), 1);
  p.r(LEAF.deep, cx, top - r(3), 1, r(4));
}

/** Oak top seen from above with a front apron: the shared body of desks and tables. */
function tableBody(p: Painter, x: number, y: number, w: number, h: number): void {
  p.r(INK, x + 2, y + h - 1, w - 3, 4, 0.18);
  p.r(OAK.line, x, y + 1, w, h - 2);
  p.r(OAK.base, x + 1, y + 2, w - 2, h - 11);
  p.r(OAK.light, x + 1, y + 2, w - 2, 2);
  p.r(OAK.mid, x + 1, y + h - 11, w - 2, 2);
  p.r(OAK.dark, x + 1, y + h - 9, w - 2, 7); // apron
  p.r(OAK.deep, x + 1, y + h - 9, w - 2, 1);
  p.r(OAK.deep, x + 1, y + h - 3, 3, 2); p.r(OAK.deep, x + w - 4, y + h - 3, 3, 2); // legs
  p.r(OAK.line, x, y + 1, 1, 1); p.r(OAK.line, x + w - 1, y + 1, 1, 1);
}

function deskTable(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  tableBody(p, x, y, w, h);
  const v = hash(x, y, 31);
  // A cream desk mat on the left (the desk label sits on it); monitor and keyboard on the right.
  p.r(CREAM.dark, x + 3, y + 5, Math.min(41, w - 24), 14); p.r(CREAM.light, x + 4, y + 6, Math.min(39, w - 26), 12);
  const mx = x + w - 15;
  p.r(NAVY.deep, mx, y + 3, 12, 9); p.r(v % 3 ? 0x8fc7e8 : 0xa8dcc0, mx + 1, y + 4, 10, 7);
  p.r(0xffffff, mx + 2, y + 5, 4, 1, 0.7); p.r(0xffffff, mx + 2, y + 7, 6, 1, 0.45);
  p.r(0x4b5563, mx + 5, y + 12, 2, 2); p.r(0x4b5563, mx + 3, y + 14, 6, 1);
  p.r(0x9aa3af, mx + 1, y + 16, 10, 3); p.r(0xd1d5db, mx + 2, y + 17, 8, 1);
  // ADR 060: something personal beside the monitor (left of it, clear of the desk label on the mat).
  // The desk label (renderer: x + 6, 10 px type) ends near x + 41, the monitor starts at x + w - 15.
  const px = mx - 6;
  if (px < x + 42) return;
  switch (v % 4) {
    case 0: p.r(CREAM.light, px, y + 13, 4, 5); p.r(TERRA.base, px, y + 13, 4, 1); p.r(CREAM.light, px + 4, y + 14, 1, 2); p.r(0x5b3a29, px + 1, y + 14, 2, 1); break; // mug
    case 1: p.r(TERRA.base, px, y + 14, 5, 4); p.r(TERRA.light, px, y + 14, 5, 1); p.ellipse(LEAF.dark, px + 2, y + 11, 3, 3); p.r(LEAF.light, px + 1, y + 9, 2, 1); break; // succulent
    case 2: p.r(NAVY.deep, px + 2, y + 7, 1, 9); p.r(NAVY.deep, px, y + 16, 5, 2); p.r(GOLD_LIGHT, px, y + 5, 5, 3); break; // desk lamp
    default: p.r(TEAL.ink, px, y + 12, 5, 6); p.r(CREAM.light, px + 1, y + 13, 3, 4); p.r(TERRA.base, px + 4, y + 11, 1, 7); // notebook with a pen
  }
}

function plainTable(p: Painter, s: Scene, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  tableBody(p, x, y, w, h);
  if (!isBigTable(s, f)) return;
  // Board joints, a runner down the middle, and things left on the table.
  for (let i = x + 32; i < x + w - 8; i += 32) p.r(OAK.mid, i, y + 4, 1, h - 16);
  const ry = y + Math.round((h - 9) / 2) - 5;
  p.r(NAVY.base, x + 22, ry, w - 44, 10); p.frame(GOLD, x + 23, ry + 1, w - 46, 8);
  const cx = x + Math.round(w / 2);
  p.ellipse(TERRA.dark, cx, ry + 5, 4, 3); p.ellipse(LEAF.dark, cx, ry + 3, 5, 4); p.ellipse(LEAF.light, cx - 1, ry + 2, 2, 1);
  for (let i = x + 12, n = 0; i < x + w - 20; i += 32, n += 1) {
    const v = hash(i, y, 41);
    if (v % 3 === 0) { p.r(0x6b7482, i, y + 4, 11, 7); p.r(0xbfd9ea, i + 1, y + 5, 9, 5); } // laptop
    else if (v % 3 === 1) { p.r(CREAM.light, i + 1, y + 4, 8, 6); p.r(CREAM.line, i + 2, y + 6, 5, 1); p.r(CREAM.line, i + 2, y + 8, 4, 1); } // paper
    if (h >= 2 * T && (v >>> 4) % 3 !== 0) { const by = y + h - 19; p.r(CREAM.light, i + 2, by, 8, 6); p.r(n % 2 ? TERRA.base : NAVY.light, i + 11, by + 1, 3, 4); }
  }
}

/** `c`: the upholstery (terracotta by default; violet in the arcade, ADR 057). */
function sofa(p: Painter, f: MapObject, c: { light: number; base: number; mid: number; dark: number; deep: number } = TERRA): void {
  const { x, y, width: w, height: h } = f;
  p.r(INK, x + 2, y + h - 1, w - 3, 4, 0.18);
  p.r(c.deep, x, y + 1, w, h - 2);
  p.r(c.mid, x + 1, y + 2, w - 2, 10); // back rest
  p.r(c.light, x + 2, y + 2, w - 4, 1);
  p.r(c.dark, x + 1, y + 11, w - 2, 1);
  p.r(c.mid, x + 1, y + 2, 7, h - 6); p.r(c.mid, x + w - 8, y + 2, 7, h - 6); // arms
  p.r(c.light, x + 2, y + 2, 5, 1); p.r(c.light, x + w - 7, y + 2, 5, 1);
  const inner = w - 18;
  const n = Math.max(1, Math.round(inner / 46));
  const cw = inner / n;
  for (let i = 0; i < n; i += 1) {
    const cx = Math.round(x + 9 + i * cw);
    const cwi = Math.round(x + 9 + (i + 1) * cw) - cx;
    p.r(c.base, cx, y + 12, cwi - 1, h - 17);
    p.r(c.light, cx, y + 12, cwi - 1, 1);
    p.r(c.dark, cx + cwi - 1, y + 12, 1, h - 17);
  }
  p.r(c.dark, x + 1, y + h - 5, w - 2, 3); // front edge
  p.r(CREAM.base, x + 11, y + 6, 9, 8); p.r(CREAM.dark, x + 11, y + 13, 9, 1); p.r(CREAM.light, x + 12, y + 7, 7, 1);
  p.r(SAGE.dark, x + w - 21, y + 6, 9, 8); p.r(SAGE.deep, x + w - 21, y + 13, 9, 1); p.r(SAGE.light, x + w - 20, y + 7, 7, 1);
}

function counter(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  p.r(INK, x + 2, y + h - 1, w - 3, 4, 0.18);
  p.r(NAVY.deep, x, y + 1, w, h - 2);
  p.r(NAVY.base, x + 1, y + 11, w - 2, h - 14); // front
  for (let i = x + 16; i < x + w - 4; i += 32) { p.r(NAVY.mid, i, y + 13, 1, h - 18); p.r(NAVY.light, i + 1, y + 13, 1, h - 18, 0.5); }
  p.r(GOLD, x + 1, y + h - 5, w - 2, 1);
  p.r(CREAM.base, x + 1, y + 2, w - 2, 9); // top
  p.r(CREAM.light, x + 1, y + 2, w - 2, 2);
  p.r(CREAM.line, x + 1, y + 10, w - 2, 1);
  if (w >= 3 * T) {
    p.r(NAVY.deep, x + 14, y + 1, 13, 8); p.r(0x8fc7e8, x + 15, y + 2, 11, 6); p.r(0xffffff, x + 16, y + 3, 5, 1, 0.7); // screen
    const bx = x + Math.round(w / 2);
    p.r(GOLD, bx - 3, y + 6, 7, 2); p.r(GOLD, bx - 2, y + 4, 5, 2); p.r(0xf3d48a, bx - 1, y + 4, 2, 1); p.r(OAK.deep, bx, y + 3, 1, 1); // bell
    p.r(CREAM.light, bx + 14, y + 4, 9, 5); p.r(CREAM.line, bx + 15, y + 6, 6, 1); // papers
    p.r(TERRA.base, x + w - 24, y + 5, 7, 5); p.r(TERRA.light, x + w - 24, y + 5, 7, 1); // vase
    p.ellipse(LEAF.dark, x + w - 21, y + 1, 5, 4); p.ellipse(LEAF.base, x + w - 22, y, 3, 2); p.r(LEAF.light, x + w - 23, y - 1, 2, 1);
  }
}

/** Any furniture kind this file does not know: an oak cabinet filling its rectangle. */
function cabinet(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  if (w < 6 || h < 6) return;
  p.r(INK, x + 2, y + h - 1, w - 3, 4, 0.18);
  p.r(OAK.line, x, y + 1, w, h - 2);
  p.r(OAK.base, x + 1, y + 2, w - 2, Math.max(1, h - 12));
  p.r(OAK.light, x + 1, y + 2, w - 2, 1);
  p.r(OAK.dark, x + 1, y + h - 10, w - 2, 8);
  p.r(OAK.deep, x + 1, y + h - 10, w - 2, 1);
  for (let i = x + 1; i < x + w - 6; i += 24) { p.r(OAK.deep, i + 23, y + h - 9, 1, 7); p.r(GOLD, i + 10, y + h - 6, 3, 1); }
}

/** Kinds drawn as depth-sorted props (they rise above their footprint) rather than on the floor. */
const TALL = new Set(['plant', 'tree', 'arcade']);
const isTall = (f: MapObject): boolean => TALL.has(kindOf(f));

function furnitureItem(p: Painter, s: Scene, f: MapObject): void {
  const kind = kindOf(f);
  if (kind === 'plant') pottedPlant(p, Math.round(f.x + f.width / 2), f.y + f.height - 1, true);
  else if (kind === 'arcade') arcadeCabinet(p, f, cabinetScheme(s, f));
  else if (CAMPUS[kind]) CAMPUS[kind]!(p, f);
  else if (kind === 'sofa' && f.width >= f.height && f.width >= 48) sofa(p, f, onArcadeFloor(s, f) ? VIOLET : TERRA);
  else if (kind === 'counter' && f.height >= 20) counter(p, f);
  else if (kind === 'table' && f.width >= 24 && f.height >= 20) { if (isDeskTable(s, f)) deskTable(p, f); else plainTable(p, s, f); }
  else cabinet(p, f);
}

// ---------------------------------------------------------------- campus furniture (ADR 055)

const shadow = (p: Painter, f: MapObject) => p.r(INK, f.x + 2, f.y + f.height - 1, f.width - 3, 4, 0.18);

/** Coffee bar: cream top, oak front, espresso machine, grinder, cups and a pastry case. */
function coffeeCounter(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  shadow(p, f);
  p.r(OAK.line, x, y + 1, w, h - 2);
  p.r(OAK.dark, x + 1, y + 20, w - 2, h - 23);
  for (let i = x + 12; i < x + w - 4; i += 24) p.r(OAK.deep, i, y + 22, 1, h - 27);
  p.r(GOLD, x + 1, y + h - 6, w - 2, 1);
  p.r(CREAM.base, x + 1, y + 2, w - 2, 18); p.r(CREAM.light, x + 1, y + 2, w - 2, 2); p.r(CREAM.line, x + 1, y + 19, w - 2, 1);
  // Espresso machine.
  const mx = x + 8;
  p.r(0x6b7280, mx, y + 3, 26, 14); p.r(0xc0c6ce, mx + 1, y + 4, 24, 4); p.r(TERRA.base, mx + 2, y + 9, 22, 2);
  p.r(0x2f3542, mx + 5, y + 12, 3, 4); p.r(0x2f3542, mx + 17, y + 12, 3, 4); p.r(CREAM.light, mx + 5, y + 15, 3, 2); p.r(CREAM.light, mx + 17, y + 15, 3, 2);
  p.r(GOLD_LIGHT, mx + 11, y + 5, 3, 2);
  // Grinder with beans.
  p.r(0x3a3f4b, mx + 30, y + 4, 8, 12); p.r(0x6b4226, mx + 31, y + 5, 6, 4); p.r(0x8a5a35, mx + 32, y + 6, 2, 1);
  // Cups and a pastry case.
  for (let i = 0; i < 3; i += 1) { p.r(CREAM.light, mx + 44 + i * 6, y + 10, 4, 5); p.r(TERRA.mid, mx + 44 + i * 6, y + 10, 4, 1); }
  const cx = x + w - 52;
  if (cx > mx + 64) {
    p.r(GLASS.dark, cx, y + 3, 40, 14); p.r(GLASS.light, cx + 1, y + 4, 38, 12, 0.85);
    for (let i = 0; i < 5; i += 1) { p.r(pick([0xd9a05b, 0xb7703c, 0xe7c38a, TERRA.light], i), cx + 3 + i * 7, y + 10, 5, 4); p.r(0xf6e2bd, cx + 4 + i * 7, y + 10, 3, 1); }
    p.r(0xffffff, cx + 2, y + 5, 10, 1, 0.8);
  }
  // Menu board on the counter front.
  p.r(NAVY.deep, x + w - 30, y + 24, 22, h - 32); p.r(CREAM.base, x + w - 27, y + 27, 12, 1); p.r(CREAM.dark, x + w - 27, y + 30, 16, 1); p.r(CREAM.dark, x + w - 27, y + 33, 9, 1);
}

/** A wall bookshelf seen from the room: shelves of coloured spines, a plant and a vase. */
function bookshelf(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  shadow(p, f);
  p.r(OAK.deep, x, y, w, h); p.r(OAK.dark, x + 2, y + 2, w - 4, h - 4);
  const rows = Math.max(2, Math.floor((h - 4) / 9));
  const spines = [NAVY.base, TERRA.base, CREAM.base, SAGE.deep, GOLD, NAVY.light, TERRA.dark, LEAF.dark];
  for (let r = 0; r < rows; r += 1) {
    const ry = y + 2 + r * 9;
    p.r(OAK.mid, x + 1, ry + 8, w - 2, 1);
    let bx = x + 3;
    for (let i = 0; bx < x + w - 4; i += 1) {
      const hv = hash(bx, r, f.x);
      const bw = 2 + (hv % 2);
      if (hv % 11 === 0 && bx < x + w - 14) { p.ellipse(LEAF.base, bx + 4, ry + 4, 4, 3); p.r(TERRA.base, bx + 2, ry + 5, 5, 3); bx += 10; continue; }
      if (hv % 7 !== 0) p.r(pick(spines, hv >>> 4), bx, ry + 1 + (hv % 3 === 0 ? 1 : 0), bw, 7 - (hv % 3 === 0 ? 1 : 0));
      bx += bw + (i % 6 === 5 ? 2 : 0);
    }
  }
}

/** A round café table with a pendant lamp above it and chairs on two sides (paint only). */
function cafeTable(p: Painter, f: MapObject): void {
  const cx = Math.round(f.x + f.width / 2);
  const cy = Math.round(f.y + f.height / 2);
  p.ellipse(INK, cx + 1, cy + 9, 11, 3, 0.18);
  p.ellipse(OAK.line, cx, cy, 13, 12); p.ellipse(CREAM.base, cx, cy - 1, 12, 10); p.ellipse(CREAM.light, cx - 2, cy - 4, 7, 4);
  p.r(TERRA.base, cx - 7, cy - 1, 4, 4); p.r(CREAM.light, cx - 7, cy - 1, 4, 1); p.r(0x5b3a29, cx - 6, cy, 2, 1); // cup
  p.r(CREAM.light, cx + 2, cy + 1, 6, 3); p.r(0xd9a05b, cx + 3, cy + 1, 4, 2); // plate with a pastry
  p.ellipse(0x2f3542, cx, cy - 6, 3, 2); p.r(GOLD_LIGHT, cx - 1, cy - 5, 3, 2); // pendant lamp from above
}

function coffeeTable(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  shadow(p, f);
  p.r(OAK.line, x + 2, y + 4, w - 4, h - 7); p.r(OAK.base, x + 3, y + 5, w - 6, h - 12); p.r(OAK.light, x + 3, y + 5, w - 6, 1); p.r(OAK.dark, x + 3, y + h - 7, w - 6, 3);
  p.r(CREAM.light, x + 10, y + 8, 12, 9); p.r(NAVY.light, x + 11, y + 9, 10, 2); p.r(CREAM.line, x + 11, y + 13, 8, 1); // magazine
  p.r(TERRA.base, x + w - 22, y + 8, 5, 5); p.r(CREAM.light, x + w - 22, y + 8, 5, 1); // mug
  p.r(SAGE.dark, x + w - 14, y + 9, 6, 6); p.ellipse(LEAF.base, x + w - 11, y + 8, 4, 3); // succulent
}

interface CabinetScheme { body: number; dark: number; light: number; trim: number }
const CABINETS: Record<string, [CabinetScheme, CabinetScheme]> = {
  tictactoe: [{ body: 0xd2452f, dark: 0x8f2a1c, light: 0xf07a55, trim: NEON.yellow }, { body: 0x1f8a7a, dark: 0x14594f, light: 0x4fc2ae, trim: NEON.orange }],
  memory: [{ body: 0x9a3fb0, dark: 0x66277a, light: 0xc978dc, trim: NEON.cyan }, { body: 0xd9478a, dark: 0x962c5c, light: 0xf58bb8, trim: NEON.lime }],
  puzzle: [{ body: 0x2f66c8, dark: 0x1e4290, light: 0x6e9af0, trim: NEON.pink }, { body: 0xe08a2a, dark: 0x9c5a14, light: 0xf7b765, trim: NEON.cyan }],
};
/** Each cabinet's own livery: by its game, alternating between the cabinets of the same game. */
function cabinetScheme(s: Scene, f: MapObject): CabinetScheme {
  const g = String(prop(f, 'game', ''));
  const nth = s.furniture.filter((o) => kindOf(o) === 'arcade' && String(prop(o, 'game', '')) === g && (o.x < f.x || (o.x === f.x && o.y < f.y))).length;
  return (CABINETS[g] ?? CABINETS.tictactoe!)[nth % 2]!;
}

/**
 * An arcade cabinet (1 x 2 tiles): lit marquee, dark screen with the game on it, joystick and
 * buttons, coin door. A prop. All artwork is original; the screens show the three campus games.
 */
function arcadeCabinet(p: Painter, f: MapObject, c: CabinetScheme): void {
  const { x, y, width: w, height: h } = f;
  const g = String(prop(f, 'game', ''));
  p.ellipse(INK, x + w / 2, y + h - 2, w / 2 + 3, 4, 0.26);
  p.r(NIGHT, x - 1, y - 13, w + 2, h + 12);
  p.r(c.body, x, y - 12, w, h + 9);
  p.r(c.dark, x + w - 5, y - 12, 5, h + 9); // side panel
  p.r(c.light, x, y - 12, 1, h + 9);
  p.r(c.trim, x + w - 6, y - 12, 1, h + 9, 0.85); // edge moulding
  for (let i = 0; i < 4; i += 1) p.r(c.trim, x + w - 4, y + 40 + i * 5, 3, 2, 0.8); // side stripes
  // Marquee: a lit panel with the game's emblem.
  p.r(NIGHT, x + 1, y - 11, w - 7, 10);
  p.r(c.trim, x + 2, y - 10, w - 9, 8); p.r(NEON.white, x + 2, y - 10, w - 9, 1, 0.6); p.r(c.dark, x + 2, y - 3, w - 9, 1, 0.5);
  if (g === 'memory') { p.r(NIGHT, x + 5, y - 9, 5, 6); p.r(c.body, x + 6, y - 8, 3, 4); p.r(NIGHT, x + 12, y - 9, 5, 6); p.r(NEON.white, x + 13, y - 8, 3, 4); p.r(c.body, x + 14, y - 7, 1, 2); p.r(NIGHT, x + 19, y - 7, 3, 1); p.r(NIGHT, x + 20, y - 8, 1, 3); }
  else if (g === 'puzzle') { for (let i = 0; i < 3; i += 1) { p.r(NIGHT, x + 5 + i * 6, y - 9, 5, 6); p.r(i === 1 ? c.light : c.body, x + 6 + i * 6, y - 8, 3, 4); } }
  else { p.r(NIGHT, x + 5, y - 9, 2, 2); p.r(NIGHT, x + 9, y - 9, 2, 2); p.r(NIGHT, x + 7, y - 7, 2, 2); p.r(NIGHT, x + 5, y - 5, 2, 2); p.r(NIGHT, x + 9, y - 5, 2, 2); p.r(NIGHT, x + 15, y - 9, 6, 6); p.r(c.trim, x + 17, y - 7, 2, 2); }
  p.r(c.dark, x + 2, y - 1, w - 9, 2); for (let i = x + 4; i < x + w - 9; i += 3) p.r(NIGHT, i, y - 1, 1, 1); // speaker
  // Screen: dark glass, the game, scanlines and a glare.
  const sx = x + 3;
  const sy = y + 3;
  p.r(NIGHT, x + 2, y + 2, w - 8, 22); p.r(0x141a3a, sx, sy, w - 10, 20);
  if (g === 'memory') {
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 2; j += 1) {
      const up = i === 1 && j === 0;
      p.r(up ? NEON.yellow : NEON.purple, sx + 2 + i * 7, sy + 2 + j * 9, 5, 7); p.r(up ? NEON.white : VIOLET.dark, sx + 3 + i * 7, sy + 3 + j * 9, 3, 5);
      if (up) p.r(NEON.pink, sx + 4 + i * 7, sy + 5, 1, 1);
    }
  } else if (g === 'puzzle') {
    const tiles = [NEON.cyan, NEON.pink, NEON.yellow, NEON.lime, NEON.orange, NEON.purple, NEON.cyan, NEON.pink];
    tiles.forEach((t, i) => { p.r(t, sx + 2 + (i % 3) * 6, sy + 1 + Math.floor(i / 3) * 6, 5, 5); p.r(NEON.white, sx + 2 + (i % 3) * 6, sy + 1 + Math.floor(i / 3) * 6, 5, 1, 0.5); });
  } else {
    p.r(NEON.lime, sx + 7, sy + 1, 1, 18); p.r(NEON.lime, sx + 14, sy + 1, 1, 18); p.r(NEON.lime, sx + 1, sy + 6, 20, 1); p.r(NEON.lime, sx + 1, sy + 13, 20, 1);
    for (const [ox, oy] of [[2, 1], [16, 8]] as const) { p.r(NEON.pink, sx + ox, sy + oy, 1, 1); p.r(NEON.pink, sx + ox + 3, sy + oy, 1, 1); p.r(NEON.pink, sx + ox + 1, sy + oy + 1, 2, 2); p.r(NEON.pink, sx + ox, sy + oy + 3, 1, 1); p.r(NEON.pink, sx + ox + 3, sy + oy + 3, 1, 1); }
    for (const [ox, oy] of [[9, 8], [2, 15]] as const) { p.r(NEON.cyan, sx + ox, sy + oy, 4, 4); p.r(0x141a3a, sx + ox + 1, sy + oy + 1, 2, 2); }
  }
  for (let yy = sy + 1; yy < sy + 20; yy += 2) p.r(INK, sx, yy, w - 10, 1, 0.16);
  p.r(0xffffff, sx + 1, sy + 1, 5, 1, 0.5); p.r(0xffffff, sx + 1, sy + 2, 2, 1, 0.35);
  // Control panel: joystick and three buttons.
  p.r(c.light, x + 1, y + 25, w - 6, 2); p.r(0x23263a, x + 1, y + 27, w - 6, 9); p.r(NIGHT, x + 1, y + 35, w - 6, 1);
  p.r(NIGHT, x + 5, y + 32, 5, 2); p.r(0xc9ced8, x + 7, y + 29, 1, 3); p.r(0xe5484d, x + 6, y + 27, 3, 3); p.r(0xffffff, x + 6, y + 27, 1, 1, 0.7);
  for (const [bx, by, col] of [[13, 30, NEON.yellow], [17, 32, NEON.cyan], [21, 30, NEON.pink]] as const) { p.r(NIGHT, x + bx, y + by + 1, 3, 3); p.r(col, x + bx, y + by, 3, 3); p.r(NEON.white, x + bx, y + by, 1, 1, 0.7); }
  // Front: a stripe, the coin door with two lit slots, the kick plate and a line of under-glow.
  p.r(c.trim, x + 2, y + 39, w - 9, 1); p.r(c.light, x + 2, y + 41, w - 9, 1);
  p.r(NIGHT, x + 7, y + 45, 13, 11); p.r(0x2b2f45, x + 8, y + 46, 11, 9);
  p.r(NEON.orange, x + 10, y + 48, 2, 4); p.r(NEON.orange, x + 15, y + 48, 2, 4); p.r(NIGHT, x + 10, y + 53, 7, 1);
  p.r(0x16182a, x, y + h - 7, w, 4); p.r(c.trim, x + 1, y + h - 3, w - 7, 1, 0.8);
}

function pingPong(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  shadow(p, f);
  p.r(0x1d4f3c, x, y + 2, w, h - 6); p.r(0x2a6b51, x + 2, y + 4, w - 4, h - 10);
  p.r(0xffffff, x + 2, y + 4, w - 4, 1); p.r(0xffffff, x + 2, y + h - 7, w - 4, 1); p.r(0xffffff, x + 2, y + 4, 1, h - 10); p.r(0xffffff, x + w - 3, y + 4, 1, h - 10);
  p.r(0xffffff, x + 2, y + Math.round(h / 2) - 2, w - 4, 1, 0.7);
  p.r(CREAM.light, x + Math.round(w / 2) - 1, y, 3, h - 2); p.r(0x9aa3af, x + Math.round(w / 2), y, 1, h - 2); // net
  p.r(0x22252f, x + 4, y + h - 4, 3, 3); p.r(0x22252f, x + w - 7, y + h - 4, 3, 3);
  p.ellipse(TERRA.base, x + 18, y + 18, 5, 5); p.r(OAK.dark, x + 21, y + 22, 6, 2); // paddle
  p.ellipse(0x1f3a7a, x + w - 20, y + 30, 5, 5); p.r(OAK.dark, x + w - 27, y + 34, 6, 2);
  p.r(0xffffff, x + w - 40, y + 14, 2, 2);
}

function chessTable(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  shadow(p, f);
  p.r(OAK.line, x + 2, y + 2, w - 4, h - 6); p.r(OAK.base, x + 3, y + 3, w - 6, h - 14); p.r(OAK.dark, x + 3, y + h - 11, w - 6, 6);
  const bx = x + 12;
  const by = y + 8;
  for (let r = 0; r < 8; r += 1) for (let c = 0; c < 8; c += 1) p.r((r + c) % 2 ? 0x6b4a2f : CREAM.base, bx + c * 5, by + r * 5, 5, 5);
  p.frame(OAK.deep, bx - 1, by - 1, 42, 42);
  for (let c = 0; c < 8; c += 1) { if (c % 3 !== 1) p.r(0x22252f, bx + 1 + c * 5, by + 6, 3, 3); if (c % 4 !== 2) p.r(0xf6f1e4, bx + 1 + c * 5, by + 31, 3, 3); }
  p.r(0x22252f, bx + 16, by + 1, 3, 3); p.r(0xf6f1e4, bx + 21, by + 36, 3, 3); p.r(GOLD, bx + 21, by + 36, 3, 1);
}


/** A board-game table: a Tic-Tac-Toe board or a spread of memory cards, with stools. */
function gameTable(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  shadow(p, f);
  p.r(OAK.line, x + 2, y + 2, w - 4, h - 6); p.r(OAK.base, x + 3, y + 3, w - 6, h - 14); p.r(OAK.light, x + 3, y + 3, w - 6, 1); p.r(OAK.dark, x + 3, y + h - 11, w - 6, 6);
  const g = String(prop(f, 'game', ''));
  const cx = x + w / 2;
  if (g === 'tictactoe') {
    const bx = cx - 18;
    p.r(CREAM.light, bx, y + 8, 36, 36); p.r(NAVY.base, bx + 11, y + 10, 2, 32); p.r(NAVY.base, bx + 23, y + 10, 2, 32); p.r(NAVY.base, bx + 2, y + 19, 32, 2); p.r(NAVY.base, bx + 2, y + 31, 32, 2);
    p.r(TERRA.base, bx + 3, y + 10, 6, 2); p.r(TERRA.base, bx + 5, y + 9, 2, 6); p.ellipse(LEAF.dark, bx + 18, y + 26, 3, 3); p.ellipse(CREAM.light, bx + 18, y + 26, 1, 1);
  } else {
    for (let i = 0; i < 4; i += 1) for (let j = 0; j < 3; j += 1) {
      const up = (i + j * 2) % 5 === 0;
      p.r(up ? CREAM.light : 0x8f3b76, cx - 21 + i * 11, y + 8 + j * 12, 9, 10); p.r(up ? GOLD : 0xb85a98, cx - 18 + i * 11, y + 11 + j * 12, 3, 3);
    }
  }
}

function beanbag(p: Painter, f: MapObject): void {
  const cx = Math.round(f.x + f.width / 2);
  const cy = Math.round(f.y + f.height / 2);
  const c = hash(f.x, f.y, 81) % 2 ? { base: 0x46b3a8, dark: 0x2f8a80, light: 0x7fd1c7 } : { base: GOLD, dark: 0xb5862f, light: GOLD_LIGHT };
  p.ellipse(INK, cx + 1, cy + 10, 13, 4, 0.18);
  p.ellipse(c.dark, cx, cy + 1, 14, 12); p.ellipse(c.base, cx - 1, cy, 12, 10); p.ellipse(c.light, cx - 4, cy - 4, 5, 3); p.ellipse(c.dark, cx + 2, cy + 3, 6, 4);
}

/** A tiered stone fountain with water and a few floating petals. */
function fountain(p: Painter, f: MapObject): void {
  const cx = Math.round(f.x + f.width / 2);
  const cy = Math.round(f.y + f.height / 2);
  const rx = Math.round(f.width / 2) - 4;
  const ry = Math.round(f.height / 2) - 10;
  p.ellipse(INK, cx + 2, cy + 6, rx + 2, ry + 2, 0.16);
  p.ellipse(STONE.dark, cx, cy + 4, rx, ry); p.ellipse(STONE.light, cx, cy, rx, ry); p.ellipse(STONE.mid, cx, cy + 1, rx - 4, ry - 4);
  p.ellipse(WATER.dark, cx, cy + 1, rx - 7, ry - 7); p.ellipse(WATER.base, cx, cy, rx - 8, ry - 8);
  for (let i = 0; i < 9; i += 1) { const h = hash(i, f.x, 82); p.r(WATER.light, cx - rx + 14 + (h % (rx * 2 - 28)), cy - ry + 12 + ((h >>> 8) % (ry * 2 - 22)), 4 + (h % 4), 1); }
  p.r(TERRA.light, cx - 22, cy + 10, 3, 2); p.r(0xf6f1e4, cx + 18, cy - 8, 3, 2); p.r(TERRA.light, cx + 26, cy + 6, 2, 2);
  // Upper basin and spout.
  p.ellipse(STONE.dark, cx, cy - 4, 18, 9); p.ellipse(STONE.light, cx, cy - 7, 18, 9); p.ellipse(WATER.base, cx, cy - 7, 13, 6); p.ellipse(WATER.light, cx - 3, cy - 9, 5, 2);
  p.r(STONE.mid, cx - 3, cy - 26, 6, 18); p.r(STONE.light, cx - 3, cy - 26, 2, 18); p.ellipse(STONE.light, cx, cy - 27, 6, 3);
  p.r(WATER.light, cx - 1, cy - 34, 2, 8); p.r(WATER.light, cx - 5, cy - 31, 2, 6, 0.8); p.r(WATER.light, cx + 3, cy - 31, 2, 6, 0.8);
}

function bench(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  shadow(p, f);
  p.r(0x3a3f4b, x + 3, y + h - 6, 3, 5); p.r(0x3a3f4b, x + w - 6, y + h - 6, 3, 5);
  p.r(OAK.deep, x + 1, y + 2, w - 2, 8); for (let i = 0; i < 2; i += 1) { p.r(OAK.base, x + 2, y + 3 + i * 4, w - 4, 3); p.r(OAK.light, x + 2, y + 3 + i * 4, w - 4, 1); }
  p.r(OAK.deep, x + 1, y + 12, w - 2, 12); for (let i = 0; i < 3; i += 1) { p.r(OAK.mid, x + 2, y + 13 + i * 4, w - 4, 3); p.r(OAK.light, x + 2, y + 13 + i * 4, w - 4, 1); }
  p.r(0x3a3f4b, x, y + 11, 3, 14); p.r(0x3a3f4b, x + w - 3, y + 11, 3, 14);
}

/** A raised flower bed: timber edge, soil, rows of flowers and leaves. */
function flowers(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  shadow(p, f);
  p.r(OAK.deep, x + 1, y + 2, w - 2, h - 4); p.r(0x5b3a29, x + 4, y + 5, w - 8, h - 12); p.r(OAK.mid, x + 1, y + 2, w - 2, 2);
  const blooms = [TERRA.light, 0xf6f1e4, GOLD_LIGHT, 0xe07a8f, 0xb79ce0];
  for (let yy = y + 6; yy < y + h - 9; yy += 6) for (let xx = x + 5; xx < x + w - 7; xx += 6) {
    const hv = hash(xx, yy, 83);
    p.r(LEAF.dark, xx, yy + 2, 4, 3); p.r(LEAF.base, xx + 1, yy + 1, 2, 2);
    const c = pick(blooms, hv);
    p.r(c, xx + (hv % 3), yy - 1, 3, 3); p.r(GOLD, xx + 1 + (hv % 3), yy, 1, 1);
  }
}

function lounger(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  shadow(p, f);
  p.r(OAK.deep, x + 3, y + 2, w - 6, h - 5);
  p.r(0xf6f1e4, x + 4, y + 3, w - 8, h - 7); for (let i = y + 5; i < y + h - 6; i += 6) p.r(0x46b3a8, x + 4, i, w - 8, 2);
  p.r(CREAM.light, x + 6, y + 4, w - 12, 8); p.r(CREAM.dark, x + 6, y + 11, w - 12, 1); // pillow
}

/** A broad tree (2 x 2 footprint): trunk on the footprint, canopy above it. A prop. */
function tree(p: Painter, f: MapObject): void {
  const cx = Math.round(f.x + f.width / 2);
  const base = f.y + f.height;
  p.ellipse(INK, cx + 3, base - 6, 26, 8, 0.2);
  p.r(0x6b4a2f, cx - 5, base - 30, 10, 26); p.r(0x8a6440, cx - 5, base - 30, 3, 26); p.r(0x4f3522, cx + 3, base - 30, 2, 26);
  p.r(0x6b4a2f, cx - 9, base - 7, 18, 3);
  const top = base - 34;
  p.ellipse(LEAF.deep, cx, top, 30, 25);
  p.ellipse(LEAF.dark, cx - 4, top - 3, 26, 21);
  p.ellipse(LEAF.base, cx - 10, top - 8, 14, 11); p.ellipse(LEAF.base, cx + 9, top - 2, 13, 10); p.ellipse(LEAF.base, cx - 2, top + 8, 12, 8);
  p.ellipse(LEAF.light, cx - 13, top - 12, 6, 4); p.ellipse(LEAF.light, cx + 6, top - 7, 5, 3); p.ellipse(LEAF.light, cx - 4, top + 4, 4, 2);
  for (let i = 0; i < 10; i += 1) { const hv = hash(i, f.x + f.y, 84); p.r(LEAF.deep, cx - 22 + (hv % 44), top - 16 + ((hv >>> 8) % 30), 2, 2); }
}

/** Kind -> painter for the campus furniture (ADR 055). */
/** FR-VO-019: a swimming pool: stone deck, tiled water, lane ropes, steps at the shallow end, a ladder. */
function pool(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  p.r(STONE.dark, x, y, w, h);
  p.r(STONE.light, x + 1, y + 1, w - 2, h - 2);
  for (let i = x + 4; i < x + w - 4; i += 12) { p.r(STONE.mid, i, y + 2, 1, 6); p.r(STONE.mid, i + 6, y + h - 8, 1, 6); }
  const ix = x + 9; const iy = y + 9; const iw = w - 18; const ih = h - 18;
  p.r(0x2f7fa6, ix - 1, iy - 1, iw + 2, ih + 2);
  p.r(WATER.base, ix, iy, iw, ih);
  p.r(WATER.mid, ix, iy, iw, 4); // shade under the coping
  for (let gx = ix + 8; gx < ix + iw; gx += 8) p.r(WATER.light, gx, iy + 4, 1, ih - 4, 0.35);
  for (let gy = iy + 8; gy < iy + ih; gy += 8) p.r(WATER.light, ix, gy, iw, 1, 0.35);
  for (let k = 1; k < 3; k += 1) { // lane ropes
    const ly = iy + Math.round((ih * k) / 3);
    for (let lx = ix + 2; lx < ix + iw - 2; lx += 6) p.r((lx / 6) % 2 ? 0xe5484d : 0xffffff, lx, ly - 1, 4, 2);
  }
  for (let k = 0; k < 3; k += 1) p.r(WATER.light, ix + k * 6, iy + 2 + k * 4, 6, ih - 4 - k * 8, 0.25); // steps
  p.r(0xc0c6ce, ix + iw - 10, iy - 6, 2, 12); p.r(0xc0c6ce, ix + iw - 4, iy - 6, 2, 12); // ladder
  for (let k = 0; k < 3; k += 1) p.r(0xe5e7eb, ix + iw - 10, iy - 2 + k * 3, 8, 1);
}

/** FR-VO-019: a garden pond: pebble rim, water, lily pads with a flower, reeds. */
function pond(p: Painter, f: MapObject): void {
  const cx = Math.round(f.x + f.width / 2);
  const cy = Math.round(f.y + f.height / 2);
  const rx = Math.round(f.width / 2) - 2;
  const ry = Math.round(f.height / 2) - 2;
  p.ellipse(INK, cx + 1, cy + 2, rx, ry, 0.15);
  p.ellipse(STONE.dark, cx, cy, rx, ry);
  p.ellipse(STONE.mid, cx, cy, rx - 2, ry - 2);
  for (let i = 0; i < 26; i += 1) { const a = (i / 26) * Math.PI * 2; p.r(pick([STONE.light, STONE.base, 0x9a8d74], i), Math.round(cx + Math.cos(a) * (rx - 3)) - 2, Math.round(cy + Math.sin(a) * (ry - 3)) - 1, 4, 3); }
  p.ellipse(WATER.dark, cx, cy, rx - 7, ry - 6);
  p.ellipse(WATER.mid, cx - 2, cy - 1, rx - 10, ry - 9);
  p.ellipse(WATER.base, cx - 6, cy - 4, Math.max(4, rx - 22), Math.max(3, ry - 16));
  for (const [dx, dy] of [[-28, 6], [20, -6], [6, 10]] as const) {
    p.ellipse(LEAF.dark, cx + dx, cy + dy, 7, 5); p.ellipse(LEAF.base, cx + dx - 1, cy + dy - 1, 6, 4); p.r(WATER.mid, cx + dx + 1, cy + dy - 1, 6, 2);
  }
  p.r(0xf6a5b5, cx + 18, cy - 9, 4, 3); p.r(0xffffff, cx + 19, cy - 9, 2, 1); p.r(GOLD_LIGHT, cx + 19, cy - 8, 2, 1);
  for (let i = 0; i < 6; i += 1) { const rx2 = cx + rx - 14 + i * 2; p.r(LEAF.dark, rx2, cy - ry + 4 + (i % 3), 1, 12); p.r(0x8a5a35, rx2, cy - ry + 3 + (i % 3), 1, 3); }
}

const CAMPUS: Record<string, (p: Painter, f: MapObject) => void> = {
  'coffee-counter': coffeeCounter, bookshelf, 'cafe-table': cafeTable, 'coffee-table': coffeeTable,
  'ping-pong': pingPong, 'chess-table': chessTable, 'game-table': gameTable, beanbag, fountain, bench, flowers, lounger, tree, pool, pond,
};

/** How far a tall prop reaches beyond its footprint (left, top, right, bottom), for its atlas box. */
function propBox(f: MapObject): Rect {
  const kind = kindOf(f);
  if (kind === 'tree') return { x: f.x - 18, y: f.y - 64, width: f.width + 36, height: f.height + 66 };
  if (kind === 'arcade') return { x: f.x - 6, y: f.y - 14, width: f.width + 12, height: f.height + 18 };
  return { x: f.x - 8, y: f.y - 24, width: f.width + 16, height: f.height + 26 };
}

/** Small plants tucked into free room corners (never the label corner, a doorway or furniture). */
function cornerPlants(p: Painter, s: Scene, view: Rect): void {
  for (const room of s.rooms) {
    const x0 = Math.round(room.x / T);
    const y0 = Math.round(room.y / T);
    const x1 = Math.round((room.x + room.width) / T) - 1;
    const y1 = Math.round((room.y + room.height) / T) - 1;
    const corners: Array<[number, number]> = room.type === 'OPEN' ? [[x0, y1], [x1, y1], [x1, y0]] : [[x1, y0], [x0, y1]];
    for (const [tx, ty] of corners) {
      const r = { x: tx * T, y: ty * T, width: T, height: T };
      if (!clear(s, r) || !overlaps(view, r, 8)) continue;
      // Only a real corner: walls on two sides, and no doorway next to it.
      const sides = [s.wall(tx - 1, ty) || s.wall(tx + 1, ty), s.wall(tx, ty - 1) || s.wall(tx, ty + 1)];
      const nearDoor = s.doors.has(ty * s.w + tx + 1) || s.doors.has(ty * s.w + tx - 1) || s.doors.has((ty + 1) * s.w + tx) || s.doors.has((ty - 1) * s.w + tx);
      if (sides[0] && sides[1] && !nearDoor) pottedPlant(p, tx * T + 16, ty * T + 29, false);
    }
  }
}

// ---------------------------------------------------------------- the whole scene

function paint(p: Painter, s: Scene, view: Rect): void {
  const tx0 = Math.max(0, Math.floor(view.x / T) - 1);
  const ty0 = Math.max(0, Math.floor(view.y / T) - 1);
  const tx1 = Math.min(s.w - 1, Math.floor((view.x + view.width) / T) + 1);
  const ty1 = Math.min(s.h - 1, Math.floor((view.y + view.height) / T) + 1);
  const tiles = (fn: (tx: number, ty: number) => void) => { for (let ty = ty0; ty <= ty1; ty += 1) for (let tx = tx0; tx <= tx1; tx += 1) fn(tx, ty); };
  tiles((tx, ty) => { if (!s.wall(tx, ty)) floorTile(p, s, tx, ty); });
  tiles((tx, ty) => { const d = s.doors.get(ty * s.w + tx); if (d) doorSill(p, tx, ty, d); });
  tiles((tx, ty) => wallShadow(p, s, tx, ty));
  lighting(p, s, view);
  tiles((tx, ty) => daylight(p, s, tx, ty));
  tiles((tx, ty) => campusLights(p, s, tx, ty));
  rugs(p, s, view);
  tiles((tx, ty) => { if (s.wall(tx, ty)) wallTile(p, s, tx, ty); });
  for (const piece of s.pieces) if (overlaps(view, { x: piece.x, y: piece.y, width: piece.width, height: 14 }, 2)) wallPiece(p, piece);
  tiles((tx, ty) => wallDecor(p, s, tx, ty));
  for (const g of s.signs) if (overlaps(view, g, 2)) neonSign(p, g);
  chairs(p, s, view);
  for (const f of [...s.furniture].sort((a, b) => a.y + a.height - (b.y + b.height))) if (!isTall(f) && overlaps(view, f, 16)) furnitureItem(p, s, f);
  cornerPlants(p, s, view);
}

export interface EnvironmentChunk { canvas: HTMLCanvasElement; x: number; y: number }
export interface Environment {
  chunks: EnvironmentChunk[];
  /** Tall pieces (trees, cabinets, plants) in one atlas, each sorted with the avatars by its base. */
  props: { canvas: HTMLCanvasElement; sprites: AtlasSprite[] } | null;
}

/** The whole static scene of one floor: floor chunks of at most ENV_CHUNK px, and the tall props. */
export function renderEnvironment(map: OfficeMap): Environment {
  const scene = buildScene(map);
  const pieces: AtlasPiece[] = scene.furniture.filter(isTall).map((f) => ({ ...propBox(f), depth: f.y + f.height, draw: (p) => furnitureItem(p, scene, f) }));
  return { chunks: renderChunks(map, scene), props: buildAtlas(pieces) };
}

function renderChunks(map: OfficeMap, scene: Scene): EnvironmentChunk[] {
  const width = map.width * T;
  const height = map.height * T;
  const chunks: EnvironmentChunk[] = [];
  for (let y = 0; y < height; y += ENV_CHUNK) {
    for (let x = 0; x < width; x += ENV_CHUNK) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(ENV_CHUNK, width - x);
      canvas.height = Math.min(ENV_CHUNK, height - y);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.imageSmoothingEnabled = false;
        ctx.translate(-x, -y);
        paint(new Painter(ctx), scene, { x, y, width: canvas.width, height: canvas.height });
      }
      chunks.push({ canvas, x, y });
    }
  }
  return chunks;
}
