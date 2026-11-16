# ADR 065: The office draws only when the picture changes, culls off-screen pieces, and keeps the depth list stable

Date: 2026-11-16. Status: proposed (built and measured locally on `integration/local-qa-2026-11-16`; not pushed,
not deployed). Related: NFR-PERF-002, FR-VO-001, ADR 054 (prebuilt scene), ADR 061 (isometric view).

## Context

- **Reported:** the V3 release candidate (D3) measured the isometric view at about 7–15 fps in headless Chromium,
  against 15–30 fps for classic.
- **Profiling** (CDP `Performance` metrics against the local app, `?bench=N` avatars; table below) showed:
  - Script time was small: 1–6 ms per frame.
  - Total CPU per frame was 54–113 ms. Headless Chromium here renders WebGL in software (SwiftShader), and
    Pixi redrew the whole canvas every frame, whether or not anything had changed.
  - Isometric was slower because it has more on screen and more overdraw: about 700 standing pieces (walls,
    furniture, chairs) are separate depth-sorted sprites.
  - Every `zIndex` change rebuilt Pixi's draw list for the whole stage. Remote avatars eased towards their
    target and never settled exactly, so their depth changed, and the list was rebuilt, every frame, even in a
    still office.

## Decision

No art, sprite, colour, resolution or animation is removed or reduced.

1. **Draw on change.**
   - Pixi's own render is taken off the ticker. A render step at the same priority draws only when Pixi has
     changes queued:
     - a structure change (added, removed, shown, hidden, re-sorted);
     - a transform or colour change;
     - a view change (a texture swapped for the next walking or action frame, text, graphics).
   - It also draws when the canvas size or resolution changes, and at least once a second as a safety net.
   - Otherwise the last picture stays on screen.
   - The frame logic (movement, easing, animation timers, water glint, fairy lights) still runs every tick.
2. **Stable depth list.**
   - Eased positions snap to the target within 0.05 px, so a still office stops re-sorting.
   - The avatar and standing-piece layer, and the ground, are separate Pixi render groups, so a depth change
     re-lists only that layer.
3. **Viewport culling of static pieces.**
   - Floor chunks and standing pieces outside the screen, plus a 160 px margin, are hidden.
   - This is checked only after the camera moves 24 px or the zoom or screen size changes.
   - Avatars, labels, festive pieces and water are never culled.
4. **Proximity links** are redrawn only when they change.
5. **Measurements on the office canvas**, for tests and operators:
   - `data-render-ms`: time per draw;
   - `data-draws`: draws per second;
   - `data-rebuilds`: draw-list rebuilds per second;
   - `data-culled`: static pieces drawn, of all.

   `data-fps` stays the ticker rate (frame logic), as before.

## Measurements (2026-11-16, this laptop: Intel Iris Xe, Fedora, Chromium from Playwright, 1440×900)

`rAF fps` counts real browser frames over 8 s. `CPU/frame` is the CDP TaskDuration delta divided by frames.

| Scene | Before (SwiftShader) | After (SwiftShader) | After (Iris Xe GPU) |
|---|---|---|---|
| Classic, alone, idle | 19.4 fps, 54 ms | 59.7 fps, 1.8 ms | 60.1 fps, 0.4 ms |
| Classic, alone, walking | 18.5 fps, 61 ms | 35.6 fps, 20 ms | 59.5 fps, 2.0 ms |
| Classic, 40 avatars moving | 15.9 fps, 65 ms | 18.5 fps, 56 ms | 60.1 fps, 1.1 ms |
| Classic, 200 avatars moving | 14.2 fps, 73 ms | 13.2 fps, 79 ms | 59.9 fps, 4.1 ms |
| Isometric, alone, idle | 12.1 fps, 87 ms | 56.7 fps, 2.1 ms | 60.1 fps, 0.4 ms |
| Isometric, alone, walking | 12.0 fps, 99 ms | 26.8 fps, 29 ms | 59.9 fps, 2.1 ms |
| Isometric, 40 avatars moving | 11.5 fps, 92 ms | 11.9 fps, 88 ms | 60.0 fps, 1.3 ms |
| Isometric, 200 avatars moving | 9.3 fps, 113 ms | 10.3 fps, 103 ms | 60.1 fps, 3.0 ms |
| Isometric, reduced motion, idle | 12.3 fps, 85 ms | 55.9 fps, 2.1 ms (1 draw/s) | 60.1 fps, 0.4 ms |

- **"Before" on the GPU was not measured:** the earlier build had been replaced before the GPU probe.
- **With a real GPU** (Chromium can use it here with `--use-angle=gl-egl`), both views hold 60 fps in every
  scene, at 4 ms of CPU per frame or less.
- **What did not improve:** in software rendering, scenes where many avatars move every frame. They still have
  to be drawn every frame, and SwiftShader's pixel fill (about 55 ms classic, about 90 ms isometric per frame
  at this size) dominates. Lowering the resolution or removing detail would change that, and was ruled out.
- **Culling:** at normal zoom about 220–245 of 712 static pieces are drawn in the isometric view; zoomed out,
  360.

## Correctness

- Depth order is unchanged: the same `zIndex` values and the same sorting, only fewer needless re-sorts.
- Movement, click hit-testing (game bodies use stored rectangles) and wall fading work as before: wall fading
  sets alpha, which queues a draw.
- Reduced motion: no glint and no fairy-light twinkle. In a still office it gives 0 rebuilds and 1 draw a
  second.
- Covered by the office browser specs 16, 42–49 in the full suite, and by screenshots in
  `docs/assets/v3-final-2026-11-16/office-iso-*.png` (desktop, phone, garden, zoomed out).
