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
 * Paint order: floors, door sills, wall shadows, light, rugs, walls, wall decor, chairs,
 * furniture, corner plants. Variation is a hash of the tile position, so a map always looks the same.
 *
 * ADR 055: tall things (trees, arcade cabinets, potted plants) are not painted into the floor
 * chunks but into one atlas of "props" that the renderer sorts with the avatars by their base, so
 * a person walking behind a tree is hidden by its canopy and one walking in front is not.
 */
import { objectLayer, prop, TILE_SIZE, tileLayer } from '@hrvo/shared';
import type { MapObject, OfficeMap } from '@hrvo/shared';
import {
  BLUE, buildAtlas, CREAM, GLASS, GOLD, GOLD_LIGHT, GRASS, hash, INK, LEAF, LIGHT, MAPLE, NAVY, OAK, overlaps, Painter, pick, SAGE, STONE, TERRA, WATER,
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
  /** Things hung on wall faces, planned once: whiteboards, bookshelves, the reception plaque. */
  pieces: WallPiece[];
  /** Wall-face tiles those pieces use (no window or picture there). */
  faceUsed: Set<number>;
}

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
  const scene: Scene = { map, w, h, floor, wall, open, taken, doors, rooms, desks: objectLayer(map, 'desks'), furniture, pieces: [], faceUsed: new Set() };
  planWallPieces(scene);
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
    case FLOOR.CARPET: // sage carpet tiles with a short weave
      p.r(alt ? SAGE.base : SAGE.mid, x, y, T, T);
      speckle(12, SAGE.light, 0xb4c3ae, 1);
      p.r(0xb1c1ab, x + T - 1, y, 1, T, 0.6);
      p.r(0xb1c1ab, x, y + T - 1, T, 1, 0.6);
      break;
    case FLOOR.WOOD: // oak boards
      woodPlanks(p, x, y, [OAK.light, OAK.base, OAK.base, OAK.mid], OAK.dark, 2);
      break;
    case FLOOR.MEETING: // cool carpet tiles with a small woven motif
      p.r(alt ? BLUE.base : BLUE.mid, x, y, T, T);
      speckle(8, BLUE.light, BLUE.line, 3);
      p.r(BLUE.line, x + 15, y + 13, 2, 6, 0.7); p.r(BLUE.line, x + 13, y + 15, 6, 2, 0.7);
      p.r(BLUE.light, x + 15, y + 15, 2, 2);
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
    case FLOOR.RECEPTION: // ivory stone with sage inlays where four tiles meet
      p.r(pick([CREAM.base, CREAM.base, 0xf0e6d2, 0xf6eede], hash(tx, ty, 5)), x, y, T, T);
      p.r(CREAM.light, x, y, T - 1, 1); p.r(CREAM.light, x, y, 1, T - 1);
      p.r(CREAM.dark, x + T - 1, y, 1, T); p.r(CREAM.dark, x, y + T - 1, T, 1);
      { const h = hash(tx, ty, 6); p.r(CREAM.mid, x + 4 + (h % 20), y + 5 + ((h >>> 6) % 20), 5, 1); p.r(CREAM.mid, x + 6 + ((h >>> 12) % 18), y + 9 + ((h >>> 3) % 16), 3, 1); }
      for (const [cx, cy] of [[0, 0], [T - 2, 0], [0, T - 2], [T - 2, T - 2]] as const) p.r(SAGE.dark, x + cx, y + cy, 2, 2);
      break;
    case FLOOR.GRASS: { // lawn with tufts and the odd flower
      p.r(pick([GRASS.base, GRASS.base, GRASS.mid, GRASS.light], hash(tx, ty, 61)), x, y, T, T);
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
    case FLOOR.CAFE: { // terracotta and cream tiles, a cream diamond every other tile
      for (let j = 0; j < 2; j += 1) for (let i = 0; i < 2; i += 1) {
        const cream = (tx * 2 + i + ty * 2 + j) % 4 === 0;
        p.r(cream ? CREAM.base : pick([TERRA.light, 0xd99475, 0xd48d6e], hash(tx * 2 + i, ty * 2 + j, 65)), x + i * 16, y + j * 16, 16, 16);
        p.r(cream ? CREAM.light : 0xe6ab90, x + i * 16, y + j * 16, 15, 1);
        p.r(cream ? CREAM.dark : TERRA.mid, x + i * 16 + 15, y + j * 16, 1, 16); p.r(cream ? CREAM.dark : TERRA.mid, x + i * 16, y + j * 16 + 15, 16, 1);
      }
      break;
    }
    case FLOOR.ARCADE: { // deep carpet with a retro confetti pattern
      p.r(alt ? 0x2b2f52 : 0x292c4d, x, y, T, T);
      const shapes = [0x46b3a8, GOLD, TERRA.light, 0x8f7bd6];
      for (let i = 0; i < 4; i += 1) {
        const h = hash(tx * 5 + i, ty * 11 + i, 66);
        const sx = x + 2 + (h % 26);
        const sy = y + 2 + ((h >>> 6) % 26);
        const c = pick(shapes, h >>> 12);
        if (h % 3 === 0) { p.r(c, sx, sy, 3, 1); p.r(c, sx + 1, sy + 1, 1, 1); }
        else if (h % 3 === 1) { p.r(c, sx, sy, 1, 3); p.r(c, sx + 1, sy + 1, 2, 1); }
        else p.r(c, sx, sy, 2, 2);
      }
      p.r(0x3a3f6b, x, y, T, 1, 0.6);
      break;
    }
    default: // unknown style: a neutral stone tile
      p.r(alt ? 0xe6e2da : 0xe0dcd3, x, y, T, T);
      p.r(0xcfcabf, x + T - 1, y, 1, T); p.r(0xcfcabf, x, y + T - 1, T, 1);
  }
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
    // Front face: warm ivory panelling over an oak skirting board.
    const fy = y + CAP;
    p.r(CREAM.mid, x, fy, T, T - CAP - 4);
    p.r(CREAM.line, x, fy, T, 2); // shade under the coping
    p.r(CREAM.base, x, fy + 2, T, 1);
    p.r(CREAM.dark, x + 15, fy + 3, 1, T - CAP - 7); // panel seam
    p.r(CREAM.dark, x, fy + 11, T, 1, 0.55); // dado line
    p.r(OAK.deep, x, y + T - 4, T, 4);
    p.r(OAK.mid, x, y + T - 4, T, 1);
    p.r(OAK.line, x, y + T - 1, T, 1);
    if (!we) p.r(CREAM.line, x, fy, 1, T - CAP - 4);
    if (!e) p.r(CREAM.line, x + T - 1, fy, 1, T - CAP - 4);
    if ((s.floor[(ty + 1) * s.w + tx] ?? 0) === FLOOR.GRASS) ivy(p, tx, ty);
  }
  // Door frames: an oak jamb on the wall end beside a doorway (the opening itself is untouched).
  const door = (dx: number, dy: number) => s.doors.has((ty + dy) * s.w + tx + dx);
  if (door(-1, 0)) { p.r(OAK.deep, x, y, 3, T); p.r(OAK.light, x + 2, y, 1, T); p.r(OAK.line, x, y, 1, T); }
  if (door(1, 0)) { p.r(OAK.deep, x + T - 3, y, 3, T); p.r(OAK.light, x + T - 3, y, 1, T); p.r(OAK.line, x + T - 1, y, 1, T); }
  if (door(0, -1)) { p.r(OAK.deep, x, y, T, 3); p.r(OAK.light, x, y + 2, T, 1); p.r(OAK.line, x, y, T, 1); }
  if (door(0, 1)) { p.r(OAK.deep, x, y + T - 3, T, 3); p.r(OAK.light, x, y + T - 3, T, 1); p.r(OAK.line, x, y + T - 1, T, 1); }
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
  if (!plainFace(s, tx, ty)) return;
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
  // Inner wall: now and then a framed picture or a clock.
  const h = hash(tx, ty, 21);
  if (h % 7 !== 0 || plainFace(s, tx - 1, ty) && hash(tx - 1, ty, 21) % 7 === 0) return;
  const kind = (h >>> 5) % 5 === 4 ? 2 : (h >>> 5) % 2;
  if (kind === 2) { // clock
    p.ellipse(OAK.deep, x + 16, fy + 8, 6, 6); p.ellipse(CREAM.light, x + 16, fy + 8, 4, 4);
    p.r(NAVY.deep, x + 16, fy + 5, 1, 4); p.r(NAVY.deep, x + 16, fy + 8, 3, 1);
    return;
  }
  p.r(kind ? OAK.deep : GOLD, x + 8, fy + 2, 16, 12); p.r(CREAM.light, x + 9, fy + 3, 14, 10);
  if (kind === 0) { // hills at dusk
    p.r(0xf2c79a, x + 10, fy + 4, 12, 4); p.r(TERRA.light, x + 17, fy + 5, 3, 2);
    p.r(SAGE.deep, x + 10, fy + 8, 12, 4); p.r(LEAF.dark, x + 10, fy + 9, 5, 3); p.r(LEAF.base, x + 15, fy + 10, 7, 2);
  } else { // abstract blocks
    p.r(NAVY.base, x + 10, fy + 4, 5, 8); p.r(TERRA.base, x + 16, fy + 4, 6, 4); p.r(SAGE.dark, x + 16, fy + 9, 6, 3);
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
    // Warm light reads as grey haze on the dark arcade carpet: the arcade glows from its cabinets instead.
    const floorAt = s.floor[Math.floor((r.y + r.height / 2) / T) * s.w + Math.floor((r.x + r.width / 2) / T)] ?? 0;
    if (floorAt === FLOOR.ARCADE) continue;
    lightPool(p, Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2), Math.round(Math.min(r.width * 0.42, 300)), Math.round(Math.min(r.height * 0.4, 130)));
  }
  for (const d of s.desks) {
    if (overlaps(view, d, 48)) lightPool(p, Math.round(d.x + d.width / 2), Math.round(d.y + d.height / 2 + 4), 52, 30);
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
    if (isBigTable(s, f)) {
      // Under a meeting table, kept inside its room.
      const room = s.rooms.find((r) => overlaps(r, f));
      let r: Rect = { x: f.x - 40, y: f.y - 34, width: f.width + 80, height: f.height + 68 };
      if (room) {
        const x0 = Math.max(r.x, room.x + 20);
        const y0 = Math.max(r.y, room.y + 26);
        r = { x: x0, y: y0, width: Math.min(r.x + r.width, room.x + room.width - 20) - x0, height: Math.min(r.y + r.height, room.y + room.height - 14) - y0 };
      }
      if (r.width > f.width && r.height > f.height && overlaps(view, r, 2)) rug(p, r.x, r.y, r.width, r.height, TERRA.mid, 0xe6c3a8, TERRA.light);
    } else if (kind === 'sofa' && f.width >= f.height) {
      const r = { x: f.x + 8, y: f.y + f.height + 6, width: f.width - 16, height: 44 };
      if (clear(s, r) && overlaps(view, r, 2)) rug(p, r.x, r.y, r.width, r.height, SAGE.deep, 0xdfe8da, SAGE.dark);
    } else if (kind === 'counter') {
      const r = { x: f.x + 24, y: f.y + f.height + 10, width: f.width - 48, height: 22 };
      if (r.width > 40 && clear(s, r) && overlaps(view, r, 2)) rug(p, r.x, r.y, r.width, r.height, NAVY.light, 0xb9c6dc, GOLD);
    }
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

function chairs(p: Painter, s: Scene, view: Rect): void {
  // One at every desk seat (the lower half of the desk area), facing the desk.
  for (const d of s.desks) {
    if (!overlaps(view, d, 8) || d.height < 2 * T) continue;
    chair(p, Math.round(d.x + d.width / 2), Math.round(d.y + d.height - T / 2 + 1), 'bottom', SAGE.deep, 0x667d64, SAGE.dark);
  }
  // Round the meeting tables, where the floor beside them is free.
  for (const f of s.furniture) {
    if (!isBigTable(s, f) || !overlaps(view, f, T)) continue;
    for (let cx = f.x + T / 2; cx < f.x + f.width; cx += T) {
      const tx = Math.floor(cx / T);
      const above = Math.floor((f.y - 1) / T);
      const below = Math.floor((f.y + f.height) / T);
      if (s.open(tx, above) && !s.taken.has(above * s.w + tx)) chair(p, cx, f.y - 10, 'top', NAVY.light, NAVY.mid, 0x6f84ab);
      if (s.open(tx, below) && !s.taken.has(below * s.w + tx)) chair(p, cx, f.y + f.height + 9, 'bottom', NAVY.light, NAVY.mid, 0x6f84ab);
    }
  }
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

function sofa(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  p.r(INK, x + 2, y + h - 1, w - 3, 4, 0.18);
  p.r(TERRA.deep, x, y + 1, w, h - 2);
  p.r(TERRA.mid, x + 1, y + 2, w - 2, 10); // back rest
  p.r(TERRA.light, x + 2, y + 2, w - 4, 1);
  p.r(TERRA.dark, x + 1, y + 11, w - 2, 1);
  p.r(TERRA.mid, x + 1, y + 2, 7, h - 6); p.r(TERRA.mid, x + w - 8, y + 2, 7, h - 6); // arms
  p.r(TERRA.light, x + 2, y + 2, 5, 1); p.r(TERRA.light, x + w - 7, y + 2, 5, 1);
  const inner = w - 18;
  const n = Math.max(1, Math.round(inner / 46));
  const cw = inner / n;
  for (let i = 0; i < n; i += 1) {
    const cx = Math.round(x + 9 + i * cw);
    const cwi = Math.round(x + 9 + (i + 1) * cw) - cx;
    p.r(TERRA.base, cx, y + 12, cwi - 1, h - 17);
    p.r(TERRA.light, cx, y + 12, cwi - 1, 1);
    p.r(TERRA.dark, cx + cwi - 1, y + 12, 1, h - 17);
  }
  p.r(TERRA.dark, x + 1, y + h - 5, w - 2, 3); // front edge
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
  else if (CAMPUS[kind]) CAMPUS[kind]!(p, f);
  else if (kind === 'sofa' && f.width >= f.height && f.width >= 48) sofa(p, f);
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
  for (const dx of [-21, 21]) {
    p.r(INK, cx + dx - 6, cy + 7, 12, 2, 0.14);
    p.r(OAK.deep, cx + dx - 6, cy - 6, 12, 12); p.r(OAK.base, cx + dx - 5, cy - 5, 10, 10); p.r(OAK.light, cx + dx - 5, cy - 5, 10, 1);
    p.r(OAK.deep, cx + dx + (dx < 0 ? -6 : 3), cy - 7, 3, 14);
  }
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

/** An arcade cabinet (1 x 2 tiles): marquee, glowing screen, joystick and buttons. A prop. */
function arcadeCabinet(p: Painter, f: MapObject): void {
  const { x, y, width: w, height: h } = f;
  const g = String(prop(f, 'game', ''));
  const body = g === 'memory' ? 0x8f3b76 : g === 'puzzle' ? 0x2f6f8f : 0xb5452f;
  const bodyDark = g === 'memory' ? 0x652a54 : g === 'puzzle' ? 0x214e65 : 0x7f3020;
  const screen = g === 'memory' ? 0xf5c6e0 : g === 'puzzle' ? 0xbfe6f2 : 0xc9f2c3;
  p.ellipse(INK, x + w / 2, y + h - 2, w / 2 + 3, 4, 0.22);
  p.r(INK, x - 1, y - 12, w + 2, h + 11, 0.85);
  p.r(body, x, y - 11, w, h + 8); p.r(bodyDark, x + w - 5, y - 11, 5, h + 8);
  p.r(GOLD_LIGHT, x + 2, y - 9, w - 6, 7); p.r(bodyDark, x + 4, y - 7, w - 10, 1); p.r(bodyDark, x + 4, y - 5, w - 14, 1); // marquee
  p.r(0x14162a, x + 2, y + 1, w - 6, 22); p.r(screen, x + 4, y + 3, w - 10, 18);
  // Little game art on the screen.
  if (g === 'tictactoe') { p.r(0x2f6d3a, x + 11, y + 4, 1, 16); p.r(0x2f6d3a, x + 17, y + 4, 1, 16); p.r(0x2f6d3a, x + 5, y + 9, 20, 1); p.r(0x2f6d3a, x + 5, y + 15, 20, 1); p.r(TERRA.dark, x + 6, y + 5, 3, 3); }
  else if (g === 'memory') { for (let i = 0; i < 3; i += 1) for (let j = 0; j < 2; j += 1) p.r(i === 1 && j === 0 ? GOLD : 0x8f3b76, x + 6 + i * 7, y + 5 + j * 8, 5, 6); }
  else { for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) if (i + j < 4) p.r(0x2f6f8f, x + 6 + i * 6, y + 5 + j * 5, 5, 4); }
  p.r(0xffffff, x + 5, y + 4, 4, 1, 0.6);
  p.r(bodyDark, x + 1, y + 25, w - 4, 10); // control panel
  p.r(0x22252f, x + 6, y + 27, 3, 5); p.r(TERRA.light, x + 5, y + 26, 5, 2);
  p.r(GOLD, x + 14, y + 28, 3, 3); p.r(0x46b3a8, x + 19, y + 28, 3, 3);
  p.r(bodyDark, x + 3, y + 37, w - 8, h - 41); p.r(0x14162a, x + 8, y + h - 14, w - 18, 4); // coin door
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
  chairTop(p, x + w / 2, y - 8); chairBottom(p, x + w / 2, y + h + 6);
}

const chairTop = (p: Painter, cx: number, cy: number) => { p.r(NAVY.mid, cx - 6, cy - 5, 12, 11); p.r(NAVY.light, cx - 5, cy - 4, 10, 8); p.r(NAVY.mid, cx - 6, cy - 6, 12, 4); };
const chairBottom = (p: Painter, cx: number, cy: number) => { p.r(INK, cx - 6, cy + 6, 12, 2, 0.14); p.r(NAVY.mid, cx - 6, cy - 5, 12, 11); p.r(NAVY.light, cx - 5, cy - 4, 10, 8); p.r(NAVY.mid, cx - 6, cy + 2, 12, 4); };

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
  chairTop(p, cx, y - 8); chairBottom(p, cx, y + h + 6);
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
const CAMPUS: Record<string, (p: Painter, f: MapObject) => void> = {
  'coffee-counter': coffeeCounter, bookshelf, 'cafe-table': cafeTable, 'coffee-table': coffeeTable, arcade: arcadeCabinet,
  'ping-pong': pingPong, 'chess-table': chessTable, 'game-table': gameTable, beanbag, fountain, bench, flowers, lounger, tree,
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
