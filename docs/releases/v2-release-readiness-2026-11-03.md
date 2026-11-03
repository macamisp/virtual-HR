# Version 2 release-readiness report — 2026-11-03

Scope: PR #4 (`feat/screen-share-viewer`), head **`d98f482`**, which contains the Version 1 release
branch (`release/staging-2026-10-30`, ADR 046/047), `main`'s Resend commit, the persistent call
(ADR 048) and the idle-freeze fix (ADR 048 §8). **Nothing has been deployed; Version 1 on AWS is
unchanged.** Release notes and rollback plan: `v2-persistent-calls-2026-11-03.md`.

## 1. Root-cause analyses of confirmed bugs

| # | Bug | Root cause | Fix (commit) |
| --- | --- | --- | --- |
| 1 | **Avatar freezes after a quiet spell; reload needed** (P0) | The gateway emits `auth:expired` and `disconnect(true)`s every socket at the access token's `exp` (15 min). Socket.IO never reconnects on its own from a server disconnect or a refused handshake; the office client only set `connected=false`, so `step()` returned early for ever. Nothing handed refreshed tokens to the office or UI sockets (the heartbeat worker had this logic; they did not), and a throttled background tab can refresh late. Reproduced deterministically by Playwright 37 with a 120-second token: the baseline run failed, the fixed build passes. | `645e7b4`: refreshed tokens are pushed to the live sockets (`auth:refresh`), session refresh + `socket.connect()` after a kick / `Unauthorized` with a growing delay, `office:join` retry. No page reload. |
| 1b | (found by repeating the fix) 10 s after an expiry the office socket dropped and reconnected once more; a teleport in that window was refused ("Join the office first") | The first fix still answered `auth:expired` with `auth:refresh`; the server disconnects right after emitting it, the reply never comes, and the acknowledgement timeout then disconnected the socket that had reconnected meanwhile. Seen in 1 of 7 repetitions of spec 37, root-caused from the screenshot and timing, not retried away. | `d98f482`: `auth:expired` ignored (the disconnect handler reconnects), late replies compared against `socket.id` |
| 2 | A move whose acknowledgement never arrives (network drop mid-walk) blocked every later move (`inFlight` stayed true), so others stopped seeing the avatar move | `OfficeClient.flush()` only reset `inFlight` in the ack | `645e7b4`: reset on disconnect and on join; Playwright 37 test 2 |
| 3 | A movement key released while another window had focus kept the avatar walking (lost keyup) | `pressed` was only cleared on the canvas element's blur | `645e7b4`: cleared on window blur and tab hidden |
| 4 | Call dropped when the user left `/office` or `/meetings/[id]` (the original V2 brief) | Session and office socket owned by page components | `ea669bf` (ADR 048) |
| 5 | A single "poor connection" report right after joining switched the camera off again | Automatic audio-only fallback fired on one report | `ea669bf`: needs 5 s of poor connection |
| 6 | A reload lost the user's spot and room call; and (found while fixing) a fresh sign-in within the grace was put back into the previous session's room | Avatar removed when the last socket closed; grace keyed on the user only | `ea669bf`, `17b66a6`: 8 s grace keyed on the login-session family |
| 7 | Heartbeat `inCall` never entered `IN_MEETING` nor credited `meeting_seconds` (FR-MEET-009 open) | The attendance meeting hooks were never called | `ea669bf`: rows 6/7 from the heartbeat; credit on every segment end |
| 8 | PR #4 could not run CI (conflicts with `main`, and `main`'s own last run was red on an attendance-logout timing) | Branch forked before `main`'s Resend commit | `544899c` merge; CI green since run #37 |

An office call that ends under the user (LiveKit full reconnect after the 10-minute room token
expired) is now rejoined with a fresh token at once instead of waiting for the next office event.

## 2. Commits (branch `feat/screen-share-viewer`, PR #4)

`ea669bf` persistent call and presence (ADR 048, originally numbered 046) ·
`544899c` merge `main` (Resend) · `fe8a963` ADR renumbered to 048 · `17b66a6` merge
`release/staging-2026-10-30` (V1 host) · `645e7b4` idle-freeze fix, spec 37, release notes · `d98f482` follow-up (defect 1b), this report.

## 3. Test results

| Suite | Result | Notes |
| --- | --- | --- |
| Lint (eslint, whole monorepo) | PASS | |
| TypeScript typecheck (api, shared, web) | PASS | |
| Production build (`next build` by the Playwright web server; `tsc` for the API) | PASS | every Playwright run builds the web app |
| API tests (`node --test`, 902 tests incl. unit, state machine, RLS, e2e) | **PASS 902/902** | `jobs-bullmq-e2e` fails only when a dev API with `JOBS_ENABLED=true` shares Redis; `vault-e2e` needed `a9e7ea5` (V1 branch) to ignore an orphaned staging object |
| Playwright (89 specs: 87 passed, 2 skipped) | **PASS** | the 2 skipped are the real-recording tests that need the LiveKit Egress container (`LIVEKIT_EGRESS=1`) |
| Playwright 36 persistent call (two users, fake media) | PASS ×6 on the final code (also crosses a token expiry now) | once stalled at the take-over step while the full API suite, two dev servers and Chromium shared the machine; green every time since without that load |
| Playwright 37 idle/network recovery | baseline FAIL (bug reproduced) → PASS; repetitions: see §3a | 120-second tokens in the e2e API |
| Playwright 34, 35 (room audio, screen viewer) | PASS | 35's pop-out close step made race-free |
| attendance-state-machine (26), agent-companion (8), attendance-replay (4) | PASS | 5 new in-call cases |
| office-e2e (20), staging-compose-policy (14), mailer (25) | PASS | 4 new office cases (away flag, view stream, grace, preferences) |
| CI (GitHub Actions `CI Pipeline`: test, terraform, images, agent installers) | **GREEN**, runs #37, #38, #39; run on the final head: see PR #4 checks | run #39 = `645e7b4`; the follow-up changes two client files and the docs |
| Live two-user walkthrough of the dev build (24 steps, two headless browsers) | PASS 24/24 | `demo-check.mjs` against the local dev servers; **not production** |
| Security regression (auth hardening, TOTP replay, RLS, vault, staging compose policy) | PASS (part of the 902) | |
| Production (AWS) end-to-end | **BLOCKED by instruction** | V2 is not deployed; the live script `live-check.mjs` is ready |

### 3a. Repeated runs of the intermittent cases

| Case | Runs | Outcome |
| --- | --- | --- |
| Spec 37 test 1, idle past token expiry | 1 baseline; 7 after the first fix; 4 after the second | FAIL before; after the first fix 6/7 (the failure was defect 1b, root-caused); after the second fix PASS 4/4 |
| Spec 37 test 2, offline mid-walk | 4 after the first fix; 4 after the second | PASS 4/4; PASS 4/4 |
| Spec 37 test 3, offline during a room call | 4 after the first fix; 4 after the second | PASS 4/4; PASS 4/4 |
| Spec 36 take-over, reload, sign-out | 5 | PASS 5/5 (plus 1 load-related stall, see above) |

## 4. Release gates

| Gate | Status |
| --- | --- |
| 1 Avatar idle-freeze regression passes repeatedly | PASS (§3a) |
| 2 Persistent call navigation tests pass | PASS (spec 36, demo walkthrough) |
| 3 Multi-tab takeover reliable | PASS (spec 36 step 7, demo step 7; 1 stall under full-machine load, none since) |
| 4 Media cleanup | PASS (no live local tracks after Leave and sign-out; spec 36, demo) |
| 5 Attendance integration | PASS (state-machine cases; `presence_events` in-call heartbeats and growing Meeting total in spec 36) |
| 6 No unresolved P0/P1 regressions | PASS — see §6 for limitations, none blocking |
| 7 Full relevant CI green | PASS (run #39) |
| 8 Local two-user manual acceptance | PASS by script (24/24); the manual guide is `docs/runbooks/uat.md` AC-15b/15c |
| 9 Release notes and rollback plan | PASS (`v2-persistent-calls-2026-11-03.md`) |

**Verdict: Version 2 is ready for your deployment approval**, subject to the limitations below.
Deployment itself has not been performed (instruction: do not deploy).

## 5. What was verified beyond the scripts

- Browser tab in the background / another tab open: the call stays (spec 36 step 7, spec 37
  test 1 idles for two minutes with the heartbeat running, demo walkthrough).
- Visibility: nothing in V2 reacts to `visibilitychange` except forgetting held keys.
- Network: offline 5 s mid-walk and offline 5 s during a room call (spec 37 tests 2–3) — the
  LiveKit session resumes without a new token; the office socket reconnects.
- Reload, sign-out, session revoke, take-over release devices (spec 36).
- Camera/microphone permission changes: **not automated** (Chromium's fake devices cannot revoke
  permission mid-call); the pre-join check and the "Device error" alert handle refusals.
- Mobile viewport: the dock stays inside 390×844 (live script `live-check.mjs` step 4b;
  the desktop dock clamp is covered by spec 36's arrow-key test).

## 6. Known limitations (not blocking)

- `inCall` is sent by the heartbeat leader tab; when a *different* tab of the same browser owns
  the call the flag is not sent (independent elections).
- LiveKit room tokens live 10 minutes; a *full* reconnect (resume failed) of a call older than
  that re-joins the office call automatically but a meeting must be re-joined by the user.
- Meeting id is still not linked to attendance segments (FR-MEET-009 partial).
- The vault API test depends on `a9e7ea5`'s tolerance of orphaned staging objects in the dev bucket.
- Google *linking* from the profile uses a fetch and can fail with third-party cookies blocked.
- CI's own history: `main`'s run #36 failed in `attendance-logout-e2e` timing before this branch
  merged `main`; it did not recur in runs #37–#39.
