# ADR 055: Office campus, mini-games and festive mode

Date: 2026-11-13. Status: proposed (built and tested locally on `feature/office-campus-expansion`; not pushed, not deployed).
Related: FR-VO-001, FR-VO-002, FR-VO-004, NFR-PERF-002; ADR 015 (office), ADR 053 (avatars), ADR 054 (pixel environment).

## Context

The office should grow into a small campus with a café, an arcade and a garden. People walk
there with their avatars, play light mini-games, and see optional Christmas decorations. HR
features, authentication, room permissions, the API contracts, the schema and the movement
engine must not change.

The office map lives in the database per organisation (`offices.map_json`): `ensureOffice` copies
`defaultOffice()` on an organisation's first visit, and the server validates every move against
that stored copy. A walkable campus therefore needs a map the server knows about. Three options
were weighed: extend the default map, paint a non-walkable campus outside the walls, or squeeze
corners into the Lounge. The product owner chose to **extend the default map**. Chess was
**skipped**: there is no chess code in the repository, and a library would be a new dependency.

## Decision

1. **The default map grows from 60 x 40 to 100 x 40 tiles.**
   - The original office keeps every tile, room, desk, furniture piece and the spawn point. A test
     pins their fingerprints.
   - The one change inside it is a three-tile doorway in the Lounge's right wall (column 59,
     rows 33–35).
   - Right of it are a Garden (top), a Café and an Arcade, as OPEN rooms with OPEN access: no room
     call, no access rule. The campus touches the Board room, Focus room and HR office only through
     solid walls, so the only way in is the Lounge. Permissions are unchanged.
   - New floor values are 6 grass, 7 café tiles, 8 arcade carpet and 9 stone path. The schema
     already allows any value from 0 to 255.
   - The new furniture is ordinary `furniture` objects with `collides: true` and a `kind`. Movement,
     collision and pathfinding treat them like any other furniture.
2. **Existing organisations keep their stored map** until an admin replaces it with the existing,
   audited `PUT /office/map`. This is a data step at rollout, not a migration. Locally it was done
   for the demo organisation only. Test organisations are created fresh and get the new map. Rooms
   are synced into the `rooms` table by the existing `syncLayout`, so there is no schema change.
3. **Mini-games are frontend only.** Furniture can carry a `game` property (`tictactoe`, `memory`,
   `puzzle`):
   - six arcade cabinets and two board-game tables carry one;
   - clicking or tapping one walks the avatar to a free spot beside it and opens the game on arrival;
   - standing within reach shows a "Play …" prompt, and E opens the game from the keyboard;
   - the games open in a modal dialog with Close, Escape, a focus trap and focus returned to the map.

   The rules live in `packages/shared/src/office/campus-games.ts` (pure, seeded, unit-tested):
   - Tic-Tac-Toe against an easy computer (the "perfect" level is tested never to lose);
   - Memory Match with 8 pairs;
   - a 3 x 3 sliding puzzle of the player's own character, whose shuffles are always solvable.

   Nothing is sent to the API, nothing is stored, and there are no scores, rewards or accounts.
4. **Art follows ADR 054.** `pixel-kit.ts` holds the shared palette, hash, whole-pixel painter and an
   atlas builder.
   - Tall pieces (trees, arcade cabinets, potted plants) are packed into one atlas and placed in the
     avatar layer, sorted by their base. A person walking behind a tree is hidden by its canopy.
   - Everything else stays in the floor chunks.
   - Garden walls get ivy and lanterns instead of windows.
   - The arcade gets no warm light pool, because it reads as grey on the dark carpet.
5. **Festive mode is a separate layer.** `office-festive.ts` paints:
   - garlands with fairy lights along wall faces, and wreaths beside doorways;
   - decorated firs with gifts in the open areas, and a lit palm in the garden;
   - a ribboned reception counter, candles on café tables, sofa garlands and warm golden glow.

   Trees are placed only on free floor at least two tiles from any doorway. When the mode is on,
   the renderer builds this layer from one atlas plus two `Graphics` of bulbs, which twinkle by
   swapping alpha every 650 ms (not with reduced motion). When it is off, the renderer destroys the
   whole layer and its textures.
   - The office's own furniture and decoration are never part of it.
   - The switch ("Festive mode", `role="switch"`) sits in a new "Appearance" card and is on by default.
   - The choice is saved in `localStorage` (`hrvo.office.festive`), never on the server.
   - Switching does not reload anything.

## Consequences

- One-time paint grows with the map: 3200 x 1280 px of floor in eight chunks (about 16 MB of
  texture), plus two small atlases. Per frame there is nothing new except the twinkle swap and a
  200 ms proximity check in React for the game prompt.
- The office page's first-load JavaScript grows from 121 kB to 140 kB (games, appearance switch,
  shared rules). The PixiJS renderer stays lazy-loaded.
- Tests:
  - `apps/api/test/office-campus.test.ts`: original office fingerprints, the single Lounge doorway,
    reachability, game reach, game rules;
  - room counts updated in `office-e2e`, `office-rules`, e2e 16 and 43;
  - `apps/web/e2e/44-office-campus.spec.ts`: walking through the doorway, permissions, all three
    games by click, tap and E, festive on and off with persistence and no reload, cleanup on
    leaving, and the phone layout.
- The sticky call toolbar can cover the top rows of the map when the page is scrolled, so objects
  under it cannot be clicked until scrolled into view. This is existing page layout, not changed here.
