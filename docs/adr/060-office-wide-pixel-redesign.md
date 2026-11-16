# ADR 060: The pixel-art redesign for the whole office, paint only

Date: 2026-11-16. Status: proposed (built and tested locally on `integration/local-qa-2026-11-16`; not pushed, not deployed).
Related: FR-VO-001, FR-VO-015, NFR-PERF-002; ADR 054 (pixel environment), ADR 055 (campus), ADR 057 (arcade redesign).

## Context

The product owner reported that the Virtual Office still did not look like the requested
redesign. Two causes were found on the running app:

1. **Only the arcade had been redesigned.** ADR 057 gave the arcade its own floor, wall colour,
   wall art, signage, rugs and light. Everything else kept the first pass of ADR 054:
   - pale sage carpet with isolated desks;
   - a bare cream reception;
   - pale grid floors in the meeting rooms;
   - plain boards in the lounge;
   - a loud terracotta checkerboard in the café;
   - one cream wall face everywhere, with a picture on roughly one tile in seven.
2. **Workspaces still on the legacy map show no campus at all.** Locally, the three iCET offices have
   the original 60 x 40 map (version 1); only Acme Demo was upgraded to the 100 x 40 campus map.
   This is data, not code: the audited map-upgrade script (ADR 055) is the way to change it. It was
   not run, because a person's workspace map is theirs to upgrade.

No reference image was available, in the repository or on the workstation. The design follows the
written art direction of ADR 054 and the arcade's level of detail (ADR 057).

## Decision

Paint only, in the existing painter (`apps/web/src/lib/office/office-environment.ts`). New palette
entries go in `pixel-kit.ts`: `TEAL`, `SLATE`, `MARBLE`, `BRICK`. No map, tile, object, room, desk,
seat or collision change; nothing new is an object. Every stored map gets the look from its floor
values.

| Area (floor value) | Floor | Wall face | Dressing (all flat paint) |
|---|---|---|---|
| Open office (1) | Teal modular carpet laid quarter-turn, ribbed weave | Teal panelling | Wool rug under every workstation; charcoal task chairs; a mug, succulent, lamp or notebook beside each monitor (clear of the desk label); corkboards, charts, clocks, shelves and pictures on the walls |
| Meeting rooms (3) | Deeper slate-blue carpet, diamond motif | Slate panelling, navy skirting | Patterned slate rug with a gold line under the table; wall displays |
| Private rooms (4) | Maple parquet (unchanged) | Vertical oak boards | Diplomas, shelves |
| Reception (5) | Marble slabs (2 x 2 tiles), veined, gold studs | Navy panelling, gold rail | Compass-rose medallion; brass sconces and photographs |
| Lounge (2) | Oak boards (unchanged) | Exposed brick | Patterned terracotta rugs at the sofas; framed records and sconces |
| Café (7) | Encaustic cement tiles: soft terracotta rings, a small teal star on every other tile | Cream subway tile | Chalkboard menus, mug shelves, a neon coffee cup, sconces; a warm pendant pool over each table |
| Garden (6) | Lawn mown in two-tile stripes | Dressed stone, ivy (unchanged) | Lanterns (unchanged) |
| Arcade (8) | Unchanged (ADR 057) | Unchanged | Unchanged |

All indoor floors have a border band a few pixels in from the walls; it stops at doorways by itself.
Wall art is planned on every third inner wall-face tile from a set that suits the room. The
whiteboards, bookshelves and the reception plaque of ADR 054 keep their places.

Two small companions:

- **Festive garland** (`office-festive.ts`). It now hangs from the coping with a shallower swag,
  so the wall art shows below it. Above the arcade it stays low, clear of the neon signs. The pieces
  and bulbs are the same, so the festive counts do not change.
- **Camera** (`office-renderer.ts`). The user still stays in the middle of the view. When the whole
  map fits on an axis (zoomed out), the map is centred on that axis instead of drifting with the user
  and leaving a large empty band. View only: positions, movement and every map-to-screen conversion
  use the same world transform.
  - A fuller version that also kept the camera inside the map at normal zoom was tried and
    rejected. It moved the user off-centre near the map edges, where the reception spawn is. The
    nudge flow of spec 46 then failed twice: the bell and the result notice next to the canvas edge
    and the floating controls. The office overlays are designed around a centred user.

## Consequences

- Every workspace, on any stored map, gets the redesign without a data change. Legacy maps get it
  for the rooms they have; the campus needs the map upgrade.
- The scene is still painted once into the same 8 textures (`data-env` unchanged); nothing runs per
  frame.
- Wall faces are 15 px high at 1x zoom, so wall art is small by construction. The floors and rugs
  carry most of the change.
- The festive garland moved up 5 px (not above the arcade).
- No package, API, schema or database change.

## Verification (2026-11-16, local)

- Before and after screenshots of the open office, reception, meeting room, lounge, café, arcade,
  garden, the zoomed-out overview and the phone view: `docs/assets/office-redesign-2026-11-16/`.
- Pixel change with the same framing, before against after (a channel moving by more than 24 counts):
  - open office 59%, café 32%, meeting room 27%, reception 24%, lounge 21%;
  - garden 10% and arcade 8% (lawn stripes and garland only);
  - overview 49%, phone office view 48%, phone arcade 0.2%.
- Web typecheck and lint: clean.
- Playwright on the final code: 42 of 42 office tests passed, made up of:
  - specs 16, 25 and 34–38: 21;
  - specs 39, 43, 44 and 46: 12;
  - specs 42 and 45: 9.
- Spec 42 also failed once inside a long combined run: the worker was still `IN_MEETING` from the
  previous spec's call. It passed on its own.
- The rejected clamped camera failed spec 46 twice; that is why it was dropped (see above).
- Browser journeys against the dev app: character choice, movement, actions, nudge with accept, Do
  not disturb, Café, Arcade and Garden, Tic-Tac-Toe.
