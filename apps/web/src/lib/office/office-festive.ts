'use client';

/**
 * Festive mode (ADR 055): an optional, separate layer of seasonal decoration over the office.
 * A cosy, tropical Christmas, without snow: garlands with fairy lights along the walls, wreaths
 * by the doors, decorated trees with gifts in the reception, café and lounge, a lit palm in the
 * garden, a ribboned reception counter, candles on the café tables and warm golden light.
 *
 * Nothing here is part of the office itself: the renderer builds this layer when festive mode
 * is on and destroys all of it when it is turned off, so the normal office (its furniture and
 * everyday decoration) is untouched either way. Like the environment, it is painted once, never
 * per frame; only the bulbs twinkle, by swapping the alpha of two prebuilt shapes.
 */
import { objectLayer, prop, TILE_SIZE, tileLayer } from '@hrvo/shared';
import type { MapObject, OfficeMap } from '@hrvo/shared';
import { buildAtlas, CREAM, FESTIVE, GOLD, GOLD_LIGHT, hash, INK, LEAF, LIGHT, pick } from './pixel-kit';
import type { AtlasPiece, AtlasSprite, Painter } from './pixel-kit';

const T = TILE_SIZE;
/** Must match the environment's wall faces (office-environment.ts CAP). */
const CAP = 13;
const MAX_RUN = 48;

/** A fairy-light bulb; the two phases twinkle against each other. */
export interface Bulb { x: number; y: number; colour: number; phase: 0 | 1 }
export interface Festive {
  atlas: { canvas: HTMLCanvasElement; sprites: AtlasSprite[] } | null;
  bulbs: Bulb[];
}

const BULB_COLOURS = [FESTIVE.redLight, GOLD_LIGHT, 0x7fd1a0, FESTIVE.cream, 0xf2a65a];

interface Area { x: number; y: number; width: number; height: number; name: string; type: string }

function sceneOf(map: OfficeMap) {
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
  // Doorways: gaps of up to six tiles in a wall line (the same rule as the environment's door sills).
  const doors = new Set<number>();
  const gap = (x: number, y: number, dx: number, dy: number): boolean => {
    let a = 1;
    while (a <= 6 && open(x - dx * a, y - dy * a)) a += 1;
    let b = 1;
    while (b <= 6 && open(x + dx * b, y + dy * b)) b += 1;
    return wall(x - dx * a, y - dy * a) && wall(x + dx * b, y + dy * b) && a + b - 1 <= 6;
  };
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    if (!open(x, y)) continue;
    if ((open(x, y - 1) && open(x, y + 1) && gap(x, y, 1, 0)) || (open(x - 1, y) && open(x + 1, y) && gap(x, y, 0, 1))) doors.add(y * w + x);
  }
  const rooms: Area[] = objectLayer(map, 'rooms').map((o) => ({ x: o.x, y: o.y, width: o.width, height: o.height, name: o.name, type: String(prop(o, 'type', 'OPEN')).toUpperCase() }));
  return { w, h, floor, wall, open, taken, doors, furniture, rooms };
}
type Scene = ReturnType<typeof sceneOf>;

const face = (s: Scene, x: number, y: number) => s.wall(x, y) && s.open(x, y + 1);
/** An open tile beside it in the same wall line: a doorway next to this wall tile. */
const besideDoor = (s: Scene, x: number, y: number) => (s.open(x - 1, y) && s.open(x - 1, y + 1)) || (s.open(x + 1, y) && s.open(x + 1, y + 1));

// ---------------------------------------------------------------- garlands and bulbs

/** A pine garland swagged along a wall face, with a red bow at each peg. Bulbs go to `bulbs`. */
function garland(x0: number, y0: number, w: number, bulbs: Bulb[], salt: number): AtlasPiece {
  const sag = (x: number) => Math.round(Math.sin(((x - x0) / 64) * Math.PI) ** 2 * 5);
  for (let x = x0 + 6; x < x0 + w - 4; x += 9) {
    const h = hash(x, salt, 91);
    bulbs.push({ x, y: y0 + 3 + sag(x) + 3, colour: pick(BULB_COLOURS, h), phase: ((x - x0) / 9) % 2 === 0 ? 0 : 1 });
  }
  return {
    x: x0, y: y0, width: w, height: 14, depth: null,
    draw: (p) => {
      for (let x = x0; x < x0 + w; x += 1) {
        const y = y0 + 1 + sag(x);
        const h = hash(x, salt, 92);
        p.r(FESTIVE.greenDark, x, y + 1, 1, 4);
        p.r(h % 3 ? FESTIVE.green : FESTIVE.greenLight, x, y + (h % 2), 1, 3);
        if (h % 5 === 0) p.r(LEAF.light, x, y, 1, 1);
      }
      for (let x = x0 + 64; x < x0 + w - 8; x += 128) {
        p.r(FESTIVE.red, x - 4, y0, 3, 3); p.r(FESTIVE.red, x + 2, y0, 3, 3); p.r(FESTIVE.redDark, x - 1, y0 + 1, 3, 3);
        p.r(FESTIVE.red, x - 2, y0 + 4, 2, 4); p.r(FESTIVE.red, x + 1, y0 + 4, 2, 4); p.r(FESTIVE.redLight, x - 3, y0, 1, 1);
      }
    },
  };
}

function wreath(cx: number, cy: number): AtlasPiece {
  return {
    x: cx - 9, y: cy - 9, width: 19, height: 19, depth: null,
    draw: (p) => {
      p.ellipse(FESTIVE.greenDark, cx, cy, 8, 8); p.ellipse(FESTIVE.green, cx, cy - 1, 7, 7); p.ellipse(CREAM.base, cx, cy, 3, 3);
      for (let i = 0; i < 8; i += 1) { const a = (i * Math.PI) / 4; p.r(i % 2 ? FESTIVE.greenLight : FESTIVE.redLight, Math.round(cx + Math.cos(a) * 6), Math.round(cy + Math.sin(a) * 6), 2, 2); }
      p.r(FESTIVE.red, cx - 4, cy + 4, 3, 3); p.r(FESTIVE.red, cx + 2, cy + 4, 3, 3); p.r(FESTIVE.redDark, cx - 1, cy + 5, 3, 3); p.r(FESTIVE.red, cx - 2, cy + 8, 2, 2); p.r(FESTIVE.red, cx + 1, cy + 8, 2, 2);
    },
  };
}

/** Garlands along every wall face (split into runs), and a wreath on the wall beside each doorway. */
function walls(s: Scene, bulbs: Bulb[]): AtlasPiece[] {
  const out: AtlasPiece[] = [];
  const wreathed = new Set<number>();
  for (let ty = 0; ty < s.h; ty += 1) {
    let tx = 0;
    while (tx < s.w) {
      if (!face(s, tx, ty)) { tx += 1; continue; }
      let end = tx;
      while (end + 1 < s.w && face(s, end + 1, ty) && end + 1 - tx < MAX_RUN) end += 1;
      const len = end - tx + 1;
      if (len >= 2) out.push(garland(tx * T, ty * T + CAP, len * T, bulbs, ty * 1000 + tx));
      for (let x = tx; x <= end; x += 1) {
        if (besideDoor(s, x, ty) && !wreathed.has(ty * s.w + x) && !wreathed.has(ty * s.w + x - 1)) {
          wreathed.add(ty * s.w + x);
          out.push(wreath(x * T + 16, ty * T + CAP + 9));
        }
      }
      tx = end + 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------- trees and gifts

function gift(p: Painter, x: number, y: number, w: number, h: number, box: number, ribbon: number): void {
  p.r(INK, x + 1, y + h, w, 2, 0.18);
  p.r(box, x, y, w, h); p.r(0xffffff, x, y, w, 1, 0.25);
  p.r(ribbon, x + Math.floor(w / 2) - 1, y, 2, h); p.r(ribbon, x, y + Math.floor(h / 2) - 1, w, 2);
  p.r(ribbon, x + Math.floor(w / 2) - 3, y - 2, 2, 2); p.r(ribbon, x + Math.floor(w / 2) + 1, y - 2, 2, 2);
}

/** A decorated fir with a gold star, baubles, tinsel and gifts round its foot. */
function christmasTree(cx: number, base: number, salt: number): AtlasPiece {
  return {
    x: cx - 34, y: base - 86, width: 68, height: 92, depth: base,
    draw: (p) => {
      p.ellipse(INK, cx + 2, base - 3, 26, 6, 0.2);
      p.r(0x6b4a2f, cx - 3, base - 14, 6, 10);
      p.r(FESTIVE.red, cx - 9, base - 8, 18, 6); p.r(GOLD, cx - 9, base - 8, 18, 1); // pot wrapped in red
      const tiers = [[base - 12, 26], [base - 30, 21], [base - 46, 16], [base - 60, 11], [base - 72, 6]] as const;
      tiers.forEach(([y, half], i) => {
        for (let r = 0; r < 18; r += 1) {
          const wv = Math.round(half * (r / 17)) + 2;
          p.r(FESTIVE.greenDark, cx - wv, y - 18 + r, wv * 2, 1);
          p.r(i % 2 ? FESTIVE.green : FESTIVE.greenLight, cx - wv + 1, y - 18 + r, Math.max(1, wv - 1), 1);
        }
        p.r(GOLD_LIGHT, cx - half + 3, y - 3, half * 2 - 6, 1, 0.9); // tinsel
      });
      for (let i = 0; i < 16; i += 1) {
        const h = hash(i, salt, 93);
        const tier = tiers[i % 4]!;
        const off = (h % (tier[1] * 2 - 6)) - tier[1] + 3;
        p.r(pick([FESTIVE.red, GOLD, 0x3b6fb5, FESTIVE.cream, FESTIVE.redLight], h >>> 6), cx + off, tier[0] - 8 - ((h >>> 3) % 6), 3, 3);
      }
      // Star.
      p.r(GOLD, cx - 1, base - 92 + 6, 3, 9); p.r(GOLD, cx - 4, base - 92 + 9, 9, 3); p.r(GOLD_LIGHT, cx, base - 92 + 9, 1, 3);
      gift(p, cx - 28, base - 12, 12, 10, FESTIVE.red, GOLD);
      gift(p, cx + 15, base - 10, 13, 9, 0x3b6fb5, FESTIVE.cream);
      gift(p, cx - 15, base - 4, 10, 7, FESTIVE.cream, FESTIVE.red);
      gift(p, cx + 6, base - 4, 9, 7, FESTIVE.green, GOLD_LIGHT);
    },
  };
}

/** The garden's tropical tree: a palm wrapped in lights, with a gift or two. */
function festivePalm(cx: number, base: number, salt: number): AtlasPiece {
  return {
    x: cx - 40, y: base - 84, width: 80, height: 90, depth: base,
    draw: (p) => {
      p.ellipse(INK, cx + 2, base - 3, 22, 5, 0.2);
      for (let i = 0; i < 9; i += 1) { const y = base - 8 - i * 7; p.r(0x8a6440, cx - 4 + (i > 5 ? 1 : 0), y - 6, 8, 7); p.r(0x6b4a2f, cx - 4 + (i > 5 ? 1 : 0), y, 8, 1); p.r(i % 2 ? FESTIVE.redLight : GOLD_LIGHT, cx - 5, y - 3, 2, 2); }
      const top = base - 72;
      const fronds = [[-1, -0.25], [1, -0.25], [-0.85, 0.35], [0.85, 0.35], [-0.35, -0.9], [0.35, -0.9]] as const;
      for (const [dx, dy] of fronds) {
        for (let k = 0; k < 30; k += 1) {
          const x = Math.round(cx + dx * k);
          const y = Math.round(top + dy * k + (k * k) / 70);
          p.r(LEAF.dark, x - 1, y, 3, 2); p.r(k % 3 ? LEAF.base : LEAF.light, x, y - 1, 2, 2);
          if (k % 7 === 3) p.r(pick([GOLD_LIGHT, FESTIVE.redLight, FESTIVE.cream], hash(k, salt, Math.round(dx * 10))), x, y + 2, 2, 2);
        }
      }
      p.ellipse(0x6b4a2f, cx, top + 2, 5, 4);
      gift(p, cx - 22, base - 11, 12, 9, FESTIVE.red, GOLD);
      gift(p, cx + 10, base - 9, 11, 8, FESTIVE.cream, FESTIVE.green);
    },
  };
}

/** A warm pool of golden light (three flat steps) on the floor. */
function glow(cx: number, cy: number, rx: number, ry: number): AtlasPiece {
  return {
    x: cx - rx - 1, y: cy - ry - 1, width: rx * 2 + 3, height: ry * 2 + 3, depth: null,
    draw: (p) => { p.ellipse(LIGHT, cx, cy, rx, ry, 0.08); p.ellipse(LIGHT, cx, cy, Math.round(rx * 0.7), Math.round(ry * 0.7), 0.08); p.ellipse(LIGHT, cx, cy, Math.round(rx * 0.4), Math.round(ry * 0.4), 0.08); },
  };
}

/**
 * A free 2 x 2 spot in a room for a tree: open floor, no furniture, nothing in a doorway, and a
 * clear tile all round (so it never narrows a passage). Prefers the top-right, away from the label.
 */
function treeSpot(s: Scene, room: Area): { cx: number; base: number } | null {
  const x0 = Math.round(room.x / T);
  const y0 = Math.round(room.y / T);
  const x1 = Math.round((room.x + room.width) / T) - 1;
  const y1 = Math.round((room.y + room.height) / T) - 1;
  const free = (tx: number, ty: number) => s.open(tx, ty) && !s.taken.has(ty * s.w + tx);
  const ok = (tx: number, ty: number) => {
    for (let y = ty; y <= ty + 1; y += 1) for (let x = tx; x <= tx + 1; x += 1) if (!free(x, y)) return false;
    for (let y = ty - 1; y <= ty + 2; y += 1) for (let x = tx - 1; x <= tx + 2; x += 1) {
      if (x >= tx && x <= tx + 1 && y >= ty && y <= ty + 1) continue;
      // The ring may be wall (against a wall is fine) but never a doorway or a gap someone walks through.
      if (!s.wall(x, y) && !free(x, y)) return false;
      if (s.open(x, y) && ((s.wall(x - 1, y) && s.wall(x + 1, y)) || (s.wall(x, y - 1) && s.wall(x, y + 1)))) return false;
    }
    // Two clear tiles between the tree and any doorway, so nobody walks out of a door into it.
    for (let y = ty - 2; y <= ty + 3; y += 1) for (let x = tx - 2; x <= tx + 3; x += 1) if (s.doors.has(y * s.w + x)) return false;
    return true;
  };
  const candidates: Array<[number, number]> = [];
  for (let ty = y0; ty < y1; ty += 1) for (let tx = x1 - 1; tx >= x0 + 4; tx -= 1) candidates.push([tx, ty]);
  for (const [tx, ty] of candidates) if (ok(tx, ty)) return { cx: (tx + 1) * T, base: (ty + 2) * T - 2 };
  return null;
}

// ---------------------------------------------------------------- counters and tables

function counterRibbon(f: MapObject): AtlasPiece {
  const { x, y, width: w, height: h } = f;
  return {
    x, y: y - 2, width: w, height: h + 2, depth: null,
    draw: (p) => {
      const front = y + h - 14;
      for (let xx = x + 2; xx < x + w - 2; xx += 1) {
        const yy = front + Math.round(Math.sin(((xx - x) / 48) * Math.PI) ** 2 * 4);
        p.r(FESTIVE.greenDark, xx, yy, 1, 4); p.r(hash(xx, y, 94) % 3 ? FESTIVE.green : FESTIVE.greenLight, xx, yy, 1, 2);
      }
      for (let xx = x + 24; xx < x + w - 10; xx += 48) {
        p.r(FESTIVE.red, xx - 4, front - 2, 3, 3); p.r(FESTIVE.red, xx + 2, front - 2, 3, 3); p.r(FESTIVE.redDark, xx - 1, front - 1, 3, 3);
        p.r(GOLD, xx, front + 2, 1, 6); p.ellipse(GOLD, xx, front + 9, 2, 2);
      }
      // A little poinsettia at the end of the counter top.
      const px = x + w - 10;
      for (let i = 0; i < 5; i += 1) { const a = (i * 2 * Math.PI) / 5; p.r(FESTIVE.red, Math.round(px + Math.cos(a) * 3) - 1, Math.round(y + 3 + Math.sin(a) * 3) - 1, 3, 3); }
      p.r(GOLD, px - 1, y + 2, 2, 2);
    },
  };
}

function candle(cx: number, cy: number): AtlasPiece {
  return {
    x: cx - 5, y: cy - 9, width: 11, height: 12, depth: null,
    draw: (p) => {
      p.r(FESTIVE.greenDark, cx - 4, cy, 9, 2); p.r(FESTIVE.green, cx - 3, cy, 7, 1); p.r(FESTIVE.redLight, cx - 4, cy + 1, 2, 1); p.r(FESTIVE.redLight, cx + 3, cy, 1, 1);
      p.r(FESTIVE.red, cx - 1, cy - 5, 3, 5); p.r(FESTIVE.redLight, cx - 1, cy - 5, 1, 5);
      p.r(GOLD_LIGHT, cx, cy - 8, 1, 3); p.r(0xfff3c4, cx, cy - 7, 1, 1);
    },
  };
}

/** Red and cream stockings and a bow on a sofa back; a festive cushion. */
function sofaTrim(f: MapObject): AtlasPiece {
  const { x, y, width: w } = f;
  return {
    x, y, width: w, height: 16, depth: null,
    draw: (p) => {
      for (let xx = x + 10; xx < x + w - 10; xx += 1) p.r(hash(xx, y, 95) % 3 ? FESTIVE.green : FESTIVE.greenDark, xx, y + 2 + Math.round(Math.sin(((xx - x) / 40) * Math.PI) ** 2 * 2), 1, 2);
      const cx = x + Math.round(w / 2);
      p.r(FESTIVE.red, cx - 4, y + 7, 9, 7); p.r(FESTIVE.cream, cx - 4, y + 7, 9, 2); p.r(GOLD, cx, y + 9, 1, 4); p.r(GOLD, cx - 2, y + 11, 5, 1);
    },
  };
}

// ---------------------------------------------------------------- the layer

/** Everything seasonal for one floor. */
export function renderFestive(map: OfficeMap): Festive {
  const s = sceneOf(map);
  const bulbs: Bulb[] = [];
  const pieces: AtlasPiece[] = walls(s, bulbs);
  // Trees: the welcoming areas get a fir, the garden a lit palm.
  for (const room of s.rooms) {
    // Open areas only (reception, lounge, café, arcade, garden), never a meeting or private room.
    if (room.type !== 'OPEN' || room.width < 6 * T || room.height < 5 * T) continue;
    const spot = treeSpot(s, room);
    if (!spot) continue;
    const floorAt = s.floor[Math.floor((spot.base - 4) / T) * s.w + Math.floor(spot.cx / T)] ?? 0;
    const isGarden = floorAt === 6;
    // Warm glow, except on the dark arcade carpet (8), where it reads as grey haze.
    if (floorAt !== 8) pieces.push(glow(spot.cx, spot.base - 6, 54, 22));
    pieces.push(isGarden ? festivePalm(spot.cx, spot.base, room.x + room.y) : christmasTree(spot.cx, spot.base, room.x + room.y));
  }
  for (const f of s.furniture) {
    const kind = String(prop(f, 'kind', '')).toLowerCase();
    if ((kind === 'counter' || kind === 'coffee-counter') && f.width >= 3 * T) pieces.push(counterRibbon(f));
    else if (kind === 'cafe-table') pieces.push(candle(Math.round(f.x + f.width / 2) + 6, Math.round(f.y + f.height / 2) - 4));
    else if (kind === 'sofa' && f.width >= 3 * T && f.width >= f.height) pieces.push(sofaTrim(f));
  }
  return { atlas: buildAtlas(pieces), bulbs };
}
