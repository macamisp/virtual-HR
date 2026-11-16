# ADR 062: Two-player chess and checkers at the office's game tables

Date: 2026-11-16. Status: proposed (built and tested locally on `integration/local-qa-2026-11-16`; not pushed, not deployed).
Related: FR-VO-017; ADR 055 (campus and mini-games), ADR 056 (consent-based pair actions), ADR 058 (nudge).

## Context

The arcade had single-player mini-games (tic-tac-toe, memory, puzzle) and a chess table that was
only furniture. V3 asks for multiplayer chess and checkers between colleagues. No new npm package
may be added without the owner's approval, and the map (room ids, desks, collision) must not change.

## Decision

- **Rules in the shared package** (`packages/shared/src/office/board-games.ts`), written for this
  project with no library:
  - **Chess:** check, checkmate, stalemate, castling (not through or out of check), en passant,
    promotion (queen by default or the piece chosen), the fifty-move rule, and bare kings or a lone
    minor piece as a draw.
  - **Checkers** (English draughts): men move forward diagonally; captures are compulsory;
    multi-jumps continue with the same piece; crowning ends the turn; a player with no pieces or no
    moves loses.
  - The server validates every move with these rules. The browser uses the same functions only to
    highlight legal moves.
- **Where you play.** The arcade's chess table offers both games (a chessboard serves checkers too),
  so no map change is needed. A `game-table` set to `chess` or `checkers` would also work.
- **Flow, on the office socket, modelled on consent-based pair actions:**
  - `office:board-invite`: both people must be at the table, within the game reach.
  - `office:board-answer`: Accept or Decline. A yes is checked again for reach and a free table.
  - `office:board-move`: only the player whose turn it is; illegal moves are refused.
  - `office:board-resign` and `office:board-cancel`.
  - Both players get every snapshot (`office:board`) and the invitation's outcome
    (`office:board-invite-closed`).
  - The person who invited plays white.
- **Refused:**
  - yourself, or someone not at the table;
  - a table without that game, or a table already in use;
  - a person already playing or with an invitation waiting;
  - Do not disturb, or someone away from the office;
  - a second invitation within 3 s, or more than 20 moves in 5 s.
- **Organisation isolation.** Both players are looked up in the caller's own organisation's world,
  found through the authenticated socket. Another organisation's people are "not here".
- **Ending.**
  - A result (checkmate, a draw, resigning) ends the game for both.
  - Leaving the office ends it at once; after a dropped connection it ends when the reload grace
    runs out.
  - A reload within the grace brings the board back.
  - Invitations time out after 30 s.
- **Storage.** In memory only, like nudges and pair requests. A casual game holds no HR or work data,
  so nothing is stored or audited, and nothing touches attendance or status.
- **UI** (`apps/web/src/components/office/board-game.tsx`):
  - a "Game table" card when you stand at the table, listing the colleagues also there;
  - invitation cards with Accept / Decline and Cancel;
  - a board dialog: your side at the bottom, legal targets marked, a promotion choice, check and
    result in a status line, Resign with confirmation, and Close.
  - Squares are labelled buttons, usable by keyboard, screen reader and touch. The chess glyphs are
    forced to text presentation, so no system shows emoji pieces.

## Consequences

- No map, schema or package change. Games are lost if the API restarts. A single API instance holds
  the office (ADR 015), as for every other office interaction.
- Tests:
  - rules unit tests (11);
  - socket end to end `office-board-e2e` (6), with real sockets and another organisation;
  - Playwright 49, two browsers, classic and isometric (2).
