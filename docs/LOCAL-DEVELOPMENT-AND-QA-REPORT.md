# Local development and QA report

Date: 2026-11-16. Machine: Fedora Workstation 44, Podman (no Docker), Node 22.23.1, npm 10.9.8.
Scope: local only. Nothing was pushed, deployed or changed in AWS, Supabase, Cloudflare, LiveKit
Cloud or Gmail. Verdict: **the application runs locally and every tested feature works through
the browser; two blockers and several gaps listed below stand before any production decision.**

## 1. Git baseline

| Item | Value |
|---|---|
| Checkout found | `/run/media/macami/DataDrive/Hr virtual office`, branch `codex/release-integration-2026-11-16` at `a4cc7ea` |
| Its base | `origin/main` (`df69506`, PR #7) + the pixel-campus release (`e7780a6` = `release/pixel-campus-clean-2026-11-16`) + cherry-picks of the map script, arcade, nudge and analytics work |
| Uncommitted work found | `schema.prisma`, migration `20261116000000_office_presence_security`, `office-presence-security.test.ts` (a database hardening, apparently by another agent) |
| Concurrent activity | another agent (Codex) was running a Playwright suite from that checkout (own database `hrvo_release` on 5545, ports 3100–3102). Its run finished 42/42 passed. To avoid breaking it, all work here was done in a separate worktree |
| `main` | local `main` is 50 behind `origin/main`; untouched |
| Remote note | `origin/release/pixel-campus-2026-11-13` already contains "Merge pull request #10" (done outside this session) |

Protection (nothing deleted, no history rewritten):

| Ref / file | What it holds |
|---|---|
| `backup/codex-release-integration-pre-local-qa-2026-11-16` | `a4cc7ea`, the codex branch as found |
| `backup/codex-uncommitted-presence-security-2026-11-16` | `21c1ddc`, a snapshot commit of the uncommitted files (working tree left as it was) |
| `/run/media/macami/DataDrive/hrvo-db-backups/hrvo_demo-pre-local-qa-20261116T0019Z.dump` | `pg_dump -Fc` of `hrvo_demo` before any change (mode 600; restore verified) |
| `office-map-backups/` | untouched in the main checkout (also copied to the session scratchpad) |

## 2. Integration branch

`integration/local-qa-2026-11-16`, worktree `/run/media/macami/DataDrive/hrvo-local-qa`
(own `node_modules`, `dist`, `.next`; the main checkout's `.env` is read in place, never copied).

| Commit | Content |
|---|---|
| `a4cc7ea` | starting point (= codex integration branch) |
| `27389b3` | the found database hardening, reviewed and completed: rollback file, ADR 059 note (FR-AUTH-010, FR-REP-009) |
| `9e13c17` | fix: access-denied message (found in browser QA, FR-AUTH-006) |
| this report | report and screenshots |

The main checkout stays on `codex/release-integration-2026-11-16` with its uncommitted files as found.

## 3. Branch analysis (Phase 4)

`git cherry` against the integration branch (patch-equivalent commits count as present):

| Branch | Application commits missing | Commits missing (all ops/docs) |
|---|---|---|
| `feature/office-pixel-avatar-system` | 0 | 0 |
| `feature/office-pixel-environment` | 0 | 0 |
| `feature/office-campus-expansion` | 0 | 0 |
| `release/pixel-campus-clean-2026-11-16` | 0 | 0 (it is the base) |
| `feature/arcade-pixel-redesign` | 0 | 19 |
| `feature/office-avatar-nudge` | 0 | 19 |
| `feature/hr-attendance-analytics` (`76f64bc`) | 0 features; 1 code change (below) | 19 |

The 19 commits that are missing are the same set on every branch, because those branches grew from
`release/pixel-campus-2026-11-13`:
- Supabase migration and cutover (ADR 052);
- encrypted backups (ADR 051);
- production audits;
- landing-page Cloudflare docs.

The map-script commit `ae64cda` shows as missing, but its script is byte-identical to the integration branch's (`30702bd`). **None of these 19 commits were integrated:** they are production infrastructure, and this assignment is local only.

**Blocker for any production deploy of this branch:** the Supabase prep commit `eb56b8f` contains
application code that production depends on:
- `PG_POOL_MAX` / `PRISMA_CONNECTION_LIMIT` caps in `db-config.ts`, `prisma.service.ts` and `attendance-repository.ts`;
- the `auth-hardening-e2e` trigger change.

The integration branch lacks it, so deploying this branch as-is to the Supabase-backed API would remove the session-pool caps. It must be brought in (and CI run) before a production decision. Locally the caps change nothing, because unset means library defaults.

## 4. Features discovered

| Area | Features (backend → frontend) |
|---|---|
| Auth | Email/password login, workspace signup with email verification, Google sign-in (OIDC), sessions and refresh, logout (also closes attendance), TOTP 2FA (mandatory for HR and admins when enforcement is on), password reset, invitations, role-based access with custom roles |
| Org and HR | Org profile and ownership transfer, employees, teams and org chart, schedules, subcontractor profiles, custom roles |
| Virtual office | Socket.IO world, rooms with knock-to-enter, desks (claim/assign), pixel-art avatars (6 characters, chosen and saved), movement, sit/stand, jump, wave, dance, hug and high five (with consent), avatar nudge with Accept/Ignore, status incl. Do not disturb, broadcast. **No map editor UI** (API `PUT /office/map` only) |
| Campus | Café, Arcade (redesigned), Garden reached from the Lounge; mini-games Tic-Tac-Toe, Memory Match, Sliding Puzzle (client only, nothing saved); festive mode (browser-local setting). Chess and ping-pong are furniture only |
| Communication | Meetings, instant calls, LiveKit audio/video, screen share, recording with consent (Egress), meeting chat, chat channels, calendar sync |
| HR operations | Automatic attendance (signed heartbeat, state machine), breaks, corrections, flags review, desktop agent, leave and holidays, timesheets (timer, manual time, submit/approve), work time / overtime / onsite requests, tasks with assignment, acceptance, comments, checklists, board, planning, projects, reports and manager dashboard, HR attendance analytics with per-employee detail |
| Administration | Policy, attendance guards, roles and access, audit log (hash chain, export), retention, privacy export and anonymisation, documents, vault, e-signature, notifications |

77 web pages, 47 Playwright spec files, 1054 API tests.

## 5. Features integrated

All of these were already integrated on the codex branch; this work verified them and added the hardening:

| Feature | Requirement / ADR |
|---|---|
| Pixel avatars, pixel environment, campus, avatar actions | FR-VO-001/002/003/014, ADR 053–056 |
| Office map upgrade script (safe sign-in, dry run, backup, rollback) | ADR 055 |
| Arcade redesign | FR-VO-015, ADR 057 |
| Avatar nudge | FR-VO-016, ADR 058 |
| HR attendance analytics + office presence intervals | FR-REP-009, ADR 059 |
| Presence hardening (tenant-bound FK, stale-close floor, `pg_temp` last) | FR-AUTH-010, ADR 059 |

## 6. Features not integrated, and why

| Item | Why |
|---|---|
| Supabase cutover/backup/audit commits (ADR 051, 052) | production infrastructure; out of scope for a local assignment |
| Connection-pool caps (`eb56b8f` code part) | same commit as above; needed before production (see §3) |
| Landing-page Cloudflare docs (`88a15b0`) | documentation for production DNS |

## 7. Services (all local Podman containers, pre-existing; none created or removed)

| Service | Container | Address | Health |
|---|---|---|---|
| PostgreSQL 16.15 | `hrvo-pg-tasks` | localhost:5544, database `hrvo_demo` | PASS (`pg_isready`; API `/health` db ok) |
| Redis 7 | `hrvo-redis-test` | localhost:6380, DB 1 | PASS (PONG; BullMQ queue `hrvo-jobs`, 4 clients) |
| S3 (SeaweedFS) | `hrvo-s3-dev` | localhost:8333 | PASS (documents specs) |
| ClamAV | `hrvo-clamav-test` | localhost:3311 | PASS (document upload spec) |
| KMS stand-in (moto) | `hrvo-moto-test` | localhost:4566 | PASS (API suite) |
| LiveKit | `hrvo-livekit-test` | ws://localhost:7880 | PASS (calls, J8) |
| LiveKit Egress | `hrvo-egress-qa` | — (started for spec 22) | PASS (spec 22) |
| Mailhog | `hrvo-mailhog` | SMTP 1025, UI http://localhost:8025 | PASS (reset e-mail delivered) |

The brief listed `hrvo-postgres:5433/hrvo_dev`. That database exists but is **empty** (no tables), and `.env` does not use it. The populated development database is `hrvo_demo` on 5544. Untouched containers include `hrvo-postgres`, `hrvo-redis`, the `hrvo-release-integration_*` set (the other agent's) and every exited container.

## 8. Local URLs

| What | URL | How it was started (from the worktree) |
|---|---|---|
| Web app | http://localhost:3000 | `npm run web:build` with `NODE_ENV=production`, then `npx next start -p 3000` in `apps/web` |
| API | http://localhost:3001 (`/health` → `{"status":"ok","db":"ok","redis":"off"}`) | `npx tsc`, then `node dist/apps/api/src/main.js` with the main checkout's `.env` |
| Mail viewer | http://localhost:8025 | Mailhog |

`redis: "off"` in `/health` is by design: Redis is only reported when multi-instance coordination is on (ADR 020). Jobs use Redis separately, and they are connected.

Demo sign-in: workspace "Acme Demo", with `worker@` (employee), `lead@` (team lead / manager), `hr@`, `admin@` and `sam@` (subcontractor) `acme.demo`. They use the published demo password in `apps/api/test/seed-web-demo.ts`. `AUTH_MFA_ENFORCEMENT=off` in `.env`, so HR and admins sign in without TOTP locally (the API prints a warning).

## 9. Database status

| Check | Result |
|---|---|
| Target | `hrvo-pg-tasks` (local Podman), `localhost:5544/hrvo_demo`; no remote host in `.env` |
| Before | 38 migrations applied, last `20261115000000_office_presence_intervals`; 1 pending |
| Backup | `pg_dump` taken and restored into scratch `hrvo_qa_rehearsal` (34 users, 73 intervals) |
| Rehearsal on the copy | up → no drift → rollback → drift present (expected) → up → no drift; 73 intervals kept |
| Applied | `20261116000000_office_presence_security` → 39 migrations, `prisma migrate diff`: no difference |
| Destructive changes | none (adds a unique constraint, swaps an FK for a stricter one, replaces a function) |
| RLS / grants | `office-presence-security.test.ts`: cross-tenant row refused even for the owner; temp-table shadowing refused; future cutoff cannot close live intervals; `hrvo_app` cannot DELETE/TRUNCATE; `hrvo_retention` cannot execute the function |
| Data preserved | Acme Demo and the four iCET workspaces: organisations, users, avatar choices, office maps (incl. version) and all 60 desk assignments are identical (md5 fingerprints) to the pre-QA backup |

Test orgs come and go in `hrvo_demo`: the test suites create and delete their own (Web E2E Ltd, Nudge Ltd, Presence Ltd and others). The scratch database `hrvo_qa_rehearsal` is still there. Dropping it is safe, but it is left for you to decide.

## 10. Test results (integration branch)

| Check | Result |
|---|---|
| Root lint (`npm run lint`, root + web) | PASS |
| Root typecheck / build (`tsc`) | PASS |
| Web typecheck | PASS |
| `prisma validate`; drift on `hrvo_demo` | PASS; no drift |
| Full API suite, 267 suites (unit, integration, API e2e, auth, attendance, office, avatars, nudge, analytics, security) | **PASS 1054 / 1054**, 0 skipped |
| Production web build | PASS (72/72 pages) after setting `NODE_ENV=production`. With `.env`'s `NODE_ENV=development` loaded, `next build` fails while prerendering; this is an environment issue, not a code defect. Build with `NODE_ENV=production` |
| Full Playwright suite, 47 files, LiveKit Egress on, under a sleep inhibitor | **PASS 137 / 137** (46.3 min), 0 skipped |
| After the fix `9e13c17`: Playwright 05, 12, 47 | PASS 11 / 11 |
| Other agent's run on the same code (office/avatar/campus/actions/nudge/analytics subset) | PASS 42 / 42 (its log, `/tmp/hrvo-release-playwright.log`) |

## 11. Browser testing (real dev app at :3000 / :3001, headless Chromium, fake camera/mic)

| # | Journey | Result |
|---|---|---|
| J1 | Employee signs in; dashboard; automatic attendance ("Tracking: Active since …"); My attendance | PASS |
| J2 | Enter the virtual office; choose another character, save, both maps update; restore the original | PASS |
| J3 | Walk with the keyboard | PASS |
| J4 | Jump, wave, dance | PASS |
| J5 | Nudge a nearby colleague (second browser); they see "nudged you" with Accept/Ignore and accept; sender sees "accepted your nudge" | PASS |
| J5b | Colleague sets Do not disturb: the bell disappears; back to automatic | PASS |
| J6 | Café, Arcade, Garden | PASS |
| J7 | Tic-Tac-Toe from an arcade cabinet; play a move; close | PASS |
| J8 | Instant call; colleague accepts the ring; both connected over local LiveKit with a remote tile | PASS |
| J9–J11 | Create a task, run its timer, mark it done; the timer entry appears on My timesheet | PASS |
| J12 | Manager: team attendance analytics, no export buttons, employee detail page | PASS |
| J13 | HR: dashboard, analytics with CSV/XLSX/PDF export, attendance review | PASS |
| J14 | Admin: users, roles, audit log, policy; employee refused on `/admin/users` (API 401/403 and UI); sign out | PASS |
| — | Login rate limit: about 13 sign-ins in 2 minutes got "Too many requests; please slow down" (default 10/min) | PASS (security works). The journeys were then run with the same raised limit the Playwright config uses, and the API was restarted with the defaults afterwards |
| — | Password-reset e-mail reaches Mailhog | PASS |

Also covered by the Playwright suite rather than by hand: hug and high five with consent, sit/stand at a desk, festive mode, Memory Match and Sliding Puzzle, screen share, recording, leave, timesheet submit/approve, documents, vault, e-sign, privacy export and anonymisation, workspace signup, Google sign-in against a fake OIDC provider, the desktop agent.

Test data added: one task "QA journey <time>" with a short timer entry for `worker@acme.demo`, attendance sessions and office intervals from the sign-ins, one call, and one password-reset token. The worker's saved character was restored to `indigo`.

Screenshots: `docs/assets/local-qa-2026-11-16/`.

## 12. Bugs found and fixed

| Bug | Reproduction | Root cause | Fix | Retest |
|---|---|---|---|---|
| Wrong access-denied text | Sign in as an employee, open `/admin/users`: "Users is available to team leads, managers and HR" | One generic message (since 2026-10-15) used on ~40 pages with different permissions | `9e13c17`: "… is not available with your current role. Ask an administrator if you need access." | Web typecheck/lint; Playwright 05, 12, 47 11/11; J14 asserts the new text in the browser |
| Presence hardening uncommitted, without rollback | — | Left in the working tree | `27389b3` with a rollback file, rehearsal and ADR note | Security 4/4, presence + analytics 23/23, full suite 1054/1054 |

Observed once, not reproduced: just after sign-in, while several earlier sessions for the same person had just closed, the badge showed "Reconnecting… tracking paused" for about 8 s. In two later 25-second observations it went from "checking…" to "Active" every time. Not treated as a defect.

## 13. Remaining blockers

| Blocker | Status |
|---|---|
| Connection-pool caps (`eb56b8f`) not on the integration branch | BLOCKED for production; must be integrated before any deploy |
| No CI run on the integration branch (local results only) | BLOCKED until pushed (needs your approval) |
| Real Google sign-in locally | BLOCKED: `GOOGLE_REDIRECT_URI` in `.env` points at an old trycloudflare tunnel; the fake-OIDC flow (spec 32) passes |
| Real camera/microphone and audio quality | not verified by a person; tests use Chromium's fake devices against local LiveKit |
| `owner@acme.demo` missing in the demo workspace (seeded before owners existed) | owner-only screens verified in the test workspaces (spec 31); re-seeding would reset Acme Demo, so it was not done |

## 14. Ready for local use (PASS)

Sign-in, sessions, logout, 2FA (where enforced), roles and permissions; organisation, teams, users, invitations, roles; virtual office with pixel avatars, movement, actions, nudge, DND, rooms, desks; campus areas, arcade redesign, three mini-games, festive mode; meetings, calls, screen share, recording (with the Egress container), chat; attendance, breaks, corrections, leave, timesheets, work time, tasks, projects, planning; reports, manager dashboard, HR attendance analytics and per-employee detail; audit log, retention, privacy export/anonymisation, documents, vault, e-signature, notifications.

## 15. Not yet ready

| Item | State |
|---|---|
| Production deployment of this branch | not ready: §13 |
| Map editor UI | not implemented (API only) |
| Chess and ping-pong | furniture only, not games |
| Mini-game scores, festive mode per organisation | not stored (by design so far) |

## How to repeat

1. From the worktree, run `npx tsc`, then `npm run lint` and `npm run web:typecheck`.
2. Run the API suite with the `.env` variables loaded: `node --test --test-concurrency=4 dist/apps/api/test/*.test.js`.
3. Run the browser suite: `podman start hrvo-egress-qa`, then in `apps/web` run `LIVEKIT_EGRESS=1 npx playwright test` with `.env` loaded. Run it under `systemd-inhibit --what=idle:sleep`, because the laptop sleeps mid-run.
4. Start the dev app as described in §8.
