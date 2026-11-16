/**
 * Board game rules (FR-VO-017, ADR 062): chess and checkers as the server enforces them. Pure
 * functions; no server, no database.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inCheck, legalMoves, newBoard, playMove, squareOf } from '../../../packages/shared/src/office/board-games.ts';
import type { BoardState, Piece } from '../../../packages/shared/src/office/board-games.ts';

const sq = squareOf;
/** Plays moves given as "e2e4" (and "e7e8q" for a promotion); fails on the first illegal one. */
function play(s: BoardState, ...moves: string[]): BoardState {
  for (const m of moves) {
    const promotion = m[4]?.toUpperCase() as 'Q' | 'R' | 'B' | 'N' | undefined;
    const next = playMove(s, { from: sq(m.slice(0, 2)), to: sq(m.slice(2, 4)), ...(promotion ? { promotion } : {}) });
    assert.ok(next, `${m} should be legal`);
    s = next;
  }
  return s;
}
/** A position from a list of pieces: { e1: 'wK', ... }. */
function position(kind: 'chess' | 'checkers', pieces: Record<string, Piece>, turn: 'w' | 'b' = 'w', castling = ''): BoardState {
  const s = newBoard(kind);
  const board: Array<Piece | null> = new Array(64).fill(null);
  for (const [name, p] of Object.entries(pieces)) board[sq(name)] = p;
  return { ...s, board, turn, castling };
}

describe('Chess rules', () => {
  it('starts with 20 moves for white; illegal and out-of-turn moves are refused', () => {
    const s = newBoard('chess');
    assert.equal(legalMoves(s).length, 20);
    assert.equal(playMove(s, { from: sq('e2'), to: sq('e5') }), null, 'a pawn cannot jump three squares');
    assert.equal(playMove(s, { from: sq('e7'), to: sq('e5') }), null, 'black cannot move first');
    assert.equal(playMove(s, { from: sq('g1'), to: sq('g3') }), null, 'a knight moves in an L');
  });

  it("fool's mate is checkmate for black; no move is legal afterwards", () => {
    const s = play(newBoard('chess'), 'f2f3', 'e7e5', 'g2g4', 'd8h4');
    assert.deepEqual(s.result, { winner: 'b', reason: 'checkmate' });
    assert.equal(inCheck(s), true);
    assert.deepEqual(legalMoves(s), []);
    assert.equal(playMove(s, { from: sq('a2'), to: sq('a3') }), null);
  });

  it('a pinned piece cannot move; the king cannot walk into check', () => {
    const s = position('chess', { e1: 'wK', e2: 'wB', e8: 'bR', a8: 'bK' });
    assert.ok(legalMoves(s).every((m) => m.from !== sq('e2')), 'the bishop is pinned to the king');
    const t = position('chess', { e1: 'wK', d8: 'bR', a8: 'bK' });
    assert.ok(!legalMoves(t).some((m) => m.to === sq('d1') || m.to === sq('d2')), 'the d-file is covered by the rook');
  });

  it('castling on both sides moves the rook; not through check, not after the king moved', () => {
    const base = position('chess', { e1: 'wK', h1: 'wR', a1: 'wR', e8: 'bK' }, 'w', 'KQ');
    const k = play(base, 'e1g1');
    assert.equal(k.board[sq('f1')], 'wR'); assert.equal(k.board[sq('g1')], 'wK'); assert.equal(k.castling, '');
    const q = play(base, 'e1c1');
    assert.equal(q.board[sq('d1')], 'wR'); assert.equal(q.board[sq('c1')], 'wK');
    const through = position('chess', { e1: 'wK', h1: 'wR', e8: 'bK', f8: 'bR' }, 'w', 'K');
    assert.equal(playMove(through, { from: sq('e1'), to: sq('g1') }), null, 'f1 is attacked');
    const moved = play(base, 'e1e2', 'e8e7', 'e2e1', 'e7e8');
    assert.equal(playMove(moved, { from: sq('e1'), to: sq('g1') }), null, 'the king has moved');
  });

  it('en passant right after the double step only', () => {
    const s = play(newBoard('chess'), 'e2e4', 'a7a6', 'e4e5', 'd7d5');
    const ep = play(s, 'e5d6');
    assert.equal(ep.board[sq('d5')], null, 'the passed pawn is taken');
    assert.equal(ep.board[sq('d6')], 'wP');
    const late = play(s, 'h2h3', 'h7h6');
    assert.equal(playMove(late, { from: sq('e5'), to: sq('d6') }), null, 'only on the next move');
  });

  it('promotion: a queen by default, or the piece chosen', () => {
    const s = position('chess', { a7: 'wP', e1: 'wK', h8: 'bK' });
    assert.equal(play(s, 'a7a8').board[sq('a8')], 'wQ');
    assert.equal(play(s, 'a7a8n').board[sq('a8')], 'wN');
  });

  it('stalemate and bare kings are draws', () => {
    const stale = play(position('chess', { a8: 'bK', c7: 'wQ', b5: 'wK' }, 'w'), 'b5b6');
    assert.deepEqual(stale.result, { winner: null, reason: 'stalemate' });
    const bare = play(position('chess', { e1: 'wK', e8: 'bK', d2: 'bP' }, 'w'), 'e1d2');
    assert.deepEqual(bare.result, { winner: null, reason: 'insufficient' });
  });
});

describe('Checkers rules', () => {
  it('starts with 12 men each and 7 moves for white; men move diagonally forward only', () => {
    const s = newBoard('checkers');
    assert.equal(s.board.filter((p) => p === 'wM').length, 12);
    assert.equal(s.board.filter((p) => p === 'bM').length, 12);
    assert.equal(legalMoves(s).length, 7);
    assert.ok(legalMoves(s).every((m) => m.to < m.from), 'white moves up the board');
  });

  it('captures are compulsory and remove the jumped piece', () => {
    const s = position('checkers', { c3: 'wM', d4: 'bM', h2: 'wM' });
    const moves = legalMoves(s);
    assert.deepEqual(moves.map((m) => [m.from, m.to]), [[sq('c3'), sq('e5')]], 'only the capture');
    const after = play(s, 'c3e5');
    assert.equal(after.board[sq('d4')], null);
    assert.equal(after.turn, 'b');
  });

  it('a multi-jump continues with the same piece; the turn passes after the last jump', () => {
    const s = position('checkers', { a1: 'wM', b2: 'bM', d4: 'bM', h8: 'bM' });
    const one = play(s, 'a1c3');
    assert.equal(one.turn, 'w'); assert.equal(one.mustContinue, sq('c3'));
    assert.deepEqual(legalMoves(one).map((m) => m.to), [sq('e5')]);
    const two = play(one, 'c3e5');
    assert.equal(two.turn, 'b'); assert.equal(two.mustContinue, null);
  });

  it('a man reaching the far row is crowned and then moves both ways; no pieces left loses', () => {
    const s = play(position('checkers', { b7: 'wM', h2: 'bM' }), 'b7a8');
    assert.equal(s.board[sq('a8')], 'wC');
    const back = play(s, 'h2g1', 'a8b7', 'g1h2', 'b7a8');
    assert.equal(back.board[sq('a8')], 'wC');
    const win = play(position('checkers', { c3: 'wM', d4: 'bM' }), 'c3e5');
    assert.deepEqual(win.result, { winner: 'w', reason: 'no-pieces' });
  });
});
