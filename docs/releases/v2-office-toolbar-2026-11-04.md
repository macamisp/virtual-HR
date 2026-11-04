# Version 2 — office call toolbar: test results and deployment readiness (2026-11-04)

Commit under test: `2440fcc` (on top of `81c58a9`, branch `feat/screen-share-viewer`, **not pushed**).
Environment: local podman stack (Postgres/Redis/S3/ClamAV/KMS/LiveKit), Playwright Chromium with fake
camera/microphone/screen, two synthetic users from the seeded `web-e2e` workspace (Wendy Worker,
Leo Lead). **Nothing deployed; AWS Version 1 untouched.**

## What changed

- `OfficeToolbar` above the map (ADR 048 §3b): status (`Connected · <room> · N in call`,
  `Reconnecting…`, `Connecting…`, `Audio and video off`, `Open in another tab`), mic, camera,
  speakers, share screen, raise/lower hand, audio only, leave; "Turn on audio and video" opens the
  existing device check (PreJoin). Icons with accessible names and tooltips; `aria-pressed` for
  on/off; labels from `md` up, icon-only below. Sticky under the header from `md` up, not sticky on a
  phone (the map stays visible).
- Uses the tab's single `CallController` / `MediaSession` — the same instance as the floating dock.
  The dock stays on Dashboard, Tasks, Attendance etc. and gained the speaker button.
- Speaker mute mutes remote `<audio>` playback only; the microphone, the published track and the call
  are untouched. When the browser blocks autoplay, "Allow sound" calls `room.startAudio()` on a click.
- **P1 fixed (privacy):** a muted user was unmuted on every room change, because the reconnect
  re-applied the device-check choices. Mic/camera intent is now kept for the call and applied
  through one serialized `sync()`; clicks during a room switch can no longer race the publish.
  Reproduced first by spec 39 (failed: "still muted after the room change"), then fixed.

## Gates (exact working tree of `2440fcc`)

| Gate | Result |
| --- | --- |
| Lint (monorepo) | PASS |
| Typecheck (root + web) | PASS |
| Production build (`next build`) | PASS |
| API typecheck + tests | PASS — 0 failures |
| Playwright full suite | **96 passed, 2 skipped** (Egress recordings), 0 failed |
| Repeats | spec 39 ×3 PASS (9/9), spec 37 ×3 PASS (9/9), spec 36 ×2 PASS (2/2), spec 39 desktop+phone once more for screenshots PASS |
| CI on the exact commit | **NOT RUN** — needs a push of `2440fcc` (your approval) |

## Function by function

| Function | Result | Evidence |
| --- | --- | --- |
| Before media is on: status "Audio and video off", Turn on → PreJoin → connected | PASS | spec 39 t1, t3 |
| Mic mute/unmute; colleague stops/starts hearing | PASS | spec 39 t1 (B's inbound audio level) |
| Mic stays muted across a room change (privacy fix) | PASS | spec 39 t1 ×4 runs |
| Camera on/off; colleague sees/stops seeing frames | PASS | spec 39 t1 |
| Speakers off: local `<audio>` muted, mic still live, inbound packets still arriving, call kept | PASS | spec 39 t1 |
| Speakers setting survives a room change; dock and toolbar agree both ways | PASS | spec 39 t1, t2 |
| Autoplay blocked → "Allow sound" | PASS by code path only (NOT AUTOMATED) | Playwright Chromium allows autoplay; button appears only when `room.canPlaybackAudio` is false |
| Share screen / stop; colleague sees it | PASS | spec 39 t1; specs 17, 35 now driven from the toolbar |
| Raise/lower hand seen by colleague | PASS | spec 39 t1 |
| Audio only (camera off, video not received) | PASS | spec 39 t1 |
| Leave call releases tracks | PASS | spec 39 t1, t3 |
| Connected status text and dot | PASS | spec 39 t1, t2 |
| Reconnecting shown while offline, recovers | PASS | spec 39 t2 |
| Token expiry (120 s token, waited 130 s): controls work, avatar moves | PASS | spec 39 t2; spec 37 ×3 |
| Navigation to other pages: dock keeps the call, no new media token | PASS | spec 39 t2; spec 36, 38 |
| Second tab: "Open in another tab" + Take over | PASS | spec 39 t2; spec 36 |
| One session only: tokens = baseline + 2 (one per room), 1 live audio track, ≤ 2 peer connections | PASS | spec 39 t1 |
| Keyboard (Tab, Space, Enter), accessible names, tooltips, `aria-pressed`, live status region | PASS | spec 39 t1 (role/name queries + key presses) |
| Screen-reader announcement with a real reader (Orca/NVDA/VoiceOver) | NOT TESTED | only the ARIA roles/names were checked automatically |
| Desktop sticky under the header while scrolling | PASS | spec 39 t1, screenshot `toolbar-desktop-scrolled.png` |
| Phone 390×844: no horizontal overflow, not sticky, tap mute/speakers/leave | PASS | spec 39 t3 |
| Avatar idle freeze (repeated) | PASS | spec 37 ×3 plus the full run |
| Media cleanup (tracks, peer connections, sockets) | PASS | spec 38 t4, spec 39 t1/t3 |
| Firefox / Safari / real phones / real lossy networks | NOT TESTED | Chromium only |
| Recording (Egress) | BLOCKED | 2 skipped tests need the Egress container |

Screenshots (from the last run): `toolbar-desktop.png`, `toolbar-desktop-scrolled.png`,
`toolbar-mobile-off.png`, `toolbar-mobile-call.png` (Playwright output of spec 39; not committed).

## Deployment readiness (existing EC2 host, no new infrastructure)

| Check | Status |
| --- | --- |
| Release commit | `2440fcc` locally verified; **must be pushed and CI-green on that exact SHA** |
| Live V1 | app 200, `/health` = ok (db, redis) — checked 2026-11-04 |
| SSH to the host (port 22) | **BLOCKED** — security group rule `sgr-06145eda456c7dd97` does not allow the current public IP `112.135.102.180`; needs `112.135.102.180/32` (no 0.0.0.0/0, no extra rule) |
| Read-only host inspection (commit, compose mode, containers, health, cloudflared) | PENDING SSH |
| Production PostgreSQL backup | PENDING SSH (runbook `staging-ec2.md` §5; rehearsed on a local copy earlier) |
| Active HTTPS Docker Compose configuration (`docker-compose.staging.yml` + override) | PENDING SSH (`docker compose config -q` only) |
| Rollback compatibility | V2 migration adds one column `users.vo_mute_on_leave BOOLEAN NOT NULL DEFAULT false`; the toolbar slice adds no migration; V1 ignores it, so rolling back the code needs no down-migration. Re-confirm on the host |
| Migration / deploy | **NOT DONE — waiting for your explicit approval of the final verified commit** |

## Recommendation

GO for your approval of `2440fcc` once (1) it is pushed and CI is green on that SHA, (2) SSH is
restored for `112.135.102.180/32` and the read-only inspection, backup and compose checks pass.
