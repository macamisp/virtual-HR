'use client';

/**
 * Shared basics of the office pixel art (ADR 054, 055): the palette, the deterministic hash,
 * a whole-pixel painter, and an atlas builder that packs many small painted pieces into one
 * canvas (one texture) instead of one texture each.
 */

// ---------------------------------------------------------------- palette
// Warm oak, deep navy, cream and ivory, sage, muted terracotta, foliage green, golden light.

export const OAK = { light: 0xd9b384, base: 0xcba274, mid: 0xbf9566, dark: 0xa87d50, deep: 0x8a6440, line: 0x74522f };
export const NAVY = { light: 0x4a5d82, base: 0x2e3d5a, mid: 0x26334d, deep: 0x1a2438 };
export const CREAM = { light: 0xfbf6ea, base: 0xf3ead8, mid: 0xe9dec7, dark: 0xd8cbb0, line: 0xc7b998 };
export const SAGE = { light: 0xd3dece, base: 0xc8d4c2, mid: 0xc2cfbc, dark: 0x9db39a, deep: 0x7f977c };
export const TERRA = { light: 0xdb9a7c, base: 0xc47a5a, mid: 0xb56c4c, dark: 0x9c5a3c, deep: 0x7f4630 };
export const LEAF = { light: 0x86c074, base: 0x5c9a55, dark: 0x3d7242, deep: 0x2c5534 };
export const BLUE = { light: 0xd9e1ea, base: 0xcfd8e3, mid: 0xc6d0dc, line: 0xb7c3d2 };
export const MAPLE = { light: 0xe9d3b0, base: 0xe2c9a3, mid: 0xdabf97, line: 0xc6a779 };
export const GRASS = { light: 0x9cc77e, base: 0x8bbb6d, mid: 0x81b265, dark: 0x6f9f57, deep: 0x5a8748 };
export const STONE = { light: 0xe6ddcb, base: 0xd9cfba, mid: 0xcdc2ab, dark: 0xb3a68c, line: 0x9a8d74 };
export const WATER = { light: 0xbfe6f2, base: 0x7cc3dc, mid: 0x5fadc9, dark: 0x3f8eae };
export const FESTIVE = { red: 0xc2363b, redDark: 0x8e2328, redLight: 0xe0595c, green: 0x2f7a46, greenDark: 0x1f5631, greenLight: 0x4f9e5f, cream: 0xfaf1dc };
export const GOLD = 0xd9a94e;
export const GOLD_LIGHT = 0xf3d48a;
export const GLASS = { base: 0xa9d3e8, light: 0xd8eef8, dark: 0x86b9d3 };
export const LIGHT = 0xffd27a;
export const INK = 0x000000;

// ---------------------------------------------------------------- helpers

/** Deterministic hash of a position (and a salt): the only source of variation. */
export function hash(x: number, y: number, salt = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

export const pick = <V>(items: readonly V[], h: number): V => items[h % items.length]!;

export interface Rect { x: number; y: number; width: number; height: number }
export const overlaps = (a: Rect, b: Rect, pad = 0): boolean => a.x - pad < b.x + b.width && a.x + a.width + pad > b.x && a.y - pad < b.y + b.height && a.y + a.height + pad > b.y;

/** Whole-pixel fills only, so every edge stays crisp. */
export class Painter {
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

// ---------------------------------------------------------------- atlas

/** A piece of art at a place on the map; `depth` (its base y) sorts it among the avatars. */
export interface AtlasPiece extends Rect {
  /** null: flat on the floor layer. A number: sorted with the avatars by that y. */
  depth: number | null;
  /** Draws the piece in map coordinates. */
  draw: (p: Painter) => void;
}

/** Where a piece landed in the atlas, and where it goes on the map. */
export interface AtlasSprite extends Rect { sx: number; sy: number; depth: number | null }

const ATLAS_WIDTH = 2048;
const GUTTER = 2;

/**
 * Packs pieces into one canvas (shelves, tallest first), painting each through a translated
 * context so its drawing code works in map coordinates. Null when there is nothing to pack.
 */
export function buildAtlas(pieces: AtlasPiece[]): { canvas: HTMLCanvasElement; sprites: AtlasSprite[] } | null {
  const items = pieces.filter((p) => p.width > 0 && p.height > 0).map((p) => ({ ...p, width: Math.ceil(p.width), height: Math.ceil(p.height), x: Math.floor(p.x), y: Math.floor(p.y) }));
  if (!items.length) return null;
  const order = [...items.keys()].sort((a, b) => items[b]!.height - items[a]!.height);
  const slots = new Array<{ sx: number; sy: number }>(items.length);
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const i of order) {
    const it = items[i]!;
    const w = Math.min(it.width, ATLAS_WIDTH);
    if (x + w > ATLAS_WIDTH) { y += shelf + GUTTER; x = 0; shelf = 0; }
    slots[i] = { sx: x, sy: y };
    x += w + GUTTER;
    shelf = Math.max(shelf, it.height);
  }
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_WIDTH;
  canvas.height = y + shelf;
  const ctx = canvas.getContext('2d');
  const sprites: AtlasSprite[] = [];
  items.forEach((it, i) => {
    const { sx, sy } = slots[i]!;
    const width = Math.min(it.width, ATLAS_WIDTH);
    sprites.push({ x: it.x, y: it.y, width, height: it.height, sx, sy, depth: it.depth });
    if (!ctx) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(sx, sy, width, it.height);
    ctx.clip();
    ctx.setTransform(1, 0, 0, 1, sx - it.x, sy - it.y);
    ctx.imageSmoothingEnabled = false;
    it.draw(new Painter(ctx));
    ctx.restore();
  });
  return { canvas, sprites };
}
