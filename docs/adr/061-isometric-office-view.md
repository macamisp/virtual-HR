# ADR 061: An isometric view of the office (in progress)

Date: 2026-11-16. Status: proposed. Phase A (projection) is built locally on
`integration/local-qa-2026-11-16`, behind a browser-local switch. Phases B–E wait for the
product owner's reference image. Not pushed, not deployed.
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
