# V3 release candidate: office, interactions and HR management

Date: 2026-11-16. Branch `integration/local-qa-2026-11-16`, worktree `hrvo-local-qa`. Final code
commit `8a704aa` (the commits after it add screenshots and this report only).

Local only: not pushed, no PR, no CI run, not deployed. Production database, production maps and
cloud resources untouched.

**Verdict: V3 is a complete local release candidate. It is not ready for production** until the
blockers under "Production prerequisites" are cleared. Every check listed below was run on this machine,
and the result is the one recorded.

## 1. Feature checklist

"Existing" means already built before V3 and re-verified here. "New" means built in V3.

### Avatar interactions (Phase 2)

| Feature | State | Requirement / ADR | Evidence |
|---|---|---|---|
| Nudge (bell), Accept / Ignore, chime | Existing, verified | FR-VO-016, ADR 058 | spec 46 (two browsers, keyboard, phone, reduced motion); API nudge tests |
| Do not disturb, cooldown, one pending, distance, organisation isolation | Existing, verified | FR-VO-016 | spec 46; API tests (DND, away, 6/min, other organisation refused) |
| Wave, dance, jump, sit / stand | Existing, verified | ADR 056 | spec 45 (two people, seen by the colleague; E to sit, walking stands up, taken chair refused) |
| Hug and high five with consent (request, accept, decline, cancel) | Existing, verified | ADR 056 | spec 45 two-person test; `office-actions-e2e` |
| Emotes: laugh, love, thumbs up, idea, coffee break (pixel bubble, 2.5 s) | **New** | FR-VO-018 | spec 45 emote test; `office-actions-e2e`; `office-emote-idea.png` |

### Campus (Phase 3)

| Feature | State | Requirement / ADR | Evidence |
|---|---|---|---|
| Office, café, garden, arcade | Existing (campus v1), verified | ADR 055, 057 | specs 43, 44 |
| Isometric view with Classic / Isometric switch (isometric by default in local development only) | New earlier the same day | FR-VO-001, ADR 061 | spec 48; `docs/assets/isometric-2026-11-16/` |
| Detailed arcade cabinets | Existing, redrawn natively in the isometric view | FR-VO-015, ADR 057, 061 | spec 43; isometric screenshots |
| Swimming pool and pond with a water glint (still under reduced motion) | **New** (campus v2) | FR-VO-019, ADR 063 | `office-campus`, map upgrade tests; `garden-iso.png`, `garden-top.png` |
| Sitting on benches and sofas (20 new places) | **New** | FR-VO-019, ADR 063 | `office-actions` unit tests (110 seats) |
| Multiplayer chess and checkers at the arcade's game table | **New** | FR-VO-017, ADR 062 | `board-game-rules` (11), `office-board-e2e` (6), spec 49 (2); `chess-two-players-*.png` |
| Tic-tac-toe and the other mini-games | Existing, verified | ADR 055 | spec 44 |
| Seasonal decorations (festive mode) | Existing, verified | ADR 055 | spec 44 |
| Map, room ids, desk assignments, collisions | Preserved | ADR 063 | upgrade checks 11/11; assigned desk kept its assignee through v1 → v2 → v1 → v2 |

### HR and Admin attendance dashboard (Phase 4)

| Feature | State | Requirement / ADR | Evidence |
|---|---|---|---|
| Verified work time, office connected time, confirmed meeting time, kept apart | Existing, verified | FR-REP-009, ADR 059 | `attendance-analytics-*` API tests; spec 47 |
| Recorded task time (timer and manual) as a fourth separate measure, never added to work | **New** | FR-REP-010 | `attendance-analytics-e2e` work-items test; spec 47 |
| Tasks completed, open, overdue and due in range; task list | **New** | FR-REP-010 | same; `hr-person-work-items.png` |
| Timesheet status per week; task activity by type | **New** | FR-REP-010 | same |
| CSV export (with "Recorded task time (h)" and "Tasks completed"), audited | Existing, extended | FR-REP-009/010 | export test (audit row, columns) |
| Filters (period, team, person, sort, including by task time) | Existing, extended | FR-REP-009/010 | spec 47 |
| Task titles shown only to people allowed to read them (`tasks.read.all`, own team with `tasks.read.team`, or oneself) | **New** | FR-REP-010 | work-items test |
| Loading, empty and error states; phone layout | Done | — | spec 47; `hr-analytics-phone.png` |

## 2. Implemented in V3 (commits)

| Commit | Change | Requirement | ADR |
|---|---|---|---|
| `5c9e5c0`, `8ee88ed` | Isometric view, phases A and B | FR-VO-001, FR-VO-015 | 061 |
| `7a24ca7` | Classic / Isometric switch, remembered per browser | FR-VO-001 | 061 |
| `0753335` | HR work items in attendance analytics | FR-REP-010 | 059 (updated) |
| `87a2736` | Two-player chess and checkers | FR-VO-017 | 062 |
| `6326db0` | Emotes; chess pieces always drawn as text glyphs | FR-VO-018 | 056 addendum |
| `6f30c1e` | Campus v2: pool, pond, water glint, bench and sofa seats, versioned map upgrade | FR-VO-019 | 063 |
| `8a704aa` | Security test: owner status alone grants no extra access | — | 037 |
| `738aa13` | Evidence screenshots | — | — |

No database migration, no new npm package, and no change to `infra/`, CI, Docker Compose files,
authentication or the attendance state machine since `2e6c160`. API changes are limited to
`office-world.ts`, `office.gateway.ts` (board games, emotes) and `attendance-analytics.service.ts`.

## 3. QA test report

### Final checks on head (`738aa13`)

Run 2026-11-16 under `systemd-inhibit --what=idle:sleep`, with the dev API stopped:

| Check | Result |
|---|---|
| Root lint (`npm run lint`) | pass |
| Root typecheck (`tsc --noEmit`) and web typecheck | pass |
| Build (`tsc`) | pass |
| Full API suite (`dist/apps/api/test/*.test.js`, 169 files) | **1077 / 1077**; 0 failed, 0 skipped (197 s) |
| `prisma migrate status` | 39 migrations; database schema up to date |
| `prisma migrate diff` (schema against `hrvo_demo`) | no difference |

The production web build (`next build` with `NODE_ENV=production`) passed on the web code of
`6f30c1e`; the web code has not changed since. The local app at :3000 runs that build.

### Browser regression (Playwright, full suite)

Run on `6f30c1e` (the code since then adds only an API test file), 53.1 min:

| Result | Count |
|---|---|
| Passed | **140** |
| Failed | 1: spec 39 "toolbar and dock agree across pages; reconnecting is shown; token expiry; take-over" |
| Did not run | 1: the next test in the same serial group (spec 39, phone) |

Spec 39 was then run on its own on the same code: **3 / 3 passed**. The failure was the second tab
showing "You were signed out." during the take-over step. It is recorded as an intermittent defect
(D1 below), not as a pass.

V3 feature specs on their own: 45 (avatar actions, 6/6), 46 (nudge), 47 (analytics, 5/5),
48 (view switch, 2/2), 49 (board games, 2/2).

### Role journeys on the running local app (:3000 / :3001, isometric default)

7 / 7 passed, covering J1–J14:
- J1: employee sign-in and automatic attendance;
- J2–J7: office avatar, movement, actions, nudge with a colleague, DND, campus and a mini-game;
- J8: meeting over LiveKit;
- J9–J11: tasks, timer and timesheet;
- J12: manager analytics;
- J13: HR dashboards, analytics with export and the review queue;
- J14: admin users, roles and audit log, with an employee refused.

Emotes, board games and the HR work items are covered by the specs above and by the screenshot
runs (two-player chess, the emote and the work items, all passed on the same local app).

### Screenshots (`docs/assets/v3-2026-11-16/`)

| File | Shows |
|---|---|
| `chess-two-players-white.png`, `chess-two-players-black.png` | One game in two browsers after 1. e4 e5 2. Nf3 Nc6; black's board is turned round |
| `office-emote-idea.png` | Idea emote bubble above the avatar, isometric office (desktop) |
| `office-phone-isometric.png` | Isometric office on a 390 × 844 phone |
| `garden-iso.png`, `garden-iso-zoom2.png`, `garden-top.png` | Pool and pond, isometric and classic |
| `hr-person-work-items.png` | Person detail: task time, tasks, overdue, timesheets, activity |
| `hr-analytics-desktop.png`, `hr-analytics-phone.png` | HR analytics tab, desktop and phone |

Earlier evidence: `docs/assets/isometric-2026-11-16/`, `docs/assets/office-redesign-2026-11-16/`.

## 4. Security test results

| Check | Result |
|---|---|
| Owner status alone (`owner-scope-e2e`, new) | 3/3 tests. The database lets only a SUPER_ADMIN be owner (`users_owner_role_check`, error 23514). The owner flag adds only `org.owner` and never restores a removed permission (for example `reports.all`, `audit.read`, `attendance.read.all`). Another organisation's owner gets 404 for this organisation's person analytics, 403/404 for its privacy export, and none of its users or rows in lists |
| Organisation isolation in the office | Nudge, actions and board invitations to someone in another organisation are refused (they are not in the office): `office-board-e2e`, nudge and actions API tests |
| Board games | Only the two players can move. Moves out of turn, illegal moves and moves from a third person are refused. An invitation reaches only the person invited. DND and away are respected. Rate limits: one invitation per 3 s, 20 moves per 5 s |
| Analytics scope | Owner, HR, auditor, manager (own team), employee (self) and other organisation, with 404 rules; task titles only with the read permission (`attendance-analytics-e2e`) |
| RLS | Every table has a policy. The tenant-isolation tests of the existing modules are part of the full API suite. V3 adds no tables |
| Route permission guards | `route-guards` test in the full API suite. V3 adds no HTTP routes; the new socket events check membership, reach and the rules above |
| Audit | CSV exports and map upgrades write audit rows (export test; upgrade script checks) |
| Server clock | The new socket events (board, emotes) carry no client timestamps. Invitation expiry and emote duration are timed on the server. Task time comes from stored time entries |

## 5. Database verification

| Check | Result |
|---|---|
| Migrations | 39 applied, `prisma migrate status`: up to date |
| Schema drift (`prisma migrate diff` against `hrvo_demo`) | none |
| V3 migrations | none |
| Campus v2 rehearsal | Disposable copy `hrvo_qa_rehearsal2` (restored from a `pg_dump` of `hrvo_demo`), second API on port 3201: dry run ELIGIBLE, apply (v7), rollback to the exact campus v1 fingerprint (v8), apply (v9). All checks ok |
| Applied locally | `hrvo_demo`, Acme Demo only: campus v1 → v2 (office version 6 → 7), 11/11 checks |
| Not changed | Both iCET workspaces (original map, version 1); every production map |
| Backups | `/run/media/macami/DataDrive/hrvo-db-backups/hrvo_demo-pre-campus-v2-20261116T0707Z.dump`, `office-map/office-map-44440000-…-v6-20261116T070917Z.json`, plus the earlier `hrvo_demo-pre-local-qa-…dump` |

## 6. Outstanding defects and limits

| # | Item | Severity | State |
|---|---|---|---|
| D1 | Spec 39 take-over: in the full run the second tab once showed "You were signed out." (a refresh race between two tabs of the same user) | Medium | Open, intermittent; passes 3/3 alone |
| D2 | The tracking badge wraps onto three lines at 390 px width (`office-phone-isometric.png`) | Low, cosmetic | Open |
| D3 | The isometric view draws more slowly in headless Chromium: about 7–15 fps, against 15–30 fps for classic. Not measured on a real GPU | Low | Open; classic remains available |
| L1 | Board games are kept in memory: an API restart ends running games. No scores are stored | By design (ADR 062) | — |
| L2 | Ping-pong and the other leisure furniture are decoration, not games | By design | — |
| L3 | The scratch databases `hrvo_qa_rehearsal` and `hrvo_qa_rehearsal2` are still on the local Postgres | Housekeeping | Dropping them needs your approval |

## 7. V3 release notes

**Office**
- New isometric view of the whole campus, with a Classic / Isometric switch that each browser
  remembers.
- Chess and checkers for two at the arcade's game table:
  - stand at the table and invite a colleague;
  - the server checks every move;
  - you can resign, and a game ends if a player leaves.
- Five emotes in the Actions menu: laugh, love it, thumbs up, idea, coffee break.
- The garden has a swimming pool and a pond with gently glinting water, still under reduced motion.
- You can sit on the benches and sofas.

**HR and Admin**
- Attendance analytics now shows work items per person and period:
  - recorded task time, from the timer and manual entries;
  - tasks completed, open and overdue;
  - weekly timesheet status and task activity.
- Task time is a separate fourth measure and is never added to verified work time.
- The CSV export has two new columns.

**Administrators**
- Existing workspaces keep their map until an administrator runs `scripts/office-map-upgrade.ts`.
  The script moves the map one version at a time and can be reversed.

## 8. Rollback

1. **Code:** redeploy the previous API and web images, or revert the V3 commits. There are no
   migrations to reverse.
2. **A workspace map upgraded to campus v2:** as an administrator of that workspace, run
   `scripts/office-map-upgrade.ts <api> --rollback`. It goes back one step, v2 → v1, and another run
   goes to the original map. Each step:
   - writes a backup file first;
   - asks for a typed confirmation;
   - checks the rooms, desks, assignments and invitations afterwards.
3. **Local database:** restore `hrvo_demo-pre-campus-v2-20261116T0707Z.dump` if ever needed. It is
   not needed for the map, which `--rollback` restores.
4. **Isometric default:** it is set only by `NEXT_PUBLIC_OFFICE_DEFAULT_VIEW=iso` in the
   git-ignored `apps/web/.env.local`. Without it the default is classic.

## 9. Production prerequisites (not done)

1. Your approval for a rollout.
2. Integrate the connection-pool caps from `eb56b8f` (see `docs/LOCAL-DEVELOPMENT-AND-QA-REPORT.md` §3).
   **This blocks any production deploy of this branch.**
3. Push the branch and get a green CI run on the exact commit.
4. Fix or accept D1.
5. Encrypted production backup, then deploy the images and record rollback tags.
6. Map upgrades per workspace, only by their owner's decision. Rehearse each on a copy first.
