'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Coffee, Gamepad2, Gift, Heart, Leaf, Moon, Music, RotateCcw, Star, Sun, X } from 'lucide-react';
import {
  AVATAR_SIZE, CAMPUS_GAME_LABEL, memoryDeal, memoryFlip, memoryHide, memoryWon, puzzleMove, puzzleShuffle, puzzleSolved, sheetCell, ticComputerMove, ticPlay, ticResult, emptyBoard,
} from '@hrvo/shared';
import type { AvatarKey, CampusGame, MemoryState, PuzzleTiles, TicBoard } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { sharedAvatarSheet } from '@/lib/office/avatar-sheet';
import { cn } from '@/lib/utils';

/**
 * ADR 055: the campus mini-games. Frontend only: no API call, nothing saved, no scores kept, no
 * rewards. Each opens in a modal dialog over the office (Escape or Close returns to the map).
 */

const newSeed = () => Math.floor(Math.random() * 2 ** 31);

// ---------------------------------------------------------------- Tic-Tac-Toe

function TicTacToe() {
  const [board, setBoard] = useState<TicBoard>(emptyBoard);
  const [wins, setWins] = useState({ you: 0, computer: 0, draws: 0 });
  const result = ticResult(board);
  const status = result === 'draw' ? 'A draw.' : result ? (result.winner === 'X' ? 'You win!' : 'The computer wins.') : 'Your turn: you are X.';
  const play = (cell: number) => {
    const mine = ticPlay(board, cell, 'X');
    if (!mine) return;
    let next = mine;
    if (!ticResult(mine)) {
      const reply = ticComputerMove(mine, 'O', 'easy');
      if (reply !== null) next = ticPlay(mine, reply, 'O') ?? mine;
    }
    setBoard(next);
    const r = ticResult(next);
    if (r) setWins((w) => (r === 'draw' ? { ...w, draws: w.draws + 1 } : r.winner === 'X' ? { ...w, you: w.you + 1 } : { ...w, computer: w.computer + 1 }));
  };
  const line = result && result !== 'draw' ? result.line : [];
  return (
    <div className="space-y-3">
      <p role="status" className="text-sm font-medium" data-testid="game-status">{status}</p>
      <div role="group" aria-label="Tic-Tac-Toe board" className="mx-auto grid w-fit grid-cols-3 gap-1 rounded-md bg-[#2e3d5a] p-1">
        {[0, 1, 2].map((r) => (
          <div key={r} className="contents">
            {[0, 1, 2].map((c) => {
              const i = r * 3 + c;
              const m = board[i];
              return (
                <button
                  key={i}
                  type="button"
                  data-testid={`ttt-${i}`}
                  aria-label={`Row ${r + 1}, column ${c + 1}: ${m ?? 'empty'}`}
                  aria-disabled={!!m || !!result}
                  onClick={() => play(i)}
                  className={cn(
                    'flex h-16 w-16 items-center justify-center rounded-sm bg-[#fbf6ea] font-mono text-3xl font-bold sm:h-20 sm:w-20',
                    m === 'X' ? 'text-[#c2363b]' : 'text-[#2f7a46]',
                    line.includes(i) && 'bg-[#f3d48a]',
                    !m && !result && 'hover:bg-[#f3ead8] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#d9a94e]',
                  )}
                >
                  {m ?? ''}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>You {wins.you} · Computer {wins.computer} · Draws {wins.draws}</span>
        <Button size="sm" variant="outline" onClick={() => setBoard(emptyBoard())}><RotateCcw aria-hidden="true" /> New game</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Memory Match

const FACES = [Coffee, Leaf, Star, Heart, Sun, Moon, Music, Gift];
const FACE_NAMES = ['coffee', 'leaf', 'star', 'heart', 'sun', 'moon', 'music', 'gift'];
const FACE_COLOURS = ['#9c5a3c', '#3d7242', '#d9a94e', '#c2363b', '#e08a2e', '#4a5d82', '#8f3b76', '#2f7a46'];

function MemoryMatch() {
  const [state, setState] = useState<MemoryState>(() => memoryDeal(8, newSeed()));
  const won = memoryWon(state);
  // An unmatched pair stays visible for a moment, then turns back.
  useEffect(() => {
    if (state.open.length !== 2) return undefined;
    const t = setTimeout(() => setState((s) => memoryHide(s)), 900);
    return () => clearTimeout(t);
  }, [state.open]);
  const found = state.cards.filter((c) => c.matched).length / 2;
  return (
    <div className="space-y-3">
      <p role="status" className="text-sm font-medium" data-testid="game-status">{won ? `All pairs found in ${state.moves} moves!` : `Pairs found: ${found} of 8 · moves: ${state.moves}`}</p>
      <div role="group" className="mx-auto grid w-fit grid-cols-4 gap-1.5" aria-label="Memory cards">
        {state.cards.map((c, i) => {
          const up = c.matched || state.open.includes(i);
          const Icon = FACES[c.face]!;
          return (
            <button
              key={i}
              type="button"
              data-testid={`card-${i}`}
              data-face={up ? c.face : undefined}
              aria-label={up ? `Card ${i + 1}: ${FACE_NAMES[c.face]}${c.matched ? ', matched' : ''}` : `Card ${i + 1}: face down`}
              aria-pressed={up}
              aria-disabled={c.matched}
              onClick={() => setState((s) => memoryFlip(s, i))}
              className={cn(
                'flex h-14 w-14 items-center justify-center rounded-md border-2 transition-colors sm:h-16 sm:w-16',
                up ? 'border-[#d8cbb0] bg-[#fbf6ea]' : 'border-[#652a54] bg-[#8f3b76] hover:bg-[#a2468a]',
                c.matched && 'opacity-70',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#d9a94e]',
              )}
            >
              {up ? <Icon aria-hidden="true" className="h-7 w-7" style={{ color: FACE_COLOURS[c.face] }} /> : <span aria-hidden="true" className="h-3 w-3 rounded-sm bg-[#d9a94e]" />}
            </button>
          );
        })}
      </div>
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={() => setState(memoryDeal(8, newSeed()))}><RotateCcw aria-hidden="true" /> Shuffle and restart</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Sliding puzzle

const SIZE = 3;
const PIECE = 64;

/** One piece of the picture (the player's own character, scaled up) on a small canvas. */
function PuzzlePiece({ value, picture }: { value: number; picture: AvatarKey }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx || value === 0) return;
    ctx.imageSmoothingEnabled = false;
    const n = value - 1;
    const cell = sheetCell(picture, 'down', 0);
    const part = AVATAR_SIZE / SIZE;
    ctx.fillStyle = '#e9dec7';
    ctx.fillRect(0, 0, PIECE, PIECE);
    ctx.drawImage(sharedAvatarSheet(), cell.x + (n % SIZE) * part, cell.y + Math.floor(n / SIZE) * part, part, part, 0, 0, PIECE, PIECE);
  }, [value, picture]);
  return <canvas ref={ref} width={PIECE} height={PIECE} aria-hidden="true" className="block h-full w-full [image-rendering:pixelated]" />;
}

function SlidingPuzzle({ picture }: { picture: AvatarKey }) {
  const [tiles, setTiles] = useState<PuzzleTiles>(() => puzzleShuffle(SIZE, newSeed()));
  const [moves, setMoves] = useState(0);
  const solved = puzzleSolved(tiles);
  const gap = tiles.indexOf(0);
  const slide = (i: number) => {
    if (solved) return;
    const next = puzzleMove(tiles, i);
    if (next !== tiles) { setTiles(next); setMoves((m) => m + 1); }
  };
  return (
    <div className="space-y-3">
      <p role="status" className="text-sm font-medium" data-testid="game-status">{solved ? `Solved in ${moves} moves!` : `Slide the pieces to rebuild your character · moves: ${moves}`}</p>
      <div role="group" className="mx-auto grid w-fit grid-cols-3 gap-1 rounded-md bg-[#2e3d5a] p-1" aria-label="Puzzle">
        {tiles.map((v, i) => {
          const r = Math.floor(i / SIZE);
          const c = i % SIZE;
          const movable = v !== 0 && Math.abs(Math.floor(gap / SIZE) - r) + Math.abs((gap % SIZE) - c) === 1;
          return v === 0 ? (
            <div key="gap" data-testid="puzzle-gap" className="h-20 w-20 rounded-sm bg-[#1a2438]" aria-hidden="true" />
          ) : (
            <button
              key={v}
              type="button"
              data-testid={`piece-${v}`}
              aria-label={`Piece ${v}${movable ? ', next to the gap' : ''}`}
              aria-disabled={solved || !movable}
              onClick={() => slide(i)}
              className={cn('relative h-20 w-20 overflow-hidden rounded-sm bg-[#e9dec7]', movable && !solved && 'ring-2 ring-[#d9a94e]', 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#f3d48a]')}
            >
              <PuzzlePiece value={v} picture={picture} />
              <span aria-hidden="true" className="absolute left-0.5 top-0.5 rounded-sm bg-black/45 px-1 font-mono text-[10px] text-white">{v}</span>
            </button>
          );
        })}
      </div>
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={() => { setTiles(puzzleShuffle(SIZE, newSeed())); setMoves(0); }}><RotateCcw aria-hidden="true" /> Shuffle</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- dialog and prompt

/** A modal dialog for one game; Escape or Close returns focus to the map. */
export function GameDialog({ game, picture, onClose }: { game: CampusGame; picture: AvatarKey; onClose: () => void }) {
  const id = useId();
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, []);
  // Escape closes the game wherever focus is (a finished board can leave it on the page body);
  // the listener goes away with the dialog.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onDocKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); } };
    document.addEventListener('keydown', onDocKey);
    return () => document.removeEventListener('keydown', onDocKey);
  }, []);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    // Keep focus inside the dialog.
    const items = [...(box.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])];
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-2 sm:items-center" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        data-testid="game-dialog"
        data-game={game}
        onKeyDown={onKey}
        className="max-h-[calc(100dvh-1rem)] w-full max-w-sm overflow-y-auto rounded-lg border-2 border-[#2e3d5a] bg-background p-4 shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id={`${id}-t`} className="flex items-center gap-2 text-lg font-semibold"><Gamepad2 aria-hidden="true" className="h-5 w-5 text-[#c2363b]" /> {CAMPUS_GAME_LABEL[game]}</h2>
          <Button size="sm" variant="ghost" data-autofocus onClick={onClose} aria-label="Close the game and return to the office"><X aria-hidden="true" /> Close</Button>
        </div>
        {game === 'tictactoe' ? <TicTacToe /> : game === 'memory' ? <MemoryMatch /> : <SlidingPuzzle picture={picture} />}
        <p className="mt-3 text-xs text-muted-foreground">Just for fun: nothing is saved and your work time is not affected.</p>
      </div>
    </div>
  );
}

/** Shown over the map when the avatar stands next to a game: click it, or press E. */
export function GamePrompt({ game, onPlay }: { game: CampusGame; onPlay: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-10 flex justify-center">
      <Button size="sm" data-testid="game-prompt" className="pointer-events-auto shadow-lg" onClick={onPlay}>
        <Gamepad2 aria-hidden="true" /> Play {CAMPUS_GAME_LABEL[game]} <kbd className="ml-1 rounded border border-white/40 px-1 text-[10px]">E</kbd>
      </Button>
    </div>
  );
}
