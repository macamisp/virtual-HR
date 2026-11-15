/**
 * Avatar nudge (ADR 058, FR-VO-016): a bell on a nearby colleague's avatar. The colleague gets a
 * notification with Accept and Ignore; both people see how it ended. Shared by the API
 * (validation, rules) and the browser (bell, notification). Purely social: it is not stored, and
 * it changes no position, status, attendance, work time or meeting.
 */
import { z } from 'zod';

/** How close the other person must be (px), on the same floor and in the same room. */
export const NUDGE_REACH_PX = 160;
/** The same person can be nudged again by the same sender after this (ms). */
export const NUDGE_COOLDOWN_MS = 30_000;
/** An unanswered nudge expires after this (ms). */
export const NUDGE_TTL_MS = 20_000;
/** Whatever the recipient: at most this many nudges per sender per minute. */
export const NUDGES_PER_MINUTE = 6;
/** Unanswered nudges one person can have waiting; further senders are told the person is busy. */
export const NUDGE_MAX_WAITING = 5;

/** The rules in force on this server (the defaults above unless the operator changed them). */
export interface NudgeRules { reachPx: number; cooldownMs: number; ttlMs: number }
export const DEFAULT_NUDGE_RULES: NudgeRules = { reachPx: NUDGE_REACH_PX, cooldownMs: NUDGE_COOLDOWN_MS, ttlMs: NUDGE_TTL_MS };

const bounded = (v: string | undefined, fallback: number, min: number, max: number): number => {
  const n = v === undefined || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/**
 * OFFICE_NUDGE_REACH_PX (32..640), OFFICE_NUDGE_COOLDOWN_MS (0..600 000) and OFFICE_NUDGE_TTL_MS
 * (1 000..120 000). Anything missing or not a number keeps the default.
 */
export function nudgeRules(env: Record<string, string | undefined>): NudgeRules {
  return {
    reachPx: bounded(env.OFFICE_NUDGE_REACH_PX, NUDGE_REACH_PX, 32, 640),
    cooldownMs: bounded(env.OFFICE_NUDGE_COOLDOWN_MS, NUDGE_COOLDOWN_MS, 0, 600_000),
    ttlMs: bounded(env.OFFICE_NUDGE_TTL_MS, NUDGE_TTL_MS, 1_000, 120_000),
  };
}

interface Placed { floorId: string | null; roomId: string | null; x: number; y: number }
/** Near enough to nudge: same floor, same room (or both in the open), within reach. */
export function nudgeReach(a: Placed, b: Placed, reachPx: number): boolean {
  return a.floorId !== null && a.floorId === b.floorId && a.roomId === b.roomId && Math.hypot(a.x - b.x, a.y - b.y) <= reachPx;
}

// ---------------------------------------------------------------- socket DTOs

export const NudgeDtoSchema = z.object({ to: z.string().uuid() }).strict();
export const NudgeAnswerDtoSchema = z.object({ id: z.string().uuid(), accept: z.boolean() }).strict();
export const NudgeCancelDtoSchema = z.object({ id: z.string().uuid() }).strict();

export type NudgeRefusal = 'SELF' | 'NOT_FOUND' | 'TOO_FAR' | 'DND' | 'AWAY' | 'PENDING' | 'BUSY' | 'COOLDOWN' | 'RATE_LIMITED' | 'BAD_REQUEST' | 'NOT_JOINED';
export type NudgeAck =
  | { ok: true; id: string; expiresInMs: number }
  /** `retryInMs`: with COOLDOWN and RATE_LIMITED, how long until it can be sent. */
  | { ok: false; error: string; code: NudgeRefusal; retryInMs?: number };
export type NudgeAnswerAck = { ok: true } | { ok: false; error: string; code: 'NOT_OPEN' | 'BAD_REQUEST' | 'NOT_JOINED' };

/** How a nudge ended. `gone`: one of the two left the office or lost the connection. */
export const NUDGE_OUTCOMES = ['accepted', 'ignored', 'cancelled', 'expired', 'gone'] as const;
export type NudgeOutcome = (typeof NUDGE_OUTCOMES)[number];

/** To the person nudged (event `office:nudge-request`). */
export interface NudgeRequestMessage { id: string; from: string; fromName: string; expiresInMs: number }
/** To both people when it ends (event `office:nudge-closed`). */
export interface NudgeClosedMessage { id: string; from: string; to: string; outcome: NudgeOutcome }
