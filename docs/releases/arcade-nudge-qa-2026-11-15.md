# Arcade redesign and avatar nudge: final QA and release readiness

Date: 2026-11-15. Branch `feature/office-avatar-nudge`, local only (not pushed, no PR, not deployed).
Scope: ADR 057 (FR-VO-015) arcade pixel-art redesign, ADR 058 (FR-VO-016) avatar nudge, and the
test corrections made along the way. No new features were added during this QA.

**Verdict: release-ready for the local branch**, with the limitations listed at the end. Every
required check passed. The only failures in the full runs were explained, fixed where they were
test assumptions, and passed on rerun; none was a product defect.

## Commits under test

Branch tip `2b040b3`, on top of `ae64cda` (office map upgrade script). All earlier work is preserved.

| Commit | What |
|---|---|
| `41ee495` | Arcade pixel-art redesign, paint only (ADR 057) |
| `5fff5aa` | Spec 45 reads both hug poses while the hug is on |
| `1326c6f` | Arcade walk test settles in short steps instead of timing a held key |
| `930342a` | Avatar nudge (ADR 058) |
| `2b040b3` | Spec 38 allows the table stop to be up to one frame step short |

Since `ae64cda`, nothing changed under `apps/api/prisma`, `apps/api/src/auth`, `apps/api/src/attendance`,
`apps/api/src/meetings`, `apps/api/src/media` or any `package.json`/lockfile: no migration, no new
dependency, no change to authentication, 2FA, attendance or meetings.

## Static checks

| Check | Result |
|---|---|
| Root typecheck (`tsc --noEmit`) | PASS |
| Web typecheck (`npm run web:typecheck`) | PASS |
| Root and web lint (`npm run lint`) | PASS |
| Production web build (`npm run web:build`) | PASS (`/office` 146 kB, 510 kB first load) |

## API suite

| Run | Result |
|---|---|
| Full suite, final (`dist/apps/api/test/*.test.js`, 4 at a time) | PASS 1027 / 1027, 0 skipped |

Includes the map fingerprint tests (`office-campus`: original office and object ids unchanged), the
nudge unit tests (3) and socket tests (10: delivery, Accept, Ignore, Cancel, expiry, cooldown, spam
limit, Do not disturb, away, too far, both directions across organisations, disconnect, nothing
stored), avatar actions, attendance (state machine, replay, reconnect, guards), meetings and RLS.

## Browser suite (Playwright, real API, Postgres, LiveKit and LiveKit Egress)

Final full run: **128 passed, 1 failed, 3 did not run, 0 skipped** (42.8 min). Then spec 38 alone:
**6 / 6 passed**. Every test therefore has a passing run on the final code.

| Spec | Final full run | Notes |
|---|---|---|
| 01–21, 23–37, 39–42, 44 | PASS | unchanged areas: auth, 2FA, attendance, leave, timesheets, documents, vault, e-sign, meetings, calls, chat, office |
| 22 recording (2 tests) | PASS 2 / 2 | previously SKIPPED; see below |
| 38 V2 QA sweep (6 tests) | 2 PASS, 1 FAIL, 3 not run | host went to sleep during the test; rerun 6 / 6 PASS |
| 43 environment (2) | PASS | includes the ADR 057 arcade test at 1440 x 900, 390 x 844 and reduced motion |
| 45 avatar actions (5) | PASS | |
| 46 nudge (3) | PASS | two signed-in users in separate browsers; phone; reduced motion |

### Spec 22: why it was skipped, and now

The spec skips itself unless `LIVEKIT_EGRESS=1`, because recording needs the LiveKit Egress
container (about 1.3 GB, optional in `docker-compose.yml`, profile `recording`). It was not running.
For this QA a local Egress container was started from the repository's dev configuration
(`infra/livekit/egress.dev.yaml`, host network, as the compose file defines it), and the suite ran
with `LIVEKIT_EGRESS=1`. Both tests passed, alone and in the full run: the admin enables recording,
both people consent, Egress records, the recording completes, is stored and plays back. The
container was stopped afterwards (`hrvo-egress-qa`, kept for reuse).

### Spec 38: three different failures, none a product defect

| When | Test | Failure | Cause | Action |
|---|---|---|---|---|
| Full run, 11:25 | proximity call follows the user | lead's office canvas never appeared; header "Reconnecting… tracking paused, last heartbeat 11:25:29" | chronyd reports every time source offline at 11:25:29: the laptop went to sleep and lost the network | none needed; passed 8 / 8 since |
| Repeat run | collisions, occupancy… | "stopped at the table": 205, expected 208 | test assumption: the client refuses a whole frame's step that would touch furniture (it does not clamp to contact), so the first stop can be up to 20 px short (200 px/s x 100 ms frame cap) and holding on can close the gap. Movement code is unchanged since before these branches | `2b040b3`: allow at most one frame step closer and check the avatar never enters the table (closest legal y 202); passed 8 / 8 since |
| Final full run, 14:28–14:31 | network drop, token expiry, reload | badge "Active" instead of "In meeting" after the 130 s idle | chronyd: sources offline at 13:25:58, "Forward time jump detected" at 14:31:35. The browser's clock jumped 65 min inside a 130 s wait. The API correctly closed the attendance session after more than 90 s without heartbeats (FR-ATT-002) | rerun with a temporary sleep inhibitor held only for the test process: 6 / 6 PASS, no clock jump |

The rerun used `systemd-inhibit --what=idle:sleep` around the test command only; no system setting
was changed.

### Hug timing (spec 45)

The intermittent failure read the two hug poses after bringing another tab forward and taking a
screenshot, which can outlast the 2.2 s hug. Fixed in `5fff5aa` (both poses read in one poll while
the hug is on). Since: 3 / 3 unmodified, 15 / 15 after the fix, 5 / 5 in the final full run.

## Feature verification

| Area | How | Result |
|---|---|---|
| Arcade | spec 43 arcade test (texture count 8, walk across a rug and out through the top doorway, re-entry builds one scene, no console error) at desktop, phone and reduced motion; spec 44 games | PASS |
| Map unchanged | `office-campus` fingerprints; `default-map.ts` untouched; game object ids 75–80, 83, 84 | PASS |
| Nudge | API socket tests and spec 46 (bell on hover, keyboard menu, touch, chime blocked then played, accepted, ignored, cancelled, expired, left, cooldown, Do not disturb, distance) | PASS |
| Avatars and actions | specs 42, 45 | PASS |
| Meetings and calls | specs 17, 22, 25, 34–37, 39 | PASS |
| Attendance | API attendance suites; specs 23 (accuracy), 24 (leave), 38 (meeting seconds), 40 (work time) | PASS |
| Other HR workflows | specs 01–21, 26–33 | PASS |

Performance (headless, software rendering): 200 avatars 20 fps, 0.81 ms of script per frame; 41
avatars 30 fps, 0.16 ms. Script time per frame for 200 avatars was 0.51–0.61 ms after the arcade and
0.54–0.56 ms on the parent commit in earlier runs; headless frame rates are noisy.

## Screenshots

- Final pages, desktop 1440 x 900 and phone 390 x 844: `docs/assets/release-2026-11-15/`
  (dashboard, attendance, meetings, work time, office in the arcade). The phone set is an employee:
  the dashboard shows its "You don't have access" state, as designed.
- Arcade before and after: `docs/assets/office-arcade/`.
- Nudge, all states, desktop and phone: `docs/assets/office-nudge/`.

## Limitations and open items

- **Not deployed and not pushed.** CI has not run on these commits.
- **Single API instance.** Nudges, their cooldowns and the office world are in memory (ADR 015).
- **List view** shows incoming nudges but has no bell (no positions there).
- **Arcade label** "Arcade" is still partly behind the first cabinet (renderer label position; pre-existing).
- **Movement** can stop up to one frame step short of furniture at low frame rates (pre-existing,
  cosmetic; now documented in spec 38).
- **Host sleep** invalidates long browser runs on this laptop: run the suite with a sleep inhibitor.
- **Spec 22** needs the optional Egress container and `LIVEKIT_EGRESS=1`; without them it still skips.
- **Production map.** The production organisation still has the original 60 x 40 map, so the arcade
  is only visible there after the map upgrade (`scripts/office-map-upgrade.ts`, run by the owner).
