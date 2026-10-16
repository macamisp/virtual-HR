/**
 * Interest management and proximity groups (FR-VO-005, FR-VO-013, ADR 015). Pure.
 *
 *  - Interest: the floor is cut into square cells; a user receives position updates only for
 *    people on the same floor in their own cell and the eight around it.
 *  - Proximity: people outside rooms (or in OPEN rooms) within `radius` of each other form a
 *    group (transitively). Each closed room is its own group. "Room-only" users are never
 *    joined by proximity. The media slice will connect each group.
 */
export const INTEREST_CELL = 512;

export interface SpatialEntity {
  id: string;
  floorId: string;
  x: number;
  y: number;
  /** Room id when inside a room that is not OPEN; null in the open area or an OPEN room. */
  closedRoomId: string | null;
  roomOnly: boolean;
}

export const cellOf = (x: number, y: number): string => `${Math.floor(x / INTEREST_CELL)}:${Math.floor(y / INTEREST_CELL)}`;

/** floor -> cell -> ids, for the 3×3 neighbourhood lookup. */
export class InterestGrid {
  private readonly cells = new Map<string, Map<string, Set<string>>>();

  constructor(entities: Iterable<Pick<SpatialEntity, 'id' | 'floorId' | 'x' | 'y'>>) {
    for (const e of entities) {
      const floor = this.cells.get(e.floorId) ?? new Map<string, Set<string>>();
      const c = cellOf(e.x, e.y);
      const set = floor.get(c) ?? new Set<string>();
      set.add(e.id);
      floor.set(c, set);
      this.cells.set(e.floorId, floor);
    }
  }

  /** Ids in the 3×3 cells around (x, y) on the floor, including the observer. */
  neighbourhood(floorId: string, x: number, y: number): Set<string> {
    const out = new Set<string>();
    const floor = this.cells.get(floorId);
    if (!floor) return out;
    const cx = Math.floor(x / INTEREST_CELL);
    const cy = Math.floor(y / INTEREST_CELL);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const set = floor.get(`${cx + dx}:${cy + dy}`);
        if (set) for (const id of set) out.add(id);
      }
    }
    return out;
  }
}

/**
 * Groups of people who can talk: a stable group id per group (the smallest member id, or
 * `room:<id>` for a closed room). Singletons are omitted.
 */
export function proximityGroups(entities: SpatialEntity[], radius: number): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const open: SpatialEntity[] = [];
  for (const e of entities) {
    if (e.closedRoomId) {
      const k = `room:${e.closedRoomId}`;
      groups.set(k, [...(groups.get(k) ?? []), e.id]);
    } else if (!e.roomOnly) open.push(e);
  }
  // Union-find over a radius-sized grid so each person is compared with nearby people only.
  const parent = new Map<string, string>(open.map((e) => [e.id, e.id]));
  const find = (a: string): string => { let r = a; while (parent.get(r) !== r) r = parent.get(r)!; let c = a; while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; } return r; };
  const union = (a: string, b: string) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
  const buckets = new Map<string, SpatialEntity[]>();
  const bk = (f: string, x: number, y: number) => `${f}|${Math.floor(x / radius)}:${Math.floor(y / radius)}`;
  for (const e of open) { const k = bk(e.floorId, e.x, e.y); buckets.set(k, [...(buckets.get(k) ?? []), e]); }
  const r2 = radius * radius;
  for (const e of open) {
    const bx = Math.floor(e.x / radius);
    const by = Math.floor(e.y / radius);
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      for (const o of buckets.get(`${e.floorId}|${bx + dx}:${by + dy}`) ?? []) {
        if (o.id <= e.id) continue;
        const ddx = o.x - e.x;
        const ddy = o.y - e.y;
        if (ddx * ddx + ddy * ddy <= r2) union(e.id, o.id);
      }
    }
  }
  const byRoot = new Map<string, string[]>();
  for (const e of open) { const r = find(e.id); byRoot.set(r, [...(byRoot.get(r) ?? []), e.id]); }
  for (const [root, members] of byRoot) if (members.length > 1) groups.set(root, members.sort());
  for (const [k, members] of [...groups]) if (k.startsWith('room:') && members.length < 2) groups.delete(k);
  return groups;
}
