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
 */
import { objectLayer, prop, TILE_SIZE, tileLayer } from '@hrvo/shared';
import type { MapObject, OfficeMap } from '@hrvo/shared';

const T = TILE_SIZE;
/** Chunk edge in px: well under every GPU's texture limit, also for the largest map (200 tiles). */
export const ENV_CHUNK = 1024;

// ---------------------------------------------------------------- palette
// Warm oak, deep navy, cream and ivory, sage, muted terracotta, foliage green, golden light.
// Floors stay light enough for the avatars' dark name labels.

const OAK = { light: 0xd9b384, base: 0xcba274, mid: 0xbf9566, dark: 0xa87d50, deep: 0x8a6440, line: 0x74522f };
const NAVY = { light: 0x4a5d82, base: 0x2e3d5a, mid: 0x26334d, deep: 0x1a2438 };
const CREAM = { light: 0xfbf6ea, base: 0xf3ead8, mid: 0xe9dec7, dark: 0xd8cbb0, line: 0xc7b998 };
const SAGE = { light: 0xd3dece, base: 0xc8d4c2, mid: 0xc2cfbc, dark: 0x9db39a, deep: 0x7f977c };
const TERRA = { light: 0xdb9a7c, base: 0xc47a5a, mid: 0xb56c4c, dark: 0x9c5a3c, deep: 0x7f4630 };
const LEAF = { light: 0x86c074, base: 0x5c9a55, dark: 0x3d7242, deep: 0x2c5534 };
const BLUE = { light: 0xd9e1ea, base: 0xcfd8e3, mid: 0xc6d0dc, line: 0xb7c3d2 };
const MAPLE = { light: 0xe9d3b0, base: 0xe2c9a3, mid: 0xdabf97, line: 0xc6a779 };
const GOLD = 0xd9a94e;
const GLASS = { base: 0xa9d3e8, light: 0xd8eef8, dark: 0x86b9d3 };
const LIGHT = 0xffd27a;
const INK = 0x000000;

/** Floor styles of the map (packages/shared default-map FLOOR). Anything else gets the fallback. */
const FLOOR = { CARPET: 1, WOOD: 2, MEETING: 3, PRIVATE: 4, RECEPTION: 5 } as const;

// ---------------------------------------------------------------- helpers

/** Deterministic hash of a position (and a salt): the only source of variation. */
function hash(x: number, y: number, salt = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

const pick = <V>(items: readonly V[], h: number): V => items[h % items.length]!;

/** Whole-pixel fills only, so every edge stays crisp. */
class Painter {
  private colour = -1;
  private alpha = 1;
  private readonly ctx: CanvasRenderingContext2D;
  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
  }
  r(colour: number, x: number, y: number, w: number, h: number, alpha = 1): void {
    if (w <= 0 || h <= 0) return;
    if (colour !== this.colour) { this.ctx.fillStyle = `#${colour.toString(16).padStart(6, '0')}`; this.colour = colour; }
    if (alpha !== this.alpha) { this.ctx.globalAlpha = alpha; this.alpha = alpha; }
    this.ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }
  /** A filled ellipse as one span per row (no anti-aliased curve). */
  ellipse(colour: number, cx: number, cy: number, rx: number, ry: number, alpha = 1): void {
    for (let dy = -ry; dy <= ry; dy += 1) {
      const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - (dy * dy) / (ry * ry + 0.5))));
      this.r(colour, cx - half, cy + dy, half * 2 + 1, 1, alpha);
    }
  }
  /** A 1 px frame. */
  frame(colour: number, x: number, y: number, w: number, h: number): void {
    this.r(colour, x, y, w, 1); this.r(colour, x, y + h - 1, w, 1); this.r(colour, x, y, 1, h); this.r(colour, x + w - 1, y, 1, h);
  }
}

interface Rect { x: number; y: number; width: number; height: number }
const overlaps = (a: Rect, b: Rect, pad = 0): boolean => a.x - pad < b.x + b.width && a.x + a.width + pad > b.x && a.y - pad < b.y + b.height && a.y + a.height + pad > b.y;

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
  }
  // Door frames: an oak jamb on the wall end beside a doorway (the opening itself is untouched).
  const door = (dx: number, dy: number) => s.doors.has((ty + dy) * s.w + tx + dx);
  if (door(-1, 0)) { p.r(OAK.deep, x, y, 3, T); p.r(OAK.light, x + 2, y, 1, T); p.r(OAK.line, x, y, 1, T); }
  if (door(1, 0)) { p.r(OAK.deep, x + T - 3, y, 3, T); p.r(OAK.light, x + T - 3, y, 1, T); p.r(OAK.line, x + T - 1, y, 1, T); }
  if (door(0, -1)) { p.r(OAK.deep, x, y, T, 3); p.r(OAK.light, x, y + 2, T, 1); p.r(OAK.line, x, y, T, 1); }
  if (door(0, 1)) { p.r(OAK.deep, x, y + T - 3, T, 3); p.r(OAK.light, x, y + T - 3, T, 1); p.r(OAK.line, x, y + T - 1, T, 1); }
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
const isWindow = (s: Scene, tx: number, ty: number): boolean => tx % 3 === 1 && plainFace(s, tx, ty) && !s.open(tx, ty - 1) && !s.wall(tx, ty - 1);

function wallDecor(p: Painter, s: Scene, tx: number, ty: number): void {
  if (!plainFace(s, tx, ty)) return;
  const x = tx * T;
  const fy = ty * T + CAP;
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
    lightPool(p, Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2), Math.round(Math.min(r.width * 0.42, 300)), Math.round(Math.min(r.height * 0.4, 130)));
  }
  for (const d of s.desks) {
    if (overlaps(view, d, 48)) lightPool(p, Math.round(d.x + d.width / 2), Math.round(d.y + d.height / 2 + 4), 52, 30);
  }
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

function furnitureItem(p: Painter, s: Scene, f: MapObject): void {
  const kind = kindOf(f);
  if (kind === 'plant') pottedPlant(p, Math.round(f.x + f.width / 2), f.y + f.height - 1, true);
  else if (kind === 'sofa' && f.width >= f.height && f.width >= 48) sofa(p, f);
  else if (kind === 'counter' && f.height >= 20) counter(p, f);
  else if (kind === 'table' && f.width >= 24 && f.height >= 20) { if (isDeskTable(s, f)) deskTable(p, f); else plainTable(p, s, f); }
  else cabinet(p, f);
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
  rugs(p, s, view);
  tiles((tx, ty) => { if (s.wall(tx, ty)) wallTile(p, s, tx, ty); });
  for (const piece of s.pieces) if (overlaps(view, { x: piece.x, y: piece.y, width: piece.width, height: 14 }, 2)) wallPiece(p, piece);
  tiles((tx, ty) => wallDecor(p, s, tx, ty));
  chairs(p, s, view);
  for (const f of [...s.furniture].sort((a, b) => a.y + a.height - (b.y + b.height))) if (overlaps(view, f, 16)) furnitureItem(p, s, f);
  cornerPlants(p, s, view);
}

export interface EnvironmentChunk { canvas: HTMLCanvasElement; x: number; y: number }

/** The whole static scene of one floor as canvases of at most ENV_CHUNK px, in map coordinates. */
export function renderEnvironment(map: OfficeMap): EnvironmentChunk[] {
  const scene = buildScene(map);
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
