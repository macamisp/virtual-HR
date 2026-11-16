# V3 release candidate: office, interactions and HR management

Date: 2026-11-16, final round. Branch `integration/local-qa-2026-11-16`, worktree `hrvo-local-qa`.
Final head: the commit that adds this report, on top of `81a892b`.

Local only:
- not pushed, no PR, no CI run, not deployed;
- production database, production maps, AWS, Cloudflare and Supabase untouched;
- the iCET maps were not upgraded, and the scratch databases and all backups were kept.

**Verdict: complete as a local release candidate; NOT READY for production deployment yet.**
- All four defects listed in the previous report are fixed and verified (§2).
- The connection-pool blocker is resolved in code and verified live (§6).
- What still blocks production: no CI run on this branch (nothing is pushed), one unexplained intermittent
  failure seen once (§9, D4), the open decisions in §10, and the usual approvals.
- Every other failure seen in this round has a found cause and a fix, verified by reruns (§2, §3).
  Two of them were in the full runs: spec 46 in run 1 and spec 48 in run 2. Both fixes landed after the
  run in which the failure appeared, and were verified by separate reruns of the spec, not by a third
  full run.

## 1. Results at a glance

| Check | Result | Commit |
|---|---|---|
| Root lint, root typecheck, web typecheck | pass | `13fa0c0` |
| API build (`tsc`) | pass | `13fa0c0` |
| Full API suite: unit, integration and e2e, 171 files | **1088 / 1088**, 0 failed, 0 skipped (216 s) | `13fa0c0` |
| Production web build (`next build`, `NODE_ENV=production`) | pass | `13fa0c0` |
| Prisma migrate status | 40 migrations, schema up to date | `13fa0c0` |
| Schema drift (`prisma migrate diff` against `hrvo_demo`) | no difference | `13fa0c0` |
| Full Playwright suite, run 1 | 147 passed, 1 failed, 1 did not run (spec 46; cause and fix in §3) | `13fa0c0` |
| Full Playwright suite, run 2 (final) | **148 passed, 1 failed**, 0 did not run (spec 48; cause and fix in §3). Spec 46 and spec 39 passed | `b1e1ee3` |
| Spec 48 after its fix, 3 separate runs | 6 / 6 | `81a892b` |
| Spec 39 (the previous intermittent), 10 consecutive runs | **30 / 30** | `3885353` |
| Spec 46 after its fix, 3 separate runs | 9 / 9 | `b49df45` |
| Spec 50, the new header test, 7 widths | 7 / 7 | `391ae01` |
| Board persistence API tests | 5 restart tests + 2 state tests pass; with the board e2e and rule tests, 18 / 18 | `481a9d0` |
| Connection-cap unit tests | 10 / 10 | `cfe1336` |

The web app has no unit tests of its own: its tests are the Playwright browser specs. The API suite
covers unit, integration and e2e tests together.

Baseline (previous report, `8a704aa`): API 1077 / 1077, Playwright 140 passed, 1 failed, 1 did not run.
The 11 new API tests are 5 board-restart tests, 2 stored-state tests, 3 connection-cap tests and 1
connection-budget test. The new browser spec is 50, with 7 tests.

## 2. Defects from the previous report: fixed

### D1: spec 39 take-over test failed in the full run, intermittently (fixed)

**The earlier diagnosis was wrong.** The previous report called this "a sign-out race between two tabs".
The trace shows otherwise:
- The second tab never got a 401: every request returned 200.
- The tab took 21 s to reach the office, against 15 s allowed. The browser took 6 s from loading its
  scripts to its first API call, and the API answered slowly too (up to 7.8 s to the first byte for
  `/attendance/me/today`).
- The "You were signed out." screenshot came from a different browser context. Spec 22 had opened it
  33 minutes earlier.

**Root cause:** specs 11 and 22 never closed the browser contexts they opened.
- Spec 22's two people stayed in a live LiveKit meeting, with fake camera and microphone and a token
  refresh every minute, for the rest of the run in the same Chromium. That is extra load that only exists
  in a full run.
- Spec 11 left a guest page open.

**Fix (`3885353`), without raising any timeout:**
- Specs 11 and 22 close their contexts, spec 22 in `finally`.
- Spec 39 now fails at once, with that cause named, if any earlier spec leaves a context open.

**Verification:**
- 10 consecutive runs of spec 39: 30 / 30. The take-over test took 3.3–3.7 min each time.
- Specs 22 and 39 run together: 5 / 5.
- Both full runs since passed spec 39.

### D2: the tracking badge wrapped onto three lines on a phone (fixed, `391ae01`)

- **Phones** (below 640 px) show a short form on one line: "Active · 16:35", "Meeting · …", or
  "Reconnecting…", which becomes "Paused" next to the spinner below 360 px. Screen readers always get the
  full wording.
- **640–767 px:** the header overflowed there too, with "In the office · Leave" beside the full badge. The
  office controls now show their text labels from 768 px; below that, icons with accessible names.
- **768–1279 px:** the user's name now shows from 1280 px. This overflow existed before V3, at 768 px, with
  the title squeezed to nothing.
- **Desktop at 1440 px is unchanged.**
- **New spec 50** tests 320, 360, 390, 640, 768, 1024 and 1440 px, in the office and on another page while
  in the office, and offline (the longest status). At each width it checks:
  - the badge is on one line and overlaps nothing;
  - every header control is on screen;
  - the page doesn't scroll sideways.

  Screenshots: `docs/assets/v3-final-2026-11-16/header-*.png`.

### D3: the isometric office was slow (fixed, `13fa0c0`, ADR 065)

**Profiling result:**
- Script work was 1–6 ms per frame.
- The cost was software rendering. Headless Chromium here uses SwiftShader, and the office redrew the
  whole canvas every frame, even when nothing moved.
- Every `zIndex` change rebuilt Pixi's draw list. Remote avatars never quite settled, so their depth
  changed every frame.

**Fix (no art, resolution or animation removed):**
- The office draws only when Pixi has changes queued, and at least once a second.
- Eased positions settle exactly.
- The avatar layer and the ground are separate render groups.
- Off-screen floor chunks and standing pieces are culled.
- Proximity links are redrawn only when they change.

Measured on this laptop (rAF fps; CPU per frame from CDP):

| Scene | Before (software) | After (software) | After (Intel Iris Xe GPU) |
|---|---|---|---|
| Isometric, alone, idle | 12.1 fps, 87 ms | 56.7 fps, 2.1 ms | 60.1 fps, 0.4 ms |
| Isometric, walking | 12.0 fps, 99 ms | 26.8 fps, 29 ms | 59.9 fps, 2.1 ms |
| Isometric, 200 avatars moving | 9.3 fps, 113 ms | 10.3 fps, 103 ms | 60.1 fps, 3.0 ms |
| Classic, alone, idle | 19.4 fps, 54 ms | 59.7 fps, 1.8 ms | 60.1 fps, 0.4 ms |
| Classic, walking | 18.5 fps, 61 ms | 35.6 fps, 20 ms | 59.5 fps, 2.0 ms |
| Classic, 200 avatars moving | 14.2 fps, 73 ms | 13.2 fps, 79 ms | 59.9 fps, 4.1 ms |

- **Reduced motion:** no water glint or fairy-light twinkle. A still office makes 0 rebuilds and 1 draw a
  second.
- **Not improved:** crowded scenes in software rendering. Many moving avatars must be drawn every frame,
  and SwiftShader's pixel fill dominates there. With the laptop's real GPU, both views hold 60 fps in every
  scene.
- **Not measured:** "before" on the GPU, because the old build had already been replaced.
- **Other results:** depth order is unchanged; screenshots at desktop, phone, garden and zoomed-out
  (`office-iso-*.png`) show every piece drawn; the campus tour (§4) passes.

### L1: chess and checkers ended at an API restart (fixed, `c9e5374` and `481a9d0`, ADR 064)

**Storage:**
- A new table, `office_board_games` (migration `20261116120000_office_board_games`), holds the games in
  progress: one row per game, written behind the in-memory world.
- A row is inserted on acceptance, updated after every accepted move, and deleted when the game ends.
  Nothing is kept after a game. Refused moves are never written.

**Restore:**
- Games come back when the office loads, inside that organisation's tenant context.
- A game waits up to 2 minutes for both players to return. A player who doesn't come back loses.

**Tenant isolation and privacy:**
- RLS forced, composite foreign keys binding both players to the organisation, one game per table, and no
  TRUNCATE for the application role.
- The data export lists a person's games in progress, and anonymisation deletes them.

**Two further bugs found and fixed while testing this:**
- An admin reload of the office used to drop every running game. It now keeps them.
- After a reload or restart, the running game was sent before the join answer, and the client then
  discarded it as belonging to the old connection. It is now part of the join answer (`481a9d0`).

**Evidence:**
- **API restart test** (real socket, second API instance), 5 tests:
  - same position and players after the restart, then play goes on, with turn and legality still checked;
  - the resume window ends the game for a player who doesn't return;
  - stale and damaged rows are deleted, not restored;
  - RLS: no row and no update visible to another organisation, an insert refused with 42501; a player from
    another organisation refused (23503); one game per table (23505).
- **Browser check against the real app:** two people play, the API gets SIGTERM and starts again, both
  browsers reconnect by themselves and show the same three moves, and play goes on
  (`chess-after-api-restart-*.png`).
- **Migration rehearsal** on a disposable copy: apply, rollback, re-apply, no drift (§5).

## 3. New issues found and fixed in this round

| Issue | Fix |
|---|---|
| Running board game lost from the screen after a reload or restart (join-answer race) | `481a9d0` |
| Admin office reload dropped running board games | `c9e5374` |
| Header overflow at 640–1279 px (pre-existing at 768 px) | `391ae01` |
| Spec 48 clicked to go from wherever a timed key walk had stopped; once the target fell on a café table, there was no path and the avatar stayed (seen once, final run) | `81a892b`: the click comes first, from the Café's fixed arrival point |
| Spec 46 depended on earlier tests being slow: the 8 s pair cooldown and the 6-per-minute limit carried over to the next test once the office got faster. Correct server behaviour; a test defect | `b49df45`: the spec records the nudges sent and waits only for what the server rules still require |

## 4. Feature-by-feature results

PASS means an automated test or a scripted browser check passed on this round's code.

### Office

| Feature | Result | Evidence |
|---|---|---|
| Classic and isometric views, switch remembered | PASS | spec 48; campus tour (both views) |
| Keyboard movement, click-to-walk | PASS | specs 16, 42, 48; spec 39 (keyboard after token expiry) |
| Avatar selection and persistence | PASS | spec 42 |
| Sit and stand; jump, wave, dance | PASS | spec 45 (two people) |
| Hug and high five with consent | PASS | spec 45; `office-actions-e2e` |
| Emotes | PASS | spec 45; `office-actions-e2e` |
| Nudge Accept / Ignore, DND, cooldown, phone, reduced motion | PASS | spec 46 (3 separate runs, 9 / 9); `office-nudge-e2e` |
| Multiplayer avatar synchronisation | PASS | specs 16, 25, 38, 42, 45 |

### Campus

| Feature | Result | Evidence |
|---|---|---|
| Main office, Reception, Meeting rooms A–C, Board room, Focus room, HR office, Lounge, Café, Arcade, Garden | PASS | campus tour: every room by its "Go to" button in both views, no page errors (`campus/*.png`, 23 files); spec 44 |
| Swimming pool and pond | PASS | `office-campus`, map upgrade tests; Acme Demo map v7 has both objects |
| Seating on chairs, benches, sofas; furniture | PASS | `office-actions` (110 seats); spec 45 |
| Map / List switch | PASS | campus tour; spec 16 |

### Games

| Feature | Result | Evidence |
|---|---|---|
| Chess, checkers: invitations, accept, move validation, resignation | PASS | spec 49; `office-board-e2e` (6); `board-game-rules` (13) |
| Reconnection and persistence across an API restart | PASS | `office-board-restart-e2e` (5); real-app restart check |
| Tic-tac-toe and the other mini-games | PASS | spec 44 |

### Attendance and HR

| Feature | Result | Evidence |
|---|---|---|
| Employee attendance, heartbeat, breaks, corrections, accuracy | PASS | specs 02, 03, 04, 23; attendance API tests |
| Office connection intervals | PASS | `office-presence-e2e`, `office-presence-security` |
| Work time, confirmed meeting time, recorded task time (kept separate) | PASS | spec 40, spec 47; `attendance-analytics-*` |
| HR analytics, individual reports, CSV exports | PASS | spec 47; analytics API tests (export audited) |
| Tasks completed / open / overdue, timesheet status | PASS | spec 47; work-items API test |
| Manager, HR and admin permissions; organisation isolation | PASS | spec 47, specs 05, 12; analytics scope tests; `owner-scope-e2e` |

### Other existing features

| Feature | Result | Evidence |
|---|---|---|
| Google sign-in | PASS against the local fake OIDC server (spec 32). **Real Google not verified:** `GOOGLE_REDIRECT_URI` in `.env` points to an old tunnel | spec 32 |
| Email notifications | PASS with the file transport (spec 33: invitation, reset, verification mails). Real SMTP delivery not tested | specs 08, 13, 33 |
| Meetings, calls, screen share, office call toolbar | PASS | specs 17, 25, 30, 34–39 |
| Meeting recording (LiveKit Egress) | PASS | spec 22 |
| Tasks, planning, timesheets | PASS | specs 06, 07, 09, 29 |
| User, team and workspace management; roles | PASS | specs 12, 26, 31; admin API tests |
| Role-based access control; security and audit logs | PASS | specs 05, 12, 15; `route-guards`, auth hardening and audit API tests |
| Documents, vault, e-signature, privacy, leave | PASS | specs 10, 11, 15, 21, 24 |

## 5. Database status

- **Migrations:** 40 applied on the local `hrvo_demo`; schema up to date; no drift.
  - The only new one is `20261116120000_office_board_games`: additive, one table, with a rollback script.
- **Rehearsal** on the new disposable database `hrvo_qa_boards`, restored from the fresh backup:
  1. apply: RLS enabled and forced, 1 policy, grants as designed;
  2. rollback: table and migration row removed;
  3. re-apply: identical;
  4. drift check: none.
- **Then applied** to `hrvo_demo`.
- **Backups**, all in `/run/media/macami/DataDrive/hrvo-db-backups/` (all three dumps checked readable,
  85 tables each):
  - new: `hrvo_demo-pre-v3-final-20261116T0842Z.dump`;
  - earlier: `hrvo_demo-pre-campus-v2-20261116T0707Z.dump`, `hrvo_demo-pre-local-qa-20261116T0019Z.dump`;
  - map backup: `office-map/office-map-44440000-…-v6-20261116T070917Z.json`.
- **Maps:**
  - Acme Demo: campus v2, version 7.
  - Both iCET workspaces: original map, version 1, not upgraded.
- **Scratch databases** still present, by instruction: `hrvo_qa_rehearsal`, `hrvo_qa_rehearsal2`, and the
  new `hrvo_qa_boards`.

## 6. Connection-pool protection (the previous production blocker)

**Code integrated (`cfe1336`):** only the application code and its tests from `eb56b8f` and `d207b52`.
- `PRISMA_CONNECTION_LIMIT` caps Prisma's engine, when the URL is built from `PG*`.
- `PG_POOL_MAX` caps the PrismaService pg pool and the three attendance pools.
- Unset keeps the library defaults, so local Postgres is unchanged.
- Both settings are documented in `.env.example`.

**Not brought over:** the Supabase lockdown and preflight scripts, the EC2 probe, the runbook, the compose
overlay and the auth-hardening test change.

**Budget at the overlay's 3 / 2:** `hrvo_app` uses at most L + 3P + 1 = 3 + 6 + 1 = **10** sessions, under
Supabase's 15 per user. A new unit test assembles the real pool objects and checks this sum.

**Live check** on `hrvo_qa_boards`, an API instance with the overlay settings and no `PGADMIN_*`, under 15 s
of load (120 concurrent requests at a time, 3 signed-in users):

| Setting | Requests | Errors | Most `hrvo_app` sessions |
|---|---|---|---|
| Caps on (3 / 2) | 8,280 | 0 | **6** |
| Caps off (library defaults) | 9,000 | 0 | 22 (over Supabase's 15) |

V3 adds no new connection pool: the board store uses the PrismaService pool.

## 7. Screenshots

All in `docs/assets/`:

| Folder | Contents |
|---|---|
| `v3-final-2026-11-16/` | header at 7 widths, online and reconnecting; isometric office on desktop and phone, garden, zoomed out; chess after an API restart (both players) |
| `v3-final-2026-11-16/campus/` | all 11 rooms in both views; list view |
| `v3-2026-11-16/` | two-player chess, emote, isometric phone, HR work items, HR analytics on desktop and phone, garden water |

## 8. Release notes (V3)

**Office**
- An isometric view of the whole campus, with a Classic / Isometric switch.
- Chess and checkers for two at the arcade table. A game in progress now survives a server restart and
  comes back on both screens.
- Five emotes.
- A pool and pond with glinting water.
- Seats on benches and sofas.
- The office draws only when something changes. It is much lighter on the CPU, and the isometric view
  reaches 60 fps on a laptop GPU.

**HR**
- Work items in attendance analytics: recorded task time, kept as a fourth separate measure; tasks
  completed, open and overdue; timesheet status; activity; and two new CSV columns.

**Everyone**
- The header's tracking status fits on one line on phones and tablets.

**Operators**
- One additive migration: `20261116120000_office_board_games`.
- Optional connection caps, `PRISMA_CONNECTION_LIMIT` and `PG_POOL_MAX`, for a session-mode pooler.

## 9. Known limitations and open items

| # | Item | State |
|---|---|---|
| D4 | Spec 46, first test, seen once in a fresh run: the lead's status request (`PUT /office/me/status`) did not complete within 15 s | **Open, unexplained.** No DB lock or long transaction was seen in a sampled reproduction, and there were no disk errors. It did not recur in 3 later fresh runs or in the final full run (spec 46 passed there). |
| L2 | Crowded scenes in software rendering (no GPU) stay at 10–13 fps | Limit of software rendering; 60 fps with a GPU |
| L3 | After an API restart, avatars come back at the entrance; open game invitations (30 s) lapse | By design (ADR 064) |
| L4 | Ping-pong and other leisure furniture are decoration | By design |
| L5 | Real Google sign-in and real SMTP delivery not verified locally | See §4 |
| L6 | `data-fps` is the frame-logic rate; actual draws are `data-draws` | Documented, ADR 065 |

## 10. Deployment blockers

1. Your approval for a rollout.
2. Push the branch and get a green CI run on the exact commit. CI has never run on this branch.
3. Decide on D4: accept it, or investigate further on CI.
4. Production backup, then apply migration `20261116120000_office_board_games` before the new API
   starts. This branch also carries `20261115000000_office_presence_intervals` and
   `20261116000000_office_presence_security`: check which of them production already has.
5. On Supabase, set `PRISMA_CONNECTION_LIMIT=3` and `PG_POOL_MAX=2` (the overlay's values) for the
   API.
6. Map upgrades per workspace, iCET included, only by their owner's decision, rehearsed first.

## 11. Rollback

1. **Code:** the previous API and web images.
2. **Database, after the previous API is running again:**
   `apps/api/prisma/rollback/20261116120000_office_board_games.down.sql`. It loses only the games in
   progress.
3. **A workspace map:** `scripts/office-map-upgrade.ts <api> --rollback`, one version at a time.
4. **Connection caps:** unset both variables.
5. **Local database:** restore `hrvo_demo-pre-v3-final-20261116T0842Z.dump` if ever needed.

## 12. Commits in this round (after `43d3ca3`)

| Commit | Change |
|---|---|
| `c9e5374` | Board games survive an API restart: migration, store, restore, resume window; RLS and privacy (ADR 064) |
| `391ae01` | Header tracking status on one line at every width; spec 50 |
| `3885353` | Specs 11 and 22 close their browsers; spec 39 guards against left-open contexts |
| `cfe1336` | Connection caps (code from `eb56b8f` and `d207b52`) with a budget test |
| `481a9d0` | Running game in the join answer (reload and restart race) |
| `13fa0c0` | Office draws on change, culling, stable depth list (ADR 065) |
| `b49df45` | Spec 46 waits for the server's nudge rules instead of slow earlier tests |
| `b1e1ee3` | Campus tour screenshots |
| `81a892b` | Spec 48 click-to-go from a fixed point |
| (this commit) | This report |
