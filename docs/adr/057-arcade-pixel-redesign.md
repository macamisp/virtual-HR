# ADR 057: Arcade pixel-art redesign, paint only

Date: 2026-11-15. Status: proposed (built and tested locally on `feature/arcade-pixel-redesign`; not pushed, not deployed).
Related: FR-VO-015, FR-VO-001, NFR-PERF-002; ADR 054 (pixel environment), ADR 055 (campus), ADR 056 (seats).

## Context

The Arcade (ADR 055) was a dark confetti carpet with three plain cabinet colours. The product
owner wants it to look like a polished retro game room: wooden floor, colourful cabinets, neon
signs, posters, rugs, plants, depth and light. This is the first phase of a larger plan, and it
must be safe: the stored map of every organisation, movement, collision, room access, the
mini-games, the office socket, the API and the database must not change. No reference image was
available while this was built; the design follows the written brief.

## Decision

1. **Paint only, in the existing painter.** All of it is drawing code in
   `apps/web/src/lib/office/office-environment.ts`, with new palette entries in `pixel-kit.ts`
   (`WALNUT`, `INDIGO`, `VIOLET`, `NEON`, `NIGHT`). `default-map.ts` is untouched: no tile, object,
   id, room or dimension changes, so nothing has to be upgraded for existing organisations and the
   look applies to any stored map that uses the arcade floor value (8). The renderer, the festive
   layer, the avatars and the game components are not changed.
2. **What is painted.**
   - **Floor.** Walnut boards (the existing staggered-plank routine), a small diamond inlay every
     third tile, and a dark border with a brass line along the walls. The border stops at doorways
     by itself, because a doorway tile is not a wall.
   - **Walls.** Arcade-facing wall faces are deep indigo instead of cream, with a neon tube under
     the coping (pink and cyan sections). The walls beside and below the room carry a tube on the
     edge that faces the room (cyan, pink, purple) and a faint wash of that colour on the boards.
     Door jambs are painted after the tubes and stay oak.
   - **Neon signs.** One sign per row of cabinets that stands against a wall ("ARCADE",
     "GAME ON"): a dark board on the wall band above the cabinets, 5 x 7 capitals at double size,
     each drawn as halo, tube and bright core. A sign is only placed when every tile under it is
     wall face.
   - **Wall art.** Every arcade wall-face tile that a cabinet does not hide gets one piece, kept
     inside its own tile: a small lamp under a sign; elsewhere, in turn, a rocket poster, a ringed
     planet poster, a neon star, a neon bolt, a plant shelf and a sunset-grid poster.
   - **Cabinets.** Six liveries (two per game, alternating): lit marquee with the game's emblem,
     speaker, dark screen showing the game with scanlines and a glare, joystick, three buttons,
     coin door with lit slots, side stripes, kick plate and a line of under-glow. Each cabinet
     also lights the boards in front of it in its own colour, in three flat steps.
   - **Rugs.** A blue rug under the ping-pong table, a round violet one under the chess table,
     teal ones under the two game tables, and a magenta one in front of the sofa. They are clipped
     to the room and lie under the furniture.
   - **Furniture.** The arcade sofa is violet (the sofa painter takes a palette). Tables, beanbags
     and plants keep their art.
3. **Original artwork.** Everything is drawn from rectangles in this repository. The signs say
   generic words, the posters show a rocket, a planet and a sunset, and the cabinet screens show
   the campus's own three games. No logo, character or artwork of any existing game is used.
4. **Rules kept from ADR 054.** Whole-pixel fills only, variation by position hash, no image
   assets (so the CSP and the deployment are unchanged), and decoration never sits on a doorway.
   Nothing painted here is an object: the collision grid, `mapSeats`, `gameObjects` and room
   bounds are read, never written.
5. **Performance.** The scene is still painted once per map into the same floor chunks (eight for
   the default map) and one prop atlas. No canvas, texture, sprite, ticker callback or per-frame
   work is added, so there is nothing to release that was not released before. Sampling
   (nearest-neighbour, linear when zoomed far out) is unchanged.
6. **No motion.** Neon and glow are static paint in this phase, so `prefers-reduced-motion`
   needs no special case. Animated neon, if wanted later, belongs in a renderer layer like the
   festive bulbs and must be off under reduced motion.

## Consequences

- An organisation on the original 60 x 40 map sees no difference (it has no arcade floor). One on
  the campus map sees the new arcade after the web deployment, with no data step.
- The room label "Arcade" is still partly covered by the first cabinet. That is the renderer's
  label position and the map's cabinet position, both out of scope here.
- Festive mode draws its garlands on the wall faces as before; they now hang over indigo walls.
  The signs sit above the faces and are not covered.
- Tests: `apps/web/e2e/43-office-environment.spec.ts` gains an arcade test at 1440 x 900,
  390 x 844 and with reduced motion: still eight textures, a walk across a rug and out through
  the top doorway, one scene after leaving and returning, no console error. The map fingerprints
  in `apps/api/test/office-campus.test.ts` are unchanged and still pass.

## Screenshots

In `docs/assets/office-arcade/`, taken from the running app (festive mode off unless named):
`before-desktop-centre.png` and `before-desktop-top.png` against `after-desktop-centre.png` and
`after-desktop-top.png` (1440 x 900), `after-desktop-zoom-top.png` (cabinets and signs close up),
`after-desktop-festive-top.png`, `after-mobile-page.png` (390 x 844) and
`after-reduced-centre.png` (reduced motion; identical art, since nothing moves).
