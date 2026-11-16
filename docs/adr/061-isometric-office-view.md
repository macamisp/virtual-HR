# ADR 061: An isometric view of the office (in progress)

Date: 2026-11-16. Status: proposed. Phase A (projection) and phase B (isometric artwork) are built
locally on `integration/local-qa-2026-11-16`, behind a browser-local switch; the default view is
unchanged. Not pushed, not deployed.

## Phase B (2026-11-16): isometric artwork

**Reference.** The product owner's image (an isometric pixel-art arcade room) was given as
`docs/assets/office-redesign-2026-11-16/reference-isometric-office.png`. It was found in
`~/Downloads` and copied there. It is kept out of git: it is third-party artwork showing real
brands and characters. We follow its style, never its logos or characters: every piece here is
original.

**What was built** (`apps/web/src/lib/office/office-iso.ts`; renderer wiring in `office-renderer.ts`):

- **Scale.** 0.75: a tile is a 48 x 24 diamond, and the 32 px characters stand about two thirds of a
  tile wide, as in the reference. At zoom 2 the pixel scale is close to the reference's.
- **Floors.** Diamond stamps painted per material, with a wool rug under every workstation,
  patterned rugs under meeting tables, sofas and game tables, soft light under desks and café
  pendants, and wall shadows. The materials:
  - honey planks in the arcade, oak in the lounge;
  - white and pale-blue tiles in reception;
  - a terracotta and cream checkerboard in the café;
  - teal carpet in the office, slate in meeting rooms;
  - parquet, lawn and flagstones.
- **Walls.** Thin slabs (11 px in from each free tile edge, joined at corners), standing and sorted
  with the avatars:
  - tall (76 px) where nothing is behind them (the map's back edges);
  - medium (52 px) between rooms, turning see-through while the user stands behind one;
  - a low kerb at the front edges.
  
  Faces are dressed by the room in front:
  - arcade: brick on one wall line and light-blue plaster with a navy stripe on the other, as in the reference;
  - lounge: brick; café: brick and cream plaster;
  - office and meeting rooms: plaster with a skirting stripe;
  - private rooms: oak boards; reception: navy panelling with a gold rail;
  - garden: hedges.
  
  Wall art (windows, whiteboards, clocks, original posters, neon stars, shelves) is placed on tall
  and medium walls.
- **Furniture,** from each furniture rectangle, outlined with lit and shaded faces:
  - arcade cabinets with the classic angled side profile, a lit marquee, a reclined screen showing
    their game, a control deck and a coin door;
  - cocktail game tables with the game on the glass top, and a chess table, both with stools;
  - a ping-pong table with a net; desks with a monitor, keyboard and a personal item;
  - task, meeting and café chairs at every seat, their backs sorted against the person sitting;
  - meeting tables, sofas, the reception counter, the coffee counter, bookshelves and café tables
    with pendant lamps;
  - the fountain, benches, flower beds, loungers, trees, plants and beanbags.
- **Labels and festive mode.** Room names are drawn above everything; desk names sit at the front
  of each desk. In festive mode the upright Christmas trees stay, while the top-down garlands and
  fairy lights are not shown in this view.
- **Clicks.** A click on a cabinet's or game table's body opens its game, even where the body rises
  above its footprint.

**Compared with the reference** (side-by-side sheets were made locally; they are not committed,
because they contain the reference):

| Matches | Differs |
|---|---|
| 2:1 isometric projection | The reference is drawn at about 2x our pixel scale (zoom 2 matches) |
| Honey planks running diagonally | The reference room is packed (racing seats, fridge, toys); ours holds only the stored map's furniture (6 cabinets, 3 game tables, ping-pong, sofa, beanbags), because adding standing objects means changing map data |
| Brick and light-blue plaster with a navy stripe on the two wall lines | The reference's back walls are taller; ours are medium where another area lies behind them (the garden behind the arcade), to keep it visible |
| Thin, cut-away walls | No raised tiled platform with steps (the map has no height) |
| Dark outlines, lit left and shaded right faces | Fewer small decorations on cabinets and walls |
| Upright cabinets with marquee, reclined screen and deck | |
| Sit-down cocktail tables with stools | |
| Characters about two thirds of a tile wide | |

**Verification.**

- Web typecheck and lint: clean.
- Default view: Playwright office specs 16, 25, 34–39 and 42–46, 37/37.
- Isometric view, local probe:
  - W gives map (−82, −92);
  - a click 120 px right lands at exactly (+80, −80);
  - a cabinet opens its game;
  - a nudge goes through the colleague's overlay;
  - no page errors.
- Isometric view, the full office journey: character, movement, actions, nudge, DND, Café, Arcade,
  Garden and Tic-Tac-Toe.
- Screenshots: `docs/assets/isometric-2026-11-16/`:
  - `iso-desktop-*`, `iso-zoom2-*` and `iso-phone-*`;
  - the top-down "before" views as `top-before-*`.

**Open:**

- In headless Chromium (software rendering) the isometric view runs at about 10–12 fps against
  15–30 fps for the top-down view. It draws about 700 more sorted sprites (one per wall tile).
  This needs checking on a real GPU before `iso` becomes the default.
- Making `iso` the default is the product owner's decision.
Related: FR-VO-001, FR-VO-002, FR-VO-015; ADR 015 (office), ADR 053–060.

## Context

The product owner wants a genuinely isometric 2D pixel-art office (isometric floor, brick and
interior walls with height, furniture with depth, arcade machines with angled surfaces), similar to
a reference image. They chose **true isometric** over a three-quarter top-down view. ADR 060's paint
improvements did not meet that requirement.

The server, movement, collision, desks, seats, rooms and games all work on a flat top-down grid of
32 px tiles. That must not change: desk assignments, multiplayer, mini-games and attendance depend
on it.

## Decision

**The isometric look is a view, not a new map.** Everything stays on the grid; only the browser
projects it. A map point (x, y) is shown at (x − y, (x + y) / 2): a 2:1 isometric view in which a
tile is a 64 x 32 diamond.

Phase A (done) is `apps/web/src/lib/office/projection.ts` plus the renderer and page changes:

- **Floor-flat layers.** The environment chunks and the festive layer sit in a `ground` container
  that carries the projection matrix.
- **Standing things.** Avatars, tall props, labels and proximity links stay upright, at projected
  points. They are sorted by x + y (further down the screen is in front).
- **Screen to map.** Every conversion goes through the projection and its exact inverse:
  click-to-go, game spots, avatar overlays and menus, the nudge bell, and the camera, which centres
  on the projected position and on the projected map extent when it fits.
- **Animation.** Walk animation uses the on-screen movement, so a character faces the way it
  visibly walks.
- **Keyboard.** WASD and the arrows mean screen directions. In the isometric view they are turned
  into map diagonals (W walks up the screen). The client still sends grid moves; the server is
  unchanged.
- **The switch.** `localStorage['hrvo.office.view'] = 'iso'`, in this browser only. The default
  stays `top` until the isometric artwork is done; `data-view` on the office canvas reports the view.
  With `top`, the projection is the identity and the office behaves exactly as before.

Phases B–E (planned):

- **B.** Isometric floor tiles and walls with height (brick and interior faces, doorways cut
  through, walls in front of a person faded), painted natively in projected space instead of
  projecting the top-down paint.
- **C.** Furniture with depth, built from the existing furniture rectangles (desks, chairs, sofas,
  counters, shelves, arcade machines with angled screens, café and garden pieces), as upright pieces
  sorted with the avatars.
- **D.** Character scale against the new furniture, matched to the reference.
- **E.** Side-by-side comparison with the reference (Main Office, Café, Arcade, Garden; desktop and
  phone), the office and HR test suites, and two-player browser checks. Then `iso` becomes the
  default.

## Consequences

- No server, API, schema, map or data change in any phase.
- Projecting the existing top-down paint (the Phase A state) gives an isometric floor, but flat walls
  and furniture seen from above. It is a scaffold, not the finished look.
- A projected map is larger on screen (100 x 40 tiles is 4480 x 2240 px at zoom 1).
- Office tests that click or hover the map work through the same conversions. The default view is
  covered by the existing suite. The isometric mechanics are covered by a local probe:
  - keyboard directions (W gives map (−61, −61));
  - click to go, with an exact (+60, −60);
  - opening a game from its cabinet;
  - a nudge through the colleague's overlay.
