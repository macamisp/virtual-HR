/**
 * Avatar actions (ADR 056): sit and stand on a chair, jump, wave, dance, and the two-person hug
 * and high five that need the other person's consent. Shared by the API (validation) and the
 * browser (controls, animation). Purely social: no action changes a position beyond sitting on a
 * reachable free chair, nor attendance, status, work time or meetings.
 */
import { z } from 'zod';
import { objectLayer, prop, TILE_SIZE } from './map.ts';
import type { MapObject, OfficeMap, Point } from './map.ts';
import { buildGrid, walkable } from './collision.ts';
import type { CollisionGrid } from './collision.ts';
import type { Facing } from './avatars.ts';

export const SOLO_ACTIONS = ['jump', 'wave', 'dance'] as const;
export type SoloAction = (typeof SOLO_ACTIONS)[number];
export const PAIR_ACTIONS = ['hug', 'highfive'] as const;
export type PairAction = (typeof PAIR_ACTIONS)[number];
export type AvatarActionKind = 'sit' | SoloAction | PairAction;

export const PAIR_LABEL: Record<PairAction, string> = { hug: 'hug', highfive: 'high five' };

/** How long each action shows (ms). Sitting lasts until the person stands or walks. */
export const ACTION_MS: Record<Exclude<AvatarActionKind, 'sit'>, number> = { jump: 600, wave: 1800, dance: 30_000, hug: 2200, highfive: 1300 };
/** How close a chair must be to sit on it (px from the avatar to the seat point). */
export const SEAT_REACH = 48;
/** How close the other person must be for a hug or a high five (px), in the same room. */
export const PAIR_REACH = 80;
/** An unanswered hug or high-five request lapses after this. */
export const PAIR_REQUEST_TTL_MS = 15_000;

/** The action on an avatar, as everyone in the office sees it (in the roster, ADR 056). */
export interface AvatarActionState {
  kind: AvatarActionKind;
  /** The other person of a hug or high five. */
  with?: string;
  /** The chair, when sitting. */
  seat?: string;
  /** Which way a sitting person faces. */
  facing?: Facing;
  /** Server ms when it started: a second wave right after the first is a new action. */
  since?: number;
}

// ---------------------------------------------------------------- socket DTOs

export const ActionDtoSchema = z.object({ kind: z.enum([...SOLO_ACTIONS, 'stop']) }).strict();
export type ActionDto = z.infer<typeof ActionDtoSchema>;
export const SitDtoSchema = z.object({ seatId: z.string().min(1).max(40) }).strict();
export const PairRequestDtoSchema = z.object({ kind: z.enum(PAIR_ACTIONS), to: z.string().uuid() }).strict();
export const PairAnswerDtoSchema = z.object({ id: z.string().uuid(), accept: z.boolean() }).strict();
export const PairCancelDtoSchema = z.object({ id: z.string().uuid() }).strict();

export type ActionAck = { ok: true } | { ok: false; error: string; code?: 'RATE_LIMITED' | 'BAD_REQUEST' | 'NOT_JOINED' };
export type SitAck = { ok: true; x: number; y: number; roomId: string | null } | { ok: false; error: string; code?: 'TOO_FAR' | 'TAKEN' | 'NO_SEAT' | 'ROOM' | 'BLOCKED' | 'RATE_LIMITED' | 'BAD_REQUEST' | 'NOT_JOINED' };
export type PairAck = { ok: true; id: string; expiresInMs: number } | { ok: false; error: string; code?: 'TOO_FAR' | 'BUSY' | 'NOT_FOUND' | 'PENDING' | 'RATE_LIMITED' | 'BAD_REQUEST' | 'NOT_JOINED' };

/** To the person asked. */
export interface PairRequestMessage { id: string; kind: PairAction; from: string; fromName: string; expiresInMs: number }
/** To both people when a request ends. */
export interface PairClosedMessage { id: string; kind: PairAction; from: string; to: string; accepted: boolean; reason: 'accepted' | 'declined' | 'cancelled' | 'timeout' | 'gone' | 'too-far' }

// ---------------------------------------------------------------- seats

export interface Seat {
  /** Stable for a map: `desk:<object id>`, `t<object id>:<n>`. */
  id: string;
  x: number;
  y: number;
  /** The way a person on this chair faces (towards the table). */
  facing: Facing;
  kind: 'desk' | 'meeting' | 'cafe' | 'game';
}

const kindOf = (f: MapObject): string => String(prop(f, 'kind', 'table')).toLowerCase();
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/**
 * Every chair of a floor, derived from the map: desk chairs (at each desk's seat), chairs above
 * and below meeting tables, either side of café tables, and above and below chess and game
 * tables. Only walkable spots count, so sitting never puts anyone inside a wall or furniture.
 * The office painter draws the chairs at exactly these points.
 */
export function mapSeats(map: OfficeMap, grid: CollisionGrid = buildGrid(map)): Seat[] {
  const T = TILE_SIZE;
  const desks = objectLayer(map, 'desks');
  const out: Seat[] = [];
  const add = (s: Seat) => { if (walkable(grid, s.x, s.y)) out.push(s); };
  for (const d of desks) if (d.height >= 2 * T) add({ id: `desk:${d.id}`, x: d.x + d.width / 2, y: d.y + d.height - T / 2, facing: 'up', kind: 'desk' });
  for (const f of objectLayer(map, 'furniture')) {
    const kind = kindOf(f);
    if (kind === 'table' && !desks.some((d) => overlaps(d, f)) && f.width >= 3 * T && f.height >= 2 * T) {
      let n = 0;
      for (let cx = f.x + T / 2; cx < f.x + f.width; cx += T) {
        add({ id: `t${f.id}:${n++}`, x: cx, y: f.y - T / 2, facing: 'down', kind: 'meeting' });
        add({ id: `t${f.id}:${n++}`, x: cx, y: f.y + f.height + T / 2, facing: 'up', kind: 'meeting' });
      }
    } else if (kind === 'cafe-table') {
      const cy = f.y + f.height / 2;
      add({ id: `t${f.id}:0`, x: f.x - T / 2, y: cy, facing: 'right', kind: 'cafe' });
      add({ id: `t${f.id}:1`, x: f.x + f.width + T / 2, y: cy, facing: 'left', kind: 'cafe' });
    } else if (kind === 'chess-table' || kind === 'game-table') {
      const cx = f.x + f.width / 2;
      add({ id: `t${f.id}:0`, x: cx, y: f.y - T / 2, facing: 'down', kind: 'game' });
      add({ id: `t${f.id}:1`, x: cx, y: f.y + f.height + T / 2, facing: 'up', kind: 'game' });
    }
  }
  return out;
}

/** The nearest seat within reach of a point, if any (`free` filters out taken chairs). */
export function nearestSeat(seats: Seat[], p: Point, free: (s: Seat) => boolean = () => true, reach = SEAT_REACH): Seat | null {
  let best: { s: Seat; d: number } | null = null;
  for (const s of seats) {
    const d = Math.hypot(s.x - p.x, s.y - p.y);
    if (d <= reach && free(s) && (!best || d < best.d)) best = { s, d };
  }
  return best?.s ?? null;
}
