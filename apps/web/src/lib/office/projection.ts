'use client';

/**
 * How the office map is shown on screen (ADR 061). The map, the server, movement, collision,
 * desks and seats always use the flat top-down grid in map pixels; only the view changes.
 *
 * - `top`: the map as it is (x right, y down).
 * - `iso`: a 2:1 isometric view. A map point (x, y) is shown at (x - y, (x + y) / 2), so a 32 px
 *   tile becomes a 64 x 32 diamond. The inverse turns a screen point back into the map.
 *
 * The isometric view is chosen in this browser only (localStorage `hrvo.office.view` = `iso`) while
 * its artwork is built; the default stays `top`.
 */
export type Projection = 'top' | 'iso';
export const VIEW_KEY = 'hrvo.office.view';

export function officeProjection(): Projection {
  try { return window.localStorage.getItem(VIEW_KEY) === 'iso' ? 'iso' : 'top'; } catch { return 'top'; }
}

export interface Pt { x: number; y: number }

/**
 * Scale of the isometric view: a 32 px map tile becomes a 48 x 24 diamond, so the 32 px characters
 * stand about two thirds of a tile wide, as in the reference (ADR 061).
 */
export const ISO_K = 0.75;

/** Map point to view point. */
export function project(mode: Projection, x: number, y: number): Pt {
  return mode === 'iso' ? { x: (x - y) * ISO_K, y: ((x + y) * ISO_K) / 2 } : { x, y };
}

/** View point to map point (the exact inverse of `project`). */
export function unproject(mode: Projection, x: number, y: number): Pt {
  if (mode !== 'iso') return { x, y };
  const d = x / ISO_K; // x - y
  const s = (2 * y) / ISO_K; // x + y
  return { x: (s + d) / 2, y: (s - d) / 2 };
}

/** Draw order of something standing at a map point: further down the screen is in front. */
export function depthOf(mode: Projection, x: number, y: number): number {
  return mode === 'iso' ? x + y : y;
}

/** The map's extent in view coordinates, for the camera. */
export function viewBounds(mode: Projection, width: number, height: number): { minX: number; maxX: number; minY: number; maxY: number } {
  return mode === 'iso' ? { minX: -height * ISO_K, maxX: width * ISO_K, minY: -96, maxY: ((width + height) * ISO_K) / 2 } : { minX: 0, maxX: width, minY: 0, maxY: height };
}

/**
 * A movement intent on screen (keys: x right, y down) as a map direction, so W still walks up the
 * screen in the isometric view. Not normalised (the client normalises).
 */
export function screenIntentToMap(mode: Projection, x: number, y: number): Pt {
  if (mode === 'top' || (x === 0 && y === 0)) return { x, y };
  const m = unproject(mode, x, y);
  const len = Math.hypot(m.x, m.y) || 1;
  return { x: m.x / len, y: m.y / len };
}
