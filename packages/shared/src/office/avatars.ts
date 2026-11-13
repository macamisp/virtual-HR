/**
 * Pixel-art office avatars (FR-VO-002, ADR 053): the allowlist of character presets, the
 * spritesheet layout, and the walk animation as pure, framework-free functions so that the API,
 * the PixiJS renderer and the tests share one definition.
 *
 * The art itself is generated from code in avatar-art.ts (no image asset is copied or loaded).
 */
import { z } from 'zod';

// ---------------------------------------------------------------- presets (allowlist)

/** Every selectable character. The database CHECK constraint on users.vo_avatar_key lists the same keys. */
export const AVATAR_KEYS = ['sage', 'river', 'ember', 'juniper', 'sol', 'indigo'] as const;
export type AvatarKey = (typeof AVATAR_KEYS)[number];
/** What every existing and new user has until they choose. */
export const DEFAULT_AVATAR_KEY: AvatarKey = 'sage';

export const AvatarKeySchema = z.enum(AVATAR_KEYS);
/** PUT /office/me/avatar. Strict: the user is always the caller; nothing else is accepted. */
export const AvatarDtoSchema = z.object({ avatarKey: AvatarKeySchema }).strict();
export type AvatarDto = z.infer<typeof AvatarDtoSchema>;

export function isAvatarKey(v: unknown): v is AvatarKey {
  return typeof v === 'string' && (AVATAR_KEYS as readonly string[]).includes(v);
}

/** A known key, or the default (an unknown value from an older or newer peer never breaks drawing). */
export function avatarKeyOr(v: unknown): AvatarKey {
  return isAvatarKey(v) ? v : DEFAULT_AVATAR_KEY;
}

// ---------------------------------------------------------------- spritesheet layout

/** One frame is 32 x 32 pixels, one office tile. */
export const AVATAR_SIZE = 32;
/** Column groups of the sheet, in this order. */
export const FACINGS = ['down', 'left', 'right', 'up'] as const;
export type Facing = (typeof FACINGS)[number];
/** Frames per facing: standing, then the two walking steps. */
export const AVATAR_FRAMES = ['idle', 'stepA', 'stepB'] as const;
export type AvatarFrame = 0 | 1 | 2;

/** ADR 056: action poses, after the walk frames on each row. */
export const AVATAR_POSES = [
  'sit-down', 'sit-left', 'sit-right', 'sit-up', 'wave-a', 'wave-b', 'dance-a', 'dance-b', 'jump-crouch', 'jump-air', 'hug-right', 'hug-left', 'highfive-right', 'highfive-left',
] as const;
export type AvatarPose = (typeof AVATAR_POSES)[number];

/** Rows are presets (AVATAR_KEYS order); columns are facing x frame, then the action poses. */
export const WALK_COLUMNS = FACINGS.length * AVATAR_FRAMES.length;
export const SHEET_COLUMNS = WALK_COLUMNS + AVATAR_POSES.length;
export const SHEET_WIDTH = SHEET_COLUMNS * AVATAR_SIZE;
export const SHEET_HEIGHT = AVATAR_KEYS.length * AVATAR_SIZE;

export function sheetCell(key: AvatarKey, facing: Facing, frame: AvatarFrame): { x: number; y: number; width: number; height: number } {
  const col = FACINGS.indexOf(facing) * AVATAR_FRAMES.length + frame;
  return { x: col * AVATAR_SIZE, y: AVATAR_KEYS.indexOf(key) * AVATAR_SIZE, width: AVATAR_SIZE, height: AVATAR_SIZE };
}

export function poseCell(key: AvatarKey, pose: AvatarPose): { x: number; y: number; width: number; height: number } {
  return { x: (WALK_COLUMNS + AVATAR_POSES.indexOf(pose)) * AVATAR_SIZE, y: AVATAR_KEYS.indexOf(key) * AVATAR_SIZE, width: AVATAR_SIZE, height: AVATAR_SIZE };
}

// ---------------------------------------------------------------- direction

/**
 * The office's eight movement directions (0 = east, counter-clockwise in 45° steps; the value the
 * client sends in office:move) from a movement vector in screen coordinates (y grows downwards).
 */
export function dirFromDelta(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  return ((Math.round(Math.atan2(-dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
}

const CARDINAL: Record<number, Facing> = { 0: 'right', 2: 'up', 4: 'left', 6: 'down' };
/** The two cardinal facings a diagonal is made of. */
const DIAGONAL: Record<number, readonly [Facing, Facing]> = { 1: ['up', 'right'], 3: ['up', 'left'], 5: ['down', 'left'], 7: ['down', 'right'] };

/**
 * Four sprite facings from an eight-way direction. A diagonal keeps the last facing when it is one
 * of the diagonal's two parts (walking up-right after walking up still faces up), otherwise it
 * faces sideways, which reads best for a side-on walk.
 */
export function facingFromDir(dir: number, last: Facing): Facing {
  const d = ((Math.round(dir) % 8) + 8) % 8;
  const c = CARDINAL[d];
  if (c) return c;
  const pair = DIAGONAL[d]!;
  return pair.includes(last) ? last : pair[1];
}

// ---------------------------------------------------------------- animation

/** About seven frames a second while walking. */
export const AVATAR_FPS = 7;
export const AVATAR_FRAME_MS = 1000 / AVATAR_FPS;
/**
 * Below this speed (px per ms; 12 px/s against a walking speed of 200 px/s) the avatar is standing.
 * Remote avatars ease towards their latest position, so their speed fades out instead of stopping.
 */
export const WALK_MIN_SPEED = 0.012;
/**
 * Faster than this (5x the walking speed) is a jump, not a step: a teleport, a server correction
 * snapping the avatar back, or a re-sync. No walking frame and no turn for it.
 */
export const WALK_MAX_SPEED = 1;

export interface AvatarAnimation {
  facing: Facing;
  walking: boolean;
  frame: AvatarFrame;
  /** Time spent on the current walking frame. */
  elapsedMs: number;
}

export function createAnimation(facing: Facing = 'down'): AvatarAnimation {
  return { facing, walking: false, frame: 0, elapsedMs: 0 };
}

/**
 * Advances one avatar by one rendered frame from how far it actually moved (dx, dy in px) in
 * dtMs. Inferred from positions only, so it works the same for the own avatar and for everyone
 * else, and needs no extra network message. Mutates and returns `a`.
 *
 * - Not moving (stopped, or blocked by a wall): the standing frame at once, facing kept.
 * - Moving: faces the movement; the first walking frame at once, then alternates every ~143 ms.
 * - A jump (teleport): standing, facing kept.
 */
export function stepAnimation(a: AvatarAnimation, dx: number, dy: number, dtMs: number): AvatarAnimation {
  if (dtMs <= 0) return a;
  const speed = Math.hypot(dx, dy) / dtMs;
  if (speed < WALK_MIN_SPEED || speed > WALK_MAX_SPEED) {
    a.walking = false;
    a.frame = 0;
    a.elapsedMs = 0;
    return a;
  }
  a.facing = facingFromDir(dirFromDelta(dx, dy), a.facing);
  if (!a.walking) {
    a.walking = true;
    a.frame = 1;
    a.elapsedMs = 0;
    return a;
  }
  a.elapsedMs += dtMs;
  while (a.elapsedMs >= AVATAR_FRAME_MS) {
    a.elapsedMs -= AVATAR_FRAME_MS;
    a.frame = a.frame === 1 ? 2 : 1;
  }
  return a;
}
