/**
 * Collision grid, movement validation and click-to-move pathfinding (FR-VO-002, ADR 015).
 * The API validates every move with these functions; the browser uses the same ones to predict,
 * so a well-behaved client is never corrected.
 */
import { objectLayer, prop, TILE_SIZE, tileLayer } from './map.ts';
import type { OfficeMap, Point } from './map.ts';

export const AVATAR_RADIUS = 10;
/** Walking speed in px/s (about 6 tiles a second). */
export const MOVE_SPEED = 200;
/** Extra distance tolerated per move for jitter between client ticks. */
export const MOVE_SLACK = 24;

export interface CollisionGrid {
  w: number;
  h: number;
  tile: number;
  /** 1 = blocked */
  blocked: Uint8Array;
}

export function buildGrid(map: OfficeMap): CollisionGrid {
  const w = map.width;
  const h = map.height;
  const blocked = new Uint8Array(w * h);
  const walls = tileLayer(map, 'walls') ?? [];
  const floor = tileLayer(map, 'floor');
  for (let i = 0; i < w * h; i += 1) {
    if ((walls[i] ?? 0) !== 0) blocked[i] = 1;
    else if (floor && (floor[i] ?? 0) === 0) blocked[i] = 1; // void is not walkable
  }
  for (const o of objectLayer(map, 'furniture')) {
    if (!prop(o, 'collides', false)) continue;
    const x0 = Math.floor(o.x / TILE_SIZE);
    const y0 = Math.floor(o.y / TILE_SIZE);
    const x1 = Math.ceil((o.x + o.width) / TILE_SIZE);
    const y1 = Math.ceil((o.y + o.height) / TILE_SIZE);
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) if (x >= 0 && y >= 0 && x < w && y < h) blocked[y * w + x] = 1;
  }
  return { w, h, tile: TILE_SIZE, blocked };
}

export function tileBlocked(g: CollisionGrid, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= g.w || ty >= g.h) return true;
  return g.blocked[ty * g.w + tx] === 1;
}

/** The avatar's bounding square (radius r) fits on walkable tiles only. */
export function walkable(g: CollisionGrid, x: number, y: number, r = AVATAR_RADIUS): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const corners = [[x - r, y - r], [x + r, y - r], [x - r, y + r], [x + r, y + r]] as const;
  for (const [cx, cy] of corners) if (tileBlocked(g, Math.floor(cx / g.tile), Math.floor(cy / g.tile))) return false;
  return true;
}

/** Every point of the straight segment a→b is walkable (sampled at a quarter tile). */
export function segmentClear(g: CollisionGrid, a: Point, b: Point, r = AVATAR_RADIUS): boolean {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(dist / (g.tile / 4)));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    if (!walkable(g, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, r)) return false;
  }
  return true;
}

export type MoveVerdict = { ok: true } | { ok: false; reason: 'NOT_WALKABLE' | 'THROUGH_WALL' | 'TOO_FAST' };

/**
 * Server check of one reported position. `elapsedMs` is server time since the last accepted
 * position (capped at 1 s, so a long pause does not license a jump).
 */
export function validateMove(g: CollisionGrid, from: Point, to: Point, elapsedMs: number): MoveVerdict {
  if (!walkable(g, to.x, to.y)) return { ok: false, reason: 'NOT_WALKABLE' };
  const allowed = (MOVE_SPEED * Math.min(Math.max(elapsedMs, 0), 1000)) / 1000 + MOVE_SLACK;
  if (Math.hypot(to.x - from.x, to.y - from.y) > allowed) return { ok: false, reason: 'TOO_FAST' };
  if (!segmentClear(g, from, to)) return { ok: false, reason: 'THROUGH_WALL' };
  return { ok: true };
}

/** Closest walkable point to p (breadth-first over tiles), for spawns and teleports. */
export function nearestWalkable(g: CollisionGrid, p: Point, maxTiles = 12): Point | null {
  const sx = Math.floor(p.x / g.tile);
  const sy = Math.floor(p.y / g.tile);
  if (walkable(g, p.x, p.y)) return { x: p.x, y: p.y };
  const seen = new Set<number>();
  const queue: Array<[number, number]> = [[sx, sy]];
  seen.add(sy * g.w + sx);
  while (queue.length) {
    const [tx, ty] = queue.shift()!;
    const c = { x: tx * g.tile + g.tile / 2, y: ty * g.tile + g.tile / 2 };
    if (walkable(g, c.x, c.y)) return c;
    if (Math.abs(tx - sx) > maxTiles || Math.abs(ty - sy) > maxTiles) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
      const k = ny * g.w + nx;
      if (!seen.has(k)) { seen.add(k); queue.push([nx, ny]); }
    }
  }
  return null;
}

/**
 * A* over tiles (8 directions, no corner cutting) from a to b, smoothed by line of sight.
 * Returns pixel waypoints excluding the start, or null when unreachable. `canEnter` lets the
 * caller exclude tiles (e.g. rooms the user may not enter).
 */
export function findPath(g: CollisionGrid, a: Point, b: Point, canEnter: (p: Point) => boolean = () => true, maxNodes = 20_000): Point[] | null {
  const target = nearestWalkable(g, b, 3);
  if (!target || !canEnter(target)) return null;
  const centreOf = (tx: number, ty: number): Point => ({ x: tx * g.tile + g.tile / 2, y: ty * g.tile + g.tile / 2 });
  const ok = (tx: number, ty: number) => !tileBlocked(g, tx, ty) && walkable(g, tx * g.tile + g.tile / 2, ty * g.tile + g.tile / 2) && canEnter(centreOf(tx, ty));
  const sx = Math.floor(a.x / g.tile);
  const sy = Math.floor(a.y / g.tile);
  const ex = Math.floor(target.x / g.tile);
  const ey = Math.floor(target.y / g.tile);
  if (sx === ex && sy === ey) return [target];
  const key = (x: number, y: number) => y * g.w + x;
  const gScore = new Map<number, number>([[key(sx, sy), 0]]);
  const came = new Map<number, number>();
  const open: Array<{ k: number; f: number }> = [{ k: key(sx, sy), f: 0 }];
  const closed = new Set<number>();
  const hdist = (x: number, y: number) => { const dx = Math.abs(x - ex); const dy = Math.abs(y - ey); return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy); };
  let expanded = 0;
  while (open.length) {
    let best = 0;
    for (let i = 1; i < open.length; i += 1) if (open[i]!.f < open[best]!.f) best = i;
    const { k } = open.splice(best, 1)[0]!;
    if (closed.has(k)) continue;
    closed.add(k);
    const x = k % g.w;
    const y = Math.floor(k / g.w);
    if (x === ex && y === ey) {
      const tiles: Point[] = [];
      let cur: number | undefined = k;
      while (cur !== undefined && cur !== key(sx, sy)) { tiles.push(centreOf(cur % g.w, Math.floor(cur / g.w))); cur = came.get(cur); }
      tiles.reverse();
      tiles[tiles.length - 1] = target;
      return smooth(g, a, tiles);
    }
    if ((expanded += 1) > maxNodes) return null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (!ok(nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (!ok(x + dx, y) || !ok(x, y + dy))) continue; // no corner cutting
      const nk = key(nx, ny);
      const tentative = (gScore.get(k) ?? Infinity) + (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1);
      if (tentative < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, tentative);
        came.set(nk, k);
        open.push({ k: nk, f: tentative + hdist(nx, ny) });
      }
    }
  }
  return null;
}

function smooth(g: CollisionGrid, start: Point, path: Point[]): Point[] {
  const out: Point[] = [];
  let anchor = start;
  let i = 0;
  while (i < path.length) {
    let j = path.length - 1;
    while (j > i && !segmentClear(g, anchor, path[j]!)) j -= 1;
    out.push(path[j]!);
    anchor = path[j]!;
    i = j + 1;
  }
  return out;
}
