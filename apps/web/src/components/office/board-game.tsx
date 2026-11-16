'use client';

/**
 * FR-VO-017 (ADR 062): chess and checkers with a colleague at an office game table. The server holds
 * the game and checks every move; this shows the board, highlights the legal moves (the same shared
 * rules) and sends the move clicked. Keyboard, screen reader and touch friendly.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Crown, Flag, Swords, X } from 'lucide-react';
import { distanceToRect, GAME_REACH, legalMoves, objectLayer, prop, squareName } from '@hrvo/shared';
import type { BoardGameKind, BoardMove, MapObject, OfficeMap, Piece, Promotion, Side } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import type { OfficeClient } from '@/lib/office/office-client';
import { cn } from '@/lib/utils';

const GAME_LABEL: Record<BoardGameKind, string> = { chess: 'Chess', checkers: 'Checkers' };
const TABLE_REACH = GAME_REACH + 12;

/** The board-game table the own avatar stands at, and which games it offers. */
export function boardTableNear(client: OfficeClient): { object: MapObject; kinds: BoardGameKind[] } | null {
  const self = client.self;
  const floor = self ? client.snapshot.floors.find((f) => f.id === self.floorId) : undefined;
  if (!self || !floor) return null;
  let best: { object: MapObject; kinds: BoardGameKind[]; d: number } | null = null;
  for (const o of objectLayer(floor.map as OfficeMap, 'furniture')) {
    const kind = String(prop(o, 'kind', '')).toLowerCase();
    const game = String(prop(o, 'game', '')).toLowerCase();
    const kinds: BoardGameKind[] = kind === 'chess-table' ? ['chess', 'checkers'] : kind === 'game-table' && (game === 'chess' || game === 'checkers') ? [game] : [];
    if (!kinds.length) continue;
    const d = distanceToRect(self, o);
    if (d <= TABLE_REACH && (!best || d < best.d)) best = { object: o, kinds, d };
  }
  return best ? { object: best.object, kinds: best.kinds } : null;
}

/** Colleagues also standing at this table (same floor). */
function colleaguesAt(client: OfficeClient, table: MapObject): Array<{ id: string; name: string }> {
  const self = client.self;
  if (!self) return [];
  const out: Array<{ id: string; name: string }> = [];
  for (const a of client.avatars.values()) {
    const r = client.roster.get(a.id);
    if (!r || r.floorId !== self.floorId || a.away) continue;
    if (distanceToRect({ x: a.x, y: a.y }, table) <= TABLE_REACH) out.push({ id: a.id, name: r.name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** At a game table: pick a game and invite a colleague who is at the table too. */
export function BoardPrompt({ client }: { client: OfficeClient }) {
  const at = boardTableNear(client);
  const [kind, setKind] = useState<BoardGameKind>('chess');
  if (!at || client.board || client.boardInviteOut || client.boardInvitesIn.length) return null;
  const game = at.kinds.includes(kind) ? kind : at.kinds[0]!;
  const people = colleaguesAt(client, at.object);
  return (
    <div className="absolute left-2 top-2 z-10 w-64 max-w-[calc(100%-4rem)] rounded-md border bg-background/95 p-3 text-sm shadow-lg" data-testid="board-prompt">
      <p className="flex items-center gap-2 font-medium"><Swords aria-hidden="true" className="h-4 w-4" /> Game table</p>
      {at.kinds.length > 1 ? (
        <div role="group" aria-label="Game" className="mt-2 flex gap-1">
          {at.kinds.map((k) => <Button key={k} size="sm" variant={game === k ? 'default' : 'outline'} aria-pressed={game === k} onClick={() => setKind(k)}>{GAME_LABEL[k]}</Button>)}
        </div>
      ) : null}
      {people.length === 0 ? <p className="mt-2 text-muted-foreground">Ask a colleague to join you at the table to play {GAME_LABEL[game].toLowerCase()}.</p> : (
        <ul className="mt-2 space-y-1">
          {people.map((p) => (
            <li key={p.id}><Button size="sm" variant="outline" className="w-full justify-start" onClick={() => void client.inviteToBoard(p.id, at.object.id, game)}>Invite {p.name} to {GAME_LABEL[game].toLowerCase()}</Button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Invitations to me (Accept / Decline) and the one I sent (Cancel). */
export function BoardInvites({ client }: { client: OfficeClient }) {
  const out = client.boardInviteOut;
  if (!out && client.boardInvitesIn.length === 0) return null;
  return (
    <div className="absolute left-2 top-2 z-20 w-72 max-w-[calc(100%-4rem)] space-y-2" aria-live="polite">
      {client.boardInvitesIn.map((i) => (
        <div key={i.id} className="rounded-md border bg-background p-3 text-sm shadow-lg" data-testid="board-invite" role="alertdialog" aria-label={`${i.fromName} invites you to ${GAME_LABEL[i.kind].toLowerCase()}`}>
          <p><strong>{i.fromName}</strong> invites you to a game of {GAME_LABEL[i.kind].toLowerCase()}.</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => void client.answerBoardInvite(i.id, true)}>Accept</Button>
            <Button size="sm" variant="outline" onClick={() => void client.answerBoardInvite(i.id, false)}>Decline</Button>
          </div>
        </div>
      ))}
      {out ? (
        <div className="rounded-md border bg-background p-3 text-sm shadow-lg" data-testid="board-pending">
          <p>Waiting for {out.toName} to answer your {GAME_LABEL[out.kind].toLowerCase()} invitation…</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => client.cancelBoardInvite()}>Cancel</Button>
        </div>
      ) : null}
    </div>
  );
}

/** Solid chess glyphs, forced to text presentation (U+FE0E) so no system shows a colour emoji. */
const CHESS_GLYPH: Record<string, string> = { K: '♚\uFE0E', Q: '♛\uFE0E', R: '♜\uFE0E', B: '♝\uFE0E', N: '♞\uFE0E', P: '♟\uFE0E' };
const PIECE_NAME: Record<string, string> = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn', M: 'man', C: 'king' };
const REASON: Record<string, string> = { checkmate: 'checkmate', stalemate: 'stalemate', insufficient: 'not enough pieces to mate', 'fifty-moves': 'fifty moves without a capture', 'no-pieces': 'no pieces left', 'no-moves': 'no moves left', resigned: 'resigned', left: 'left the office' };
const pieceLabel = (p: Piece | null) => (p ? `${p[0] === 'w' ? 'white' : 'black'} ${PIECE_NAME[p[1]!]}` : 'empty');

function PieceView({ piece, kind }: { piece: Piece; kind: BoardGameKind }) {
  const white = piece[0] === 'w';
  if (kind === 'chess') {
    return (
      <span aria-hidden="true" style={{ fontFamily: '"DejaVu Sans", "Segoe UI Symbol", "Noto Sans Symbols 2", serif', fontVariantEmoji: 'text' } as React.CSSProperties}
        className={cn('text-[1.6rem] leading-none sm:text-[1.9rem]', white ? 'text-[#fdf6e3] [text-shadow:0_1px_0_#1f2937,1px_0_0_#1f2937,-1px_0_0_#1f2937,0_-1px_0_#1f2937]' : 'text-[#0b0f17] [text-shadow:0_1px_0_#f8fafc80,1px_0_0_#f8fafc80,-1px_0_0_#f8fafc80,0_-1px_0_#f8fafc80]')}>
        {CHESS_GLYPH[piece[1]!]}
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={cn('flex h-[72%] w-[72%] items-center justify-center rounded-full border-2 shadow-[inset_0_-3px_0_rgba(0,0,0,0.25)]', white ? 'border-[#7c2d12] bg-[#f97316]' : 'border-black bg-[#1f2937]')}>
      {piece[1] === 'C' ? <Crown className={cn('h-4 w-4', white ? 'text-[#fff7ed]' : 'text-[#fbbf24]')} /> : null}
    </span>
  );
}

/** The game: the board with my side at the bottom, whose turn it is, resign and close. */
export function BoardDialog({ client }: { client: OfficeClient }) {
  const g = client.board;
  const meId = client.snapshot.me.id;
  const id = useId();
  const box = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [promote, setPromote] = useState<{ from: number; to: number } | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const mySide: Side | null = g ? (g.white.id === meId ? 'w' : g.black.id === meId ? 'b' : null) : null;
  const moves = useMemo<BoardMove[]>(() => (g && mySide && g.state.turn === mySide && !g.state.result ? legalMoves(g.state) : []), [g, mySide]);
  useEffect(() => { setSelected(g?.state.mustContinue ?? null); setPromote(null); }, [g?.state.plies, g?.state.mustContinue, g]);
  useEffect(() => { box.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus(); }, [g?.id]);
  if (!g || !mySide) return null;
  const opponent = mySide === 'w' ? g.black : g.white;
  const myTurn = g.state.turn === mySide && !g.state.result;
  const targets = new Set(selected === null ? [] : moves.filter((m) => m.from === selected).map((m) => m.to));
  const movable = new Set(moves.map((m) => m.from));
  const order = [...Array(64).keys()];
  if (mySide === 'b') order.reverse();
  const click = (sq: number) => {
    if (!myTurn) return;
    if (selected !== null && targets.has(sq)) {
      const options = moves.filter((m) => m.from === selected && m.to === sq);
      if (options.some((m) => m.promotion)) { setPromote({ from: selected, to: sq }); return; }
      void client.boardMove(selected, sq);
      setSelected(null);
      return;
    }
    if (g.state.mustContinue !== null) return;
    setSelected(movable.has(sq) ? (selected === sq ? null : sq) : null);
  };
  const r = g.state.result;
  const status = r
    ? r.winner ? `${r.winner === mySide ? 'You win' : `${opponent.name} wins`} (${r.reason === 'resigned' || r.reason === 'left' ? `${r.winner === mySide ? opponent.name : 'you'} ${REASON[r.reason]}` : REASON[r.reason]})` : `Draw (${REASON[r.reason]})`
    : myTurn ? `Your turn${g.check ? ': check!' : ''}${g.state.mustContinue !== null ? ': keep jumping with the same piece' : ''}` : `${opponent.name}'s turn`;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-2 sm:items-center">
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} data-testid="board-dialog" data-game={g.kind} data-turn={g.state.turn} data-result={r ? `${r.winner ?? 'draw'}:${r.reason}` : ''}
        className="max-h-[calc(100dvh-1rem)] w-full max-w-md overflow-y-auto rounded-lg border-2 border-[#2e3d5a] bg-background p-4 shadow-xl">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 id={`${id}-t`} className="flex items-center gap-2 text-lg font-semibold"><Swords aria-hidden="true" className="h-5 w-5 text-[#c2363b]" /> {GAME_LABEL[g.kind]} with {opponent.name}</h2>
          {r ? <Button size="sm" variant="ghost" data-autofocus onClick={() => client.closeBoard()} aria-label="Close the game"><X aria-hidden="true" /> Close</Button> : null}
        </div>
        <p className="mb-2 text-sm" role="status" data-testid="board-status">{status}</p>
        <p className="mb-2 text-xs text-muted-foreground">You play {mySide === 'w' ? (g.kind === 'chess' ? 'white' : 'orange') : (g.kind === 'chess' ? 'black' : 'dark')}; {g.white.name} moves first.</p>
        <div role="group" aria-label={`${GAME_LABEL[g.kind]} board`} className="grid aspect-square w-full grid-cols-8 overflow-hidden rounded border-2 border-[#3b2a1e]">
          {order.map((sq) => {
            const piece = g.state.board[sq] ?? null;
            const dark = (Math.floor(sq / 8) + (sq % 8)) % 2 === 1;
            const last = g.state.lastMove && (g.state.lastMove.from === sq || g.state.lastMove.to === sq);
            return (
              <button key={sq} type="button" data-testid={`sq-${squareName(sq)}`} aria-label={`${squareName(sq)}, ${pieceLabel(piece)}${targets.has(sq) ? ', you can move here' : ''}`}
                aria-pressed={selected === sq} disabled={!myTurn && !piece}
                onClick={() => click(sq)}
                className={cn('relative flex aspect-square items-center justify-center focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#2563eb]',
                  dark ? 'bg-[#8b5a3c]' : 'bg-[#f0d9b5]', last && 'after:absolute after:inset-0 after:bg-[#facc15]/30', selected === sq && 'ring-4 ring-inset ring-[#2563eb]')}>
                {piece ? <PieceView piece={piece} kind={g.kind} /> : null}
                {targets.has(sq) ? <span aria-hidden="true" className={cn('absolute rounded-full bg-[#1d4ed8]/50', piece ? 'inset-1 border-4 border-[#1d4ed8]/60 bg-transparent' : 'h-3 w-3')} /> : null}
              </button>
            );
          })}
        </div>
        {promote ? (
          <div role="group" aria-label="Promote the pawn to" className="mt-2 flex flex-wrap items-center gap-1 text-sm" data-testid="board-promotion">
            Promote to:
            {(['Q', 'R', 'B', 'N'] as Promotion[]).map((p) => <Button key={p} size="sm" variant="outline" onClick={() => { void client.boardMove(promote.from, promote.to, p); setPromote(null); setSelected(null); }}>{PIECE_NAME[p]}</Button>)}
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">Moves played: {g.state.plies}</p>
          {!r ? (confirmResign
            ? <span className="flex gap-1"><Button size="sm" variant="destructive" onClick={() => client.resignBoard()}>Yes, resign</Button><Button size="sm" variant="outline" onClick={() => setConfirmResign(false)}>Keep playing</Button></span>
            : <Button size="sm" variant="outline" data-autofocus onClick={() => setConfirmResign(true)}><Flag aria-hidden="true" /> Resign</Button>) : null}
        </div>
      </div>
    </div>
  );
}

