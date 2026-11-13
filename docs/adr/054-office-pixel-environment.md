# ADR 054: Pixel-art office environment, painted in code

Date: 2026-11-13. Status: proposed (built and tested locally on `feature/office-pixel-environment`; not pushed, not deployed).
Related: FR-VO-001, NFR-PERF-002; ADR 015 (office, PixiJS renderer), ADR 053 (pixel avatars).

## Context

The office map was drawn as flat coloured rectangles: one colour per floor style, slate walls,
rounded boxes for furniture. With the pixel-art avatars (ADR 053) the map looked unfinished. We
want a detailed, original pixel-art office without changing anything that is not paint: the map
format, tiles, walkability, doors, furniture footprints, desk seats, movement, rooms, networking,
calls. No new packages, no image assets, no backend or database change.

## Decision

1. **A painter module, separate from the renderer.** `apps/web/src/lib/office/office-environment.ts`
   reads the same map as the collision grid (floor and wall tiles, rooms, desks, furniture) and
   paints the static scene with whole-pixel rectangles on the 32 px grid. There are no gradients,
   blur, anti-aliased curves or filters. Variation (plank tones, speckles, book spines, pictures)
   is a hash of the tile position, so a map always looks the same.
2. **Painted once, shown as textures.** `renderEnvironment(map)` returns canvases of at most
   1024 px (four for the default 1920 x 1280 map; the largest allowed map stays under every GPU
   texture limit). The renderer shows each as a sprite and keeps room and desk labels on top. The
   scene is rebuilt only when the floor changes. The old `cacheAsTexture` is gone, because the
   canvases are the cache. Textures are released when the floor changes and when the renderer is
   destroyed. The avatar layer, proximity links and camera are untouched.
3. **Art direction.** Warm oak, deep navy, cream and ivory, sage, muted terracotta, foliage green
   and golden light. Floors stay light so the avatars' dark name labels remain readable.
   - Floors: sage carpet tiles (open area), oak boards with staggered joints (lounge), cool woven
     carpet tiles (meeting rooms), maple basket-weave parquet (private rooms), ivory stone with
     sage inlays (reception). An unknown floor value gets a neutral stone tile.
   - Walls: a navy top with a lit rim and dark outer edges. Where floor lies below a wall tile,
     its lower part is a cream panelled front face with an oak skirting board. Walls cast stepped
     shadows on the floor.
   - Doorways: a gap of up to six tiles in a wall line gets an oak sill and oak jambs on the wall
     ends. The opening itself is never painted over.
   - Furniture, from the existing rectangles: desks (oak top, apron, label mat, monitor,
     keyboard), meeting tables (runner, plant, laptops, papers), sofas, the reception counter,
     potted plants. Any unknown kind is drawn as an oak cabinet filling its rectangle.
   - Decoration, paint only: desk and meeting chairs, rugs (meeting tables, sofas, counter,
     private rooms), small corner plants, whiteboards, bookshelves, a reception plaque, pictures,
     clocks, windows on outer walls with daylight on the floor, and warm light pools in three flat
     steps. Decorations go only on free floor or wall faces, never in a doorway, on furniture or
     on the label corner. They are not objects: nothing collides with them and nothing is
     interactive.
4. **Crisp rendering.**
   - Environment textures use nearest-neighbour sampling whenever one art pixel covers at least
     one device pixel (zoom x resolution >= 1). Below that (zoomed far out) they switch to linear,
     where nearest-neighbour would shimmer.
   - The camera position is snapped to whole device pixels.
   - Resolution stays `min(devicePixelRatio, 2)`, and the canvas still resizes with its container.
   - Stage anti-aliasing stays on for the vector parts (status rings, proximity links).
5. **Labels.** Room names sit on a small cream plate, and desk names on the desk's paper mat.

## Consequences

- A custom map (uploaded through the existing API) is painted by the same rules. Rooms without
  furniture still get floor, light, wall pieces and a rug.
- Corner plants, chairs and rugs can be walked over, because they are paint. Only map furniture
  blocks, exactly as before.
- Name labels of avatars standing against a navy wall are dark on dark, as they were on the old
  slate walls.
- First paint of a floor costs a few tens of milliseconds once; per-frame cost is a few sprites.
- Tests: `apps/web/e2e/43-office-environment.spec.ts` (static texture count, walking through a
  doorway, sampling by zoom, repeated visits, no errors); the existing office specs and the
  200-avatar bench cover the rest.
