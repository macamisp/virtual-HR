# ADR 045: Shared-screen viewer: expand, full screen, new window, picture-in-picture

Date: 2026-10-29. Status: accepted. Requirements: FR-VO-009, FR-MEET-004, FR-MEET-005.
Related: ADR 016 (media), ADR 044 (office audio route).

## Problem

A shared screen in the office was shown inside the 22rem side column: a 302×170 box on a
1440×900 laptop for a 960×540 share, with `object-fit: cover`, so the edges were cut off. There were
no controls to make it bigger. Because LiveKit's adaptive stream sizes the video to the element
showing it, the small box also meant a low-resolution layer.

## Decision

`ScreenShareViewer` (apps/web/src/components/media/screen-share-viewer.tsx) replaces the fixed
figure in `CallView`, so meetings and the office get the same viewer, one per presenter:

1. **Inline**: the whole screen, `object-contain` (no cropping), with a toolbar.
2. **Expand**: a page overlay (`role="dialog"`, Escape or Minimize returns, focus goes back to
   the Expand button) with fit, actual size and zoom (25–300 %, scrollable when larger than the view).
3. **Full screen**: the browser Fullscreen API on the expanded overlay, so the toolbar stays
   available. Leaving full screen (Escape or the button) returns to the layout it started from.
   iPhone Safari, which has no element full screen, uses the video's own full screen; elsewhere
   the button is disabled with an explanation.
4. **New window**: `window.open('')` gives a same-origin blank window; the office page copies its
   stylesheets in and renders the viewer there with a React portal. The window shows the track
   this page already receives: no second LiveKit connection, no new token, nothing in its
   address (`about:blank`). Screen-share sound keeps playing from the office page.
   - **Adaptive stream**: LiveKit only counts elements visible in the page's own window, so an
     element in the new window would be paused. `attachInWindow` registers an `ElementInfo` that
     reports the new window's own size and visibility, and counts it like picture-in-picture so the
     share keeps flowing while the office tab is in the background. `observeElementInfo` is
     marked `@internal` in livekit-client 2.22.3 but is public and typed; check it on upgrades
     (Playwright spec 35 fails if the new window gets no frames).
   - **Clean-up**: closing the window only detaches that element. The window closes itself when the
     share ends, the viewer closes or the office page goes away. A blocked pop-up shows a notice.
5. **Picture-in-picture**: `requestPictureInPicture()` on the inline video where the browser supports
   it (LiveKit already keeps PiP elements streaming); disabled with an explanation elsewhere.
6. **Close viewer** hides the share for this person only, with "Show shared screen" to bring it back.
   **Stop presenting** is shown only to the presenter; LiveKit only lets a participant unpublish
   their own tracks, so nobody else can stop a share.

## Consequences

- No new package; no server change; tokens, room permissions and room audio isolation are as before.
- Switching views attaches or detaches `<video>` elements only. The call does not reconnect.
- A larger view requests a sharper simulcast layer (adaptive stream), as intended.
- Regression: Playwright spec 35 (frames painted inline, expanded, full screen and in the new window,
  no token request for the new window, blocked pop-up notice, close viewer, presenter-only stop,
  clean-up when the share stops).
