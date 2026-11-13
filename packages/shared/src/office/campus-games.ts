/**
 * Rules of the campus mini-games (ADR 055): Tic-Tac-Toe against the computer, Memory Match and a
 * sliding picture puzzle. Pure, framework-free and deterministic for a given seed, so the UI is a
 * thin layer and the rules are unit-tested. Frontend only: nothing is sent to the API or stored,
 * there are no scores, rewards or accounts involved.
 */
import { objectLayer, prop } from './map.ts';
import type { MapObject, OfficeMap } from './map.ts';
import { CAMPUS_GAMES } from './default-map.ts';
import type { CampusGame } from './default-map.ts';

export const CAMPUS_GAME_LABEL: Record<CampusGame, string> = { tictactoe: 'Tic-Tac-Toe', memory: 'Memory Match', puzzle: 'Sliding Puzzle' };

export function isCampusGame(v: unknown): v is CampusGame {
  return typeof v === 'string' && (CAMPUS_GAMES as readonly string[]).includes(v);
}

/** The furniture of a floor that opens a game (property `game` with a known value). */
export function gameObjects(map: OfficeMap): Array<{ object: MapObject; game: CampusGame }> {
  const out: Array<{ object: MapObject; game: CampusGame }> = [];
  for (const o of objectLayer(map, 'furniture')) {
    const g = prop(o, 'game', '');
    if (isCampusGame(g)) out.push({ object: o, game: g });
  }
  return out;
}

/** Distance from a point to a rectangle's nearest edge (0 inside). */
export function distanceToRect(p: { x: number; y: number }, r: { x: number; y: number; width: number; height: number }): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

/** Close enough to play: about one tile from the object's edge. */
export const GAME_REACH = 40;

/** A small seeded random generator (mulberry32), so a seed always deals the same game. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- Tic-Tac-Toe

export type Mark = 'X' | 'O';
export type TicBoard = Array<Mark | null>;
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]] as const;

export const emptyBoard = (): TicBoard => Array<Mark | null>(9).fill(null);

/** The winner and the winning line, 'draw' on a full board, or null while the game goes on. */
export function ticResult(b: TicBoard): { winner: Mark; line: readonly number[] } | 'draw' | null {
  for (const line of LINES) {
    const [a, c, d] = line;
    const m = b[a];
    if (m && m === b[c] && m === b[d]) return { winner: m, line };
  }
  return b.every(Boolean) ? 'draw' : null;
}

/** A new board with `mark` on `cell`, or null when the move is not allowed. */
export function ticPlay(b: TicBoard, cell: number, mark: Mark): TicBoard | null {
  if (!Number.isInteger(cell) || cell < 0 || cell > 8 || b[cell] || ticResult(b)) return null;
  const next = [...b];
  next[cell] = mark;
  return next;
}

function minimax(b: TicBoard, turn: Mark, me: Mark, depth: number): number {
  const r = ticResult(b);
  if (r === 'draw') return 0;
  if (r) return r.winner === me ? 10 - depth : depth - 10;
  const other: Mark = turn === 'X' ? 'O' : 'X';
  let best = turn === me ? -Infinity : Infinity;
  for (let i = 0; i < 9; i += 1) {
    if (b[i]) continue;
    b[i] = turn;
    const score = minimax(b, other, me, depth + 1);
    b[i] = null;
    best = turn === me ? Math.max(best, score) : Math.min(best, score);
  }
  return best;
}

/**
 * The computer's move. `level` 'easy' plays a random free cell a third of the time (so a person
 * can win), 'perfect' never loses. Ties go to the first best cell in reading order.
 */
export function ticComputerMove(b: TicBoard, me: Mark, level: 'easy' | 'perfect' = 'easy', random: () => number = Math.random): number | null {
  const free = b.map((m, i) => (m ? -1 : i)).filter((i) => i >= 0);
  if (!free.length || ticResult(b)) return null;
  if (level === 'easy' && random() < 1 / 3) return free[Math.floor(random() * free.length)]!;
  const other: Mark = me === 'X' ? 'O' : 'X';
  let best = -Infinity;
  let move = free[0]!;
  const work = [...b];
  for (const i of free) {
    work[i] = me;
    const score = minimax(work, other, me, 1);
    work[i] = null;
    if (score > best) { best = score; move = i; }
  }
  return move;
}

// ---------------------------------------------------------------- Memory Match

export interface MemoryCard { face: number; matched: boolean }
export interface MemoryState { cards: MemoryCard[]; open: number[]; moves: number }

/** `pairs` pairs of faces 0..pairs-1, shuffled by the seed. */
export function memoryDeal(pairs: number, seed: number): MemoryState {
  const faces = Array.from({ length: pairs * 2 }, (_, i) => i % pairs);
  const rnd = seededRandom(seed);
  for (let i = faces.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [faces[i], faces[j]] = [faces[j]!, faces[i]!];
  }
  return { cards: faces.map((face) => ({ face, matched: false })), open: [], moves: 0 };
}

/**
 * Turn a card. A matching second card stays face up; a different one stays visible until
 * memoryHide (the UI waits a moment). Turning a third card first hides the unmatched pair.
 */
export function memoryFlip(s: MemoryState, i: number): MemoryState {
  const card = s.cards[i];
  if (!card || card.matched || s.open.includes(i)) return s;
  const base = s.open.length === 2 ? memoryHide(s) : s;
  const open = [...base.open, i];
  if (open.length < 2) return { ...base, open };
  const [a, b] = open as [number, number];
  const moves = base.moves + 1;
  if (base.cards[a]!.face !== base.cards[b]!.face) return { ...base, open, moves };
  const cards = base.cards.map((c, k) => (k === a || k === b ? { ...c, matched: true } : c));
  return { cards, open: [], moves };
}

export function memoryHide(s: MemoryState): MemoryState {
  return s.open.length === 2 ? { ...s, open: [] } : s;
}

export const memoryWon = (s: MemoryState): boolean => s.cards.length > 0 && s.cards.every((c) => c.matched);

// ---------------------------------------------------------------- Sliding puzzle

/** Tiles 1..n²-1 in reading order, 0 = the gap. */
export type PuzzleTiles = number[];

export const puzzleSolved = (t: PuzzleTiles): boolean => t.every((v, i) => (i === t.length - 1 ? v === 0 : v === i + 1));

function neighbours(size: number, i: number): number[] {
  const r = Math.floor(i / size);
  const c = i % size;
  const out: number[] = [];
  if (r > 0) out.push(i - size);
  if (r < size - 1) out.push(i + size);
  if (c > 0) out.push(i - 1);
  if (c < size - 1) out.push(i + 1);
  return out;
}

/** Slide the tile at `i` into the gap if they touch; otherwise the same tiles. */
export function puzzleMove(t: PuzzleTiles, i: number): PuzzleTiles {
  const size = Math.round(Math.sqrt(t.length));
  const gap = t.indexOf(0);
  if (!neighbours(size, gap).includes(i)) return t;
  const next = [...t];
  next[gap] = next[i]!;
  next[i] = 0;
  return next;
}

/**
 * A shuffled board that is always solvable: random legal slides from the solved board (never
 * straight back), and never the solved board itself.
 */
export function puzzleShuffle(size: number, seed: number, slides = size * size * 12): PuzzleTiles {
  const rnd = seededRandom(seed);
  let t: PuzzleTiles = [...Array.from({ length: size * size - 1 }, (_, i) => i + 1), 0];
  let prev = -1;
  for (let k = 0; k < slides || puzzleSolved(t); k += 1) {
    const gap = t.indexOf(0);
    const options = neighbours(size, gap).filter((n) => n !== prev);
    const pickIdx = options[Math.floor(rnd() * options.length)]!;
    t = puzzleMove(t, pickIdx);
    prev = gap;
  }
  return t;
}
