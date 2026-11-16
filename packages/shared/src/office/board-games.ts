/**
 * FR-VO-017 (ADR 062): two-player board games at the office's game tables, chess and checkers.
 * The rules live here, shared: the server validates every move with them (the browser only uses
 * them to show legal moves). Pure functions on plain data; written for this project (no library).
 *
 * The board is 64 squares, index = row * 8 + column, row 0 at the top (black's side), row 7 at the
 * bottom (white's side). White moves first in both games.
 */
import { z } from 'zod';

export const BOARD_GAMES = ['chess', 'checkers'] as const;
export type BoardGameKind = (typeof BOARD_GAMES)[number];
export type Side = 'w' | 'b';
/** Chess: K Q R B N P. Checkers: M (man) and C (crowned king). */
export type PieceType = 'K' | 'Q' | 'R' | 'B' | 'N' | 'P' | 'M' | 'C';
export type Piece = `${Side}${PieceType}`;
export type Promotion = 'Q' | 'R' | 'B' | 'N';

export interface BoardMove { from: number; to: number; promotion?: Promotion }
export type EndReason = 'checkmate' | 'stalemate' | 'insufficient' | 'fifty-moves' | 'no-pieces' | 'no-moves' | 'resigned' | 'left';
export interface BoardResult { winner: Side | null; reason: EndReason }

export interface BoardState {
  kind: BoardGameKind;
  board: Array<Piece | null>;
  turn: Side;
  /** Chess: castling rights, a subset of "KQkq". */
  castling: string;
  /** Chess: the square a pawn may capture en passant onto, or null. */
  ep: number | null;
  /** Chess: half-moves since the last capture or pawn move (fifty-move rule). */
  halfmove: number;
  /** Moves played (plies). */
  plies: number;
  /** Checkers: a piece in the middle of a multi-jump must keep jumping. */
  mustContinue: number | null;
  lastMove: BoardMove | null;
  result: BoardResult | null;
}

const other = (s: Side): Side => (s === 'w' ? 'b' : 'w');
const rowOf = (i: number) => Math.floor(i / 8);
const colOf = (i: number) => i % 8;
const at = (r: number, c: number) => (r >= 0 && r < 8 && c >= 0 && c < 8 ? r * 8 + c : -1);
const sideOf = (p: Piece | null): Side | null => (p ? (p[0] as Side) : null);
const typeOf = (p: Piece | null): PieceType | null => (p ? (p[1] as PieceType) : null);

// ---------------------------------------------------------------- new games

export function newBoard(kind: BoardGameKind): BoardState {
  const board: Array<Piece | null> = new Array(64).fill(null);
  if (kind === 'chess') {
    const back: PieceType[] = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
    back.forEach((t, c) => { board[c] = `b${t}`; board[56 + c] = `w${t}`; board[8 + c] = 'bP'; board[48 + c] = 'wP'; });
  } else {
    for (let r = 0; r < 8; r += 1) for (let c = 0; c < 8; c += 1) {
      if ((r + c) % 2 !== 1) continue;
      if (r <= 2) board[at(r, c)] = 'bM';
      if (r >= 5) board[at(r, c)] = 'wM';
    }
  }
  return { kind, board, turn: 'w', castling: kind === 'chess' ? 'KQkq' : '', ep: null, halfmove: 0, plies: 0, mustContinue: null, lastMove: null, result: null };
}

// ---------------------------------------------------------------- chess

const KNIGHT = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]] as const;
const KING = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]] as const;
const ROOK = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
const BISHOP = [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const;

/** Is square `sq` attacked by any piece of side `by`? */
export function attacked(board: Array<Piece | null>, sq: number, by: Side): boolean {
  const r = rowOf(sq);
  const c = colOf(sq);
  const is = (i: number, types: PieceType[]) => i >= 0 && sideOf(board[i]!) === by && types.includes(typeOf(board[i]!)!);
  const dir = by === 'w' ? 1 : -1; // a white pawn attacks upwards, so it sits one row below
  if (is(at(r + dir, c - 1), ['P']) || is(at(r + dir, c + 1), ['P'])) return true;
  for (const [dr, dc] of KNIGHT) if (is(at(r + dr, c + dc), ['N'])) return true;
  for (const [dr, dc] of KING) if (is(at(r + dr, c + dc), ['K'])) return true;
  const ray = (dirs: ReadonlyArray<readonly [number, number]>, types: PieceType[]) => dirs.some(([dr, dc]) => {
    for (let k = 1; k < 8; k += 1) {
      const i = at(r + dr * k, c + dc * k);
      if (i < 0) return false;
      if (board[i]) return is(i, types);
    }
    return false;
  });
  return ray(ROOK, ['R', 'Q']) || ray(BISHOP, ['B', 'Q']);
}

const kingSquare = (board: Array<Piece | null>, side: Side) => board.findIndex((p) => p === `${side}K`);
export function inCheck(s: BoardState, side: Side = s.turn): boolean {
  if (s.kind !== 'chess') return false;
  const k = kingSquare(s.board, side);
  return k >= 0 && attacked(s.board, k, other(side));
}

function chessPseudo(s: BoardState): BoardMove[] {
  const out: BoardMove[] = [];
  const me = s.turn;
  const add = (from: number, to: number) => {
    const p = s.board[from]!;
    if (typeOf(p) === 'P' && (rowOf(to) === 0 || rowOf(to) === 7)) for (const promotion of ['Q', 'R', 'B', 'N'] as const) out.push({ from, to, promotion });
    else out.push({ from, to });
  };
  for (let i = 0; i < 64; i += 1) {
    const p = s.board[i] ?? null;
    if (sideOf(p) !== me) continue;
    const r = rowOf(i);
    const c = colOf(i);
    const free = (j: number) => j >= 0 && !s.board[j];
    const enemy = (j: number) => j >= 0 && sideOf(s.board[j] ?? null) === other(me);
    switch (typeOf(p)) {
      case 'P': {
        const d = me === 'w' ? -1 : 1;
        const one = at(r + d, c);
        if (free(one)) {
          add(i, one);
          const two = at(r + 2 * d, c);
          if ((me === 'w' ? r === 6 : r === 1) && free(two)) add(i, two);
        }
        for (const dc of [-1, 1]) { const j = at(r + d, c + dc); if (enemy(j) || (j >= 0 && j === s.ep)) add(i, j); }
        break;
      }
      case 'N': for (const [dr, dc] of KNIGHT) { const j = at(r + dr, c + dc); if (j >= 0 && sideOf(s.board[j] ?? null) !== me) add(i, j); } break;
      case 'K': {
        for (const [dr, dc] of KING) { const j = at(r + dr, c + dc); if (j >= 0 && sideOf(s.board[j] ?? null) !== me) add(i, j); }
        // Castling: rights kept, squares between empty, not out of, through or into check.
        const home = me === 'w' ? 60 : 4;
        if (i === home && !attacked(s.board, home, other(me))) {
          const [k, q] = me === 'w' ? ['K', 'Q'] : ['k', 'q'];
          if (s.castling.includes(k!) && !s.board[home + 1] && !s.board[home + 2] && s.board[home + 3] === `${me}R` && !attacked(s.board, home + 1, other(me)) && !attacked(s.board, home + 2, other(me))) out.push({ from: home, to: home + 2 });
          if (s.castling.includes(q!) && !s.board[home - 1] && !s.board[home - 2] && !s.board[home - 3] && s.board[home - 4] === `${me}R` && !attacked(s.board, home - 1, other(me)) && !attacked(s.board, home - 2, other(me))) out.push({ from: home, to: home - 2 });
        }
        break;
      }
      default: {
        const dirs = typeOf(p) === 'R' ? ROOK : typeOf(p) === 'B' ? BISHOP : [...ROOK, ...BISHOP];
        for (const [dr, dc] of dirs) for (let k = 1; k < 8; k += 1) {
          const j = at(r + dr * k, c + dc * k);
          if (j < 0) break;
          if (!s.board[j]) { add(i, j); continue; }
          if (sideOf(s.board[j] ?? null) !== me) add(i, j);
          break;
        }
      }
    }
  }
  return out;
}

/** Plays a chess move without checking legality (the caller generated it). */
function chessApply(s: BoardState, m: BoardMove): BoardState {
  const board = [...s.board];
  const p = board[m.from]!;
  const me = s.turn;
  const captured = board[m.to];
  let ep: number | null = null;
  let capture = !!captured;
  if (typeOf(p) === 'P' && m.to === s.ep) { board[m.to + (me === 'w' ? 8 : -8)] = null; capture = true; }
  board[m.to] = typeOf(p) === 'P' && (rowOf(m.to) === 0 || rowOf(m.to) === 7) ? `${me}${m.promotion ?? 'Q'}` : p;
  board[m.from] = null;
  if (typeOf(p) === 'P' && Math.abs(m.to - m.from) === 16) ep = (m.to + m.from) / 2;
  if (typeOf(p) === 'K' && Math.abs(m.to - m.from) === 2) { // castling: move the rook too
    const kingside = m.to > m.from;
    const rookFrom = kingside ? m.from + 3 : m.from - 4;
    const rookTo = kingside ? m.from + 1 : m.from - 1;
    board[rookTo] = board[rookFrom]!;
    board[rookFrom] = null;
  }
  let castling = s.castling;
  const strip = (sq: number) => {
    if (sq === 60) castling = castling.replace('K', '').replace('Q', '');
    if (sq === 4) castling = castling.replace('k', '').replace('q', '');
    if (sq === 63) castling = castling.replace('K', '');
    if (sq === 56) castling = castling.replace('Q', '');
    if (sq === 7) castling = castling.replace('k', '');
    if (sq === 0) castling = castling.replace('q', '');
  };
  strip(m.from); strip(m.to);
  return { ...s, board, turn: other(me), castling, ep, halfmove: typeOf(p) === 'P' || capture ? 0 : s.halfmove + 1, plies: s.plies + 1, lastMove: { ...m }, mustContinue: null };
}

function chessLegal(s: BoardState): BoardMove[] {
  return chessPseudo(s).filter((m) => {
    const n = chessApply(s, m);
    const k = kingSquare(n.board, s.turn);
    return k >= 0 && !attacked(n.board, k, n.turn);
  });
}

function insufficient(board: Array<Piece | null>): boolean {
  const rest = board.filter((p): p is Piece => !!p && typeOf(p) !== 'K');
  return rest.length === 0 || (rest.length === 1 && (typeOf(rest[0]!) === 'B' || typeOf(rest[0]!) === 'N'));
}

// ---------------------------------------------------------------- checkers (English draughts)

function checkersMovesFrom(s: BoardState, i: number, capturesOnly: boolean): BoardMove[] {
  const p = s.board[i] ?? null;
  if (sideOf(p) !== s.turn) return [];
  const r = rowOf(i);
  const c = colOf(i);
  const forward = s.turn === 'w' ? -1 : 1;
  const dirs = typeOf(p) === 'C' ? [-1, 1] : [forward];
  const out: BoardMove[] = [];
  for (const dr of dirs) for (const dc of [-1, 1]) {
    const step = at(r + dr, c + dc);
    if (step < 0) continue;
    if (!s.board[step]) { if (!capturesOnly) out.push({ from: i, to: step }); continue; }
    const land = at(r + 2 * dr, c + 2 * dc);
    if (sideOf(s.board[step] ?? null) === other(s.turn) && land >= 0 && !s.board[land]) out.push({ from: i, to: land });
  }
  return out;
}

const isJump = (m: BoardMove) => Math.abs(rowOf(m.to) - rowOf(m.from)) === 2;

function checkersLegal(s: BoardState): BoardMove[] {
  if (s.mustContinue !== null) return checkersMovesFrom(s, s.mustContinue, true).filter(isJump);
  const all: BoardMove[] = [];
  for (let i = 0; i < 64; i += 1) all.push(...checkersMovesFrom(s, i, false));
  const jumps = all.filter(isJump);
  return jumps.length ? jumps : all; // captures are compulsory
}

function checkersApply(s: BoardState, m: BoardMove): BoardState {
  const board = [...s.board];
  const p = board[m.from]!;
  board[m.to] = p;
  board[m.from] = null;
  const jumped = isJump(m);
  if (jumped) board[(m.from + m.to) / 2] = null;
  const crowned = typeOf(p) === 'M' && (rowOf(m.to) === (s.turn === 'w' ? 0 : 7));
  if (crowned) board[m.to] = `${s.turn}C`;
  let next: BoardState = { ...s, board, lastMove: { from: m.from, to: m.to }, plies: s.plies + 1, mustContinue: null };
  // A jump that can jump again continues (crowning ends the turn).
  if (jumped && !crowned && checkersMovesFrom({ ...next, turn: s.turn }, m.to, true).some(isJump)) next = { ...next, mustContinue: m.to };
  else next = { ...next, turn: other(s.turn) };
  return next;
}

// ---------------------------------------------------------------- the game

/** Every legal move for the side to move (none once the game is over). */
export function legalMoves(s: BoardState): BoardMove[] {
  if (s.result) return [];
  return s.kind === 'chess' ? chessLegal(s) : checkersLegal(s);
}

const sameMove = (a: BoardMove, b: BoardMove) => a.from === b.from && a.to === b.to && (a.promotion ?? null) === (b.promotion ?? null);

/**
 * Plays a move for the side to move: the next state, or null when the move is not legal. A pawn
 * reaching the last rank without a promotion choice becomes a queen. Ends the game when it is over.
 */
export function playMove(s: BoardState, move: BoardMove): BoardState | null {
  if (s.result) return null;
  const legal = legalMoves(s);
  const m = s.kind === 'chess' && !move.promotion && legal.some((x) => x.from === move.from && x.to === move.to && x.promotion) ? { ...move, promotion: 'Q' as const } : move;
  if (!legal.some((x) => sameMove(x, m))) return null;
  const next = s.kind === 'chess' ? chessApply(s, m) : checkersApply(s, m);
  return { ...next, result: outcome(next) };
}

/** The result once the game is over, or null. */
export function outcome(s: BoardState): BoardResult | null {
  const moves = s.kind === 'chess' ? chessLegal(s) : checkersLegal(s);
  if (s.kind === 'chess') {
    if (!moves.length) return inCheck(s) ? { winner: other(s.turn), reason: 'checkmate' } : { winner: null, reason: 'stalemate' };
    if (insufficient(s.board)) return { winner: null, reason: 'insufficient' };
    if (s.halfmove >= 100) return { winner: null, reason: 'fifty-moves' };
    return null;
  }
  if (!s.board.some((p) => sideOf(p ?? null) === s.turn)) return { winner: other(s.turn), reason: 'no-pieces' };
  if (!moves.length) return { winner: other(s.turn), reason: 'no-moves' };
  return null;
}

/** Square names for people: a1 is white's bottom-left corner. */
export const squareName = (i: number): string => `${'abcdefgh'[colOf(i)]}${8 - rowOf(i)}`;
export const squareOf = (name: string): number => at(8 - Number(name[1]), 'abcdefgh'.indexOf(name[0]!));

// ---------------------------------------------------------------- socket messages

export const BOARD_INVITE_TTL_MS = 30_000;
export const BoardInviteDtoSchema = z.object({ to: z.string().uuid(), tableId: z.number().int().nonnegative(), kind: z.enum(BOARD_GAMES) }).strict();
export const BoardAnswerDtoSchema = z.object({ id: z.string().min(1).max(64), accept: z.boolean() }).strict();
export const BoardMoveDtoSchema = z.object({ id: z.string().min(1).max(64), from: z.number().int().min(0).max(63), to: z.number().int().min(0).max(63), promotion: z.enum(['Q', 'R', 'B', 'N']).optional() }).strict();
export const BoardIdDtoSchema = z.object({ id: z.string().min(1).max(64) }).strict();

/** ADR 064: a stored game state, checked before a game is restored after a restart. */
const PIECES = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'wM', 'wC', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP', 'bM', 'bC'] as const satisfies readonly Piece[];
const SquareSchema = z.number().int().min(0).max(63);
const SideSchema = z.enum(['w', 'b']);
export const BoardStateSchema: z.ZodType<BoardState> = z.object({
  kind: z.enum(BOARD_GAMES),
  board: z.array(z.enum(PIECES).nullable()).length(64),
  turn: SideSchema,
  castling: z.string().regex(/^K?Q?k?q?$/),
  ep: SquareSchema.nullable(),
  halfmove: z.number().int().nonnegative(),
  plies: z.number().int().nonnegative(),
  mustContinue: SquareSchema.nullable(),
  lastMove: z.object({ from: SquareSchema, to: SquareSchema, promotion: z.enum(['Q', 'R', 'B', 'N']).optional() }).strict().nullable(),
  result: z.object({ winner: SideSchema.nullable(), reason: z.enum(['checkmate', 'stalemate', 'insufficient', 'fifty-moves', 'no-pieces', 'no-moves', 'resigned', 'left']) }).strict().nullable(),
}).strict();

export interface BoardPlayer { id: string; name: string }
/** What both players see after every change. */
export interface BoardSnapshot {
  id: string;
  kind: BoardGameKind;
  tableId: number;
  white: BoardPlayer;
  black: BoardPlayer;
  state: BoardState;
  check: boolean;
}
export interface BoardInviteMessage { id: string; from: string; fromName: string; kind: BoardGameKind; tableId: number; expiresInMs: number }
export interface BoardInviteClosed { id: string; reason: 'declined' | 'cancelled' | 'timeout' | 'gone' | 'too-far' | 'accepted' | 'busy' }
export type BoardAck = { ok: true; id?: string } | { ok: false; error: string; code?: string };
