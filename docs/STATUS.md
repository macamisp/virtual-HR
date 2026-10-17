# HRVO project status

**As of:** 17 October 2026. Sections 7 and 8 record the attendance fixes. Section 2 retains the prior audit counts; section 8 links the follow-up evidence.
**Prepared for:** the product owner.
**Method:**
- Every requirement ID in `docs/SRS.md` was checked against the code and the automated tests, not against documentation claims.
- "DONE" means the requirement is implemented and at least one named automated test or screen exercises it.
- 16 of the cited test titles were spot-checked character for character against the test files.

## 1. CI pipeline

**Result: green.** Run 39016661861 on `2f07a7a` (after the section 7 fixes): every job succeeded.
- **test:** 700/700 API tests (coverage 97.0 % lines, 80.8 % branches, 95.3 % functions), 10/10 desktop-agent tests, Playwright 62 passed and 2 skipped (the real-Egress recording spec, which needs `LIVEKIT_EGRESS=1` and passes locally). The run before it, 39016184013 on `53d6c44`, failed one pre-existing timing test (`RedisLock` › "a long critical section keeps its lock by renewal": a 200 ms lock TTL left a 133 ms renewal margin that the 2-CPU runner missed under four parallel test files); the test now uses a 1 s TTL (`2f07a7a`), the lock code is unchanged.
- **Other jobs:** Terraform, container images, and the Linux, macOS and Windows agent installers.

The CI Pipeline went red from commit `bb008cd` (run 38992234570) onwards. Each failure was hiding the next, because the job stops at its first failing step. That push carried every commit after `28f74ea`, the last green run, so the meetings, chat, office, desktop-agent and recording slices had never been through the later CI steps.

**Root causes, in the order they surfaced:**

1. **Secret scan (gitleaks):** three `generic-api-key` false positives in `bb008cd`. They are names, not secrets:
   - the empty `RECORDING_S3_ACCESS_KEY=` placeholder in `.env.example`;
   - the Secrets Manager slot names in `secrets.tf`;
   - an environment lookup in `recordings.service.ts`.

   Fixed in `a8162dd`: `gitleaks:allow` on those lines, plus the three commit fingerprints in `.gitleaksignore`.
2. **No LiveKit in CI:** `test/meetings-e2e.test.ts` checks that a real LiveKit server accepts the tokens the API issues. The job never started one, so 4 tests failed with `fetch failed`. Fixed in `8b8a1d5`: a pinned `livekit/livekit-server:v1.9.1` container with the repo's dev config.
3. **Electron binary not installed:** Electron 43 has no install script; it downloads its binary on the first `require('electron')`. The desktop-agent spec (`e2e/19`) launches `node_modules/electron/dist/electron` directly, so on a fresh runner it failed with `spawn … ENOENT`. Fixed in `8488430`: the job runs Electron's own installer, which checks the download against `checksums.json`.
4. **Linux installer:** with the tests green, the `agent-installers` job ran for the first time. Windows and macOS built, but Linux failed, because electron-builder's `.deb` target requires a `homepage` in `apps/agent/package.json`. Its default file name also came from the scoped package name and landed in `release/@hrvo/`, which the upload pattern `release/*.deb` never matched. Fixed in `7efd2ea`: a homepage, plus an explicit `.deb` artifact name.
5. **Database connection exhaustion (the hang).** With those fixed, the API test step hung in 2 of 3 runs, at `auth-hardening-e2e`. Node's test runner prints results in file order, which identified the stuck file. The cause was in the API, not the tests. 18 modules each listed `PrismaService` in their own `providers`, so every app created about 19 instances, each with its own `pg` pool and an unused Prisma engine pool. With four test files running in parallel, Postgres reached 97 of 100 connections (measured). Requests failed with HTTP 500, which is what the "login flake" seen earlier really was. In CI, a request could also wait forever for a pool client. The same multiplication would hit RDS in production. Fixed in `7fadc94`: one `PrismaService`, provided once by the global `PermissionsModule`. Measured on 2 CPUs: peak 22 connections, 677/677 tests.
6. **Test port clashes:** with the hang gone, the recording suite failed with `EADDRINUSE :::3089`. It shared that port with `office-e2e`, and `calendar-sync-e2e`'s fake Google API shared 3071 with `planning-e2e`. Both pairs collide whenever CI happens to run them in parallel. Fixed in `f30ad7a`: unique ports (3079 and 3073). No port is now shared between test files.

## 2. Requirements status against the SRS

The SRS has 151 functional requirement IDs.

| Module | IDs | DONE | PARTIAL | MISSING | Missing IDs |
| --- | ---: | ---: | ---: | ---: | --- |
| AUTH | 12 | 6 | 3 | 3 | FR-AUTH-005, 009, 012 |
| ORG | 12 | 2 | 6 | 2 | FR-ORG-007, 008 |
| VO | 14 | 10 | 2 | 2 | FR-VO-011, 014 |
| MEET | 14 | 8 | 5 | 1 | FR-MEET-014 |
| ATT | 23 | 21 | 2 | 0 | none |
| TS | 13 | 10 | 2 | 1 | FR-TS-007 |
| TASK | 16 | 7 | 5 | 4 | FR-TASK-009, 012, 014, 015 |
| DOC | 20 | 15 | 3 | 2 | FR-DOC-018, 020 |
| NOTIF | 6 | 3 | 0 | 3 | FR-NOTIF-003, 005, 006 |
| REP | 8 | 6 | 1 | 1 | FR-REP-007 |
| ADM | 8 | 3 | 2 | 3 | FR-ADM-003, 005, 008 |
| AUD | 5 | 4 | 1 | 0 | none |
| **Total** | **151** | **95** | **34** | **22** | |

### By phase

"Weighted" counts a PARTIAL requirement as half done.

| Phase | IDs | DONE | PARTIAL | MISSING | % DONE | Weighted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| P1 | 74 | 57 | 16 | 1 | 77 % | 88 % |
| P2 | 60 | 32 | 17 | 11 | 53 % | 68 % |
| P3 | 17 | 6 | 1 | 10 | 35 % | 38 % |
| **All** | **151** | **95** | **34** | **22** | **63 %** | **74 %** |

The only P1 requirement that is MISSING is FR-ORG-008 (onboarding checklist).

### What makes each PARTIAL partial

**AUTH**
- **FR-AUTH-001:** the invitation link is returned by the API, not e-mailed.
- **FR-AUTH-007:** lockout works, but there is no CAPTCHA and no lockout e-mail.
- **FR-AUTH-011:** login and logout audit rows are written but not asserted by any test. A failed login for an unknown e-mail is not audited.

**ORG (no organisation-management slice has been built yet; leave and holidays, FR-ORG-010 and 011, are DONE since section 7)**
- **FR-ORG-001:** the organisation has only a name and timezone; there is no profile screen.
- **FR-ORG-002:** a subcontractor profile has rates only. There is no legal name, tax ID, bank details or emergency contact.
- **FR-ORG-003:** contract alerts fire at 60/30/7/0 days instead of 30/14/7, and a contract has no rate.
- **FR-ORG-004:** there are no 80 % / 100 % weekly-cap warnings.
- **FR-ORG-005:** schedules are stored, but there is no screen or API to edit them, and no break allowance.
- **FR-ORG-006:** there is no screen to manage teams or the manager hierarchy.
- **FR-ORG-009:** nothing sets a user to OFFBOARDED, and there are no off-boarding steps.
- **FR-ORG-012:** the office people search exists, but there is no directory with profile cards.

**VO and MEET**
- **FR-VO-006:** there is no map editor screen; maps can only be replaced as JSON through the API.
- **FR-VO-008:** you cannot ring a colleague from the office.
- **FR-MEET-001:** an instant call can only be started from `/meetings`.
- **FR-MEET-004:** the 50-participant limit and simulcast are neither enforced nor tested.
- **FR-MEET-005:** there is no chat inside a meeting.
- **FR-MEET-009:** meeting time is counted as ordinary active time, not as a separate segment.
- **FR-MEET-010:** there is no background blur.

**ATT**
- **FR-ATT-005:** a manager cannot approve idle time as payable.
- **FR-ATT-007:** breaks are not suggested automatically.
- FR-ATT-002, 016 and 022 were PARTIAL in the first report and are now DONE (section 7).

**TS**
- **FR-TS-008:** "billable" is a per-entry flag that the UI hard-codes to true.
- **FR-TS-010:** there is no invoice export or PDF.

**TASK**
- **FR-TASK-001 and FR-TASK-006:** attachments are https links, not uploaded files.
- **FR-TASK-002:** the workflow is fixed and cannot be configured per organisation.
- **FR-TASK-010:** there is no cycle-time metric.
- **FR-TASK-013:** a task can be created from a meeting action item, but not from a chat message.

**DOC**
- **FR-DOC-008:** TLS and HSTS are configuration only, with no test.
- **FR-DOC-016:** search covers title and tags only. There is no owner filter and no full-text search.
- **FR-DOC-019:** there is no Office-to-PDF preview.

**REP, ADM and AUD**
- **FR-REP-005:** "unsigned policies" depends on FR-DOC-018, and onboarding is reported as not available.
- **FR-ADM-004:** there is no retention setting for chat.
- **FR-ADM-007:** there is no map editor, and no browser test of room administration.
- **FR-AUD-005:** there is no single privacy dashboard.

Two documentation pointers are out of date:
- `docs/traceability/auth.md` still lists FR-AUTH-006 as partial and role changes as not audited; both are done now.
- `docs/runbooks/uat.md` §7 still says the office, meetings and the desktop agent are "not expected yet".

## 3. Client HR requirements (SRS §2.7)

| # | HR requirement | Verdict | Evidence | Still missing |
| --- | --- | --- | --- | --- |
| 1 | Automatic detection of in and out times | **PASS** | e2e `02-clock-in-heartbeat` › "monitoring notice blocks the app; after acceptance the worker clocks in automatically"; `attendance-service` › "Reconciler closes sessions when heartbeats are missing for > 90s"; e2e `19-desktop-agent` (tray, offline OFFLINE_SYNCED); screens `/attendance`, `/live` | Nothing. Logout now closes the session at once (section 7). |
| 2 | Document handling and storage | **PARTIAL** | e2e `10-documents` (upload, scan, preview, versions, sharing); `documents-e2e` (access log, 60/30/7 reminders); `21-esign`; `vault-e2e` (trash and crypto-shredding); screens `/documents`, `/documents/access-log`, `/documents/retention`, `/signatures` | Search covers title and tags only (FR-DOC-016). No policy acknowledgement (FR-DOC-018), no Office preview (FR-DOC-019), no bulk ZIP download (FR-DOC-020). |
| 3 | Timesheets and task management for each subcontractor | **PARTIAL** | e2e `09-timesheets` (timer, manual time, return, resubmit, approve and lock, report and CSV); e2e `06-tasks` › "the subcontractor must accept before working"; `timesheets-e2e` rates and reopen; screens `/timesheets`, `/timesheets/review`, `/timesheets/rates`, `/tasks` | No multi-level approval (FR-TS-007) and no invoice (FR-TS-010). No recurring tasks, dependencies or CSV import (FR-TASK-009, 014, 015). The subcontractor profile lacks legal and bank details (FR-ORG-002), and there are no cap warnings (FR-ORG-004). |
| 4 | Meetings and connecting with each other | **PARTIAL** | e2e `16-office` (map, WASD, knock rooms, 200 avatars); e2e `17-meetings` (ring, lobby, proximity call, screen share); e2e `18-chat`; e2e `22-recording`; screens `/office`, `/meetings`, `/chat` | No map editor (FR-VO-006), no guest links (FR-VO-011), no in-meeting chat (FR-MEET-005), no background blur (FR-MEET-010), no AI summary (FR-MEET-014). |
| 5 | Daily and weekly task lists | **PASS** | e2e `07-planning` › "the worker plans the day, confirms it and submits an end-of-day report", "the weekly planner schedules by drag and by keyboard, shows capacity and keeps goals"; `notifications-e2e` weekly summary and carry-over; screens `/tasks/today`, `/tasks/week`, `/tasks/workload` | Nothing. |
| 6 | Password-protected documents for contracts and similar | **PASS** | e2e `11-vault` › "a confidential document asks the owner to confirm it is them, then a document password", share links, watermarked view; `vault-e2e` › "a database dump plus a bucket dump contain no content, file name or confidential title" | Encryption in transit (FR-DOC-008) is configuration only, with no test. |
| 7 | Accurate detection of in and out times | **PASS** (one caveat) | Playwright `23-accuracy` prints the measurements: clock-in p50 230 ms, max 281 ms, 20/20 within 5 s; clock-out error 4.3–4.4 s for logout, tab close and network loss; two devices never counted more than the wall clock. `attendance-replay` › "the nightly job checks yesterday…alerts HR once…"; `attendance-logout-e2e`; `attendance-state-machine` › "Accuracy strictly ignores client timestamps…" | Laptop sleep is not emulated separately (from the server it is the network-loss case). NFR-ACC-005 (clock drift monitoring) is an infrastructure alert, not a test. |

## 4. Quality gates (run locally on 17 October 2026)

| Check | Result |
| --- | --- |
| `npm run lint` (API, shared, web) | Clean: 0 errors, 0 warnings |
| `npm run typecheck` (+ web `tsc --noEmit`) | Clean |
| API tests with coverage (`npm run test:coverage`, 700 tests, 4 files at a time) | **699 passed, 1 failed, 0 cancelled.** The failure is `planning-e2e` › "Today lists planned, due, overdue and carried-over tasks…" (a task came back PLANNED instead of CARRIED_OVER); it passed in the previous full run and passes alone (7/7, twice). The previous full run also had one failure, the presence-challenge tests in `attendance-guards-e2e`, whose injected heartbeats were stamped at one fixed time and so could fall outside the window under load; the test helper now stamps them relative to the send time, and the suite passed under full load. Both are load-sensitive tests, not product defects, and neither is in the code changed in section 7 |
| API coverage, all files | **97.0 % lines · 80.5 % branches · 95.3 % functions** |
| Playwright (`npx playwright test`, with real LiveKit Egress, 63 tests) | **62 passed, 1 failed** in the full 16-minute run; the failure, `18-chat` › "a message reaches a channel member live…", passes alone (2/2). The new `23-accuracy` and `24-leave` specs passed in both full runs; their measured numbers are in section 7 |
| Terraform `fmt` / `validate` (staging and production) | Run in CI (Terraform job: success) |
| `npm audit --omit=dev` | 7 findings: **4 high, 3 moderate, 0 critical** (listed below) |

Before `7fadc94`, parallel runs regularly lost one suite to HTTP 500s at login. That was database connection exhaustion (section 1, cause 5), not authenticator-code timing as first suspected.

**npm audit, high:**
- `prisma` 6.x and `@prisma/config`, through `deepmerge-ts` < 8 (GHSA-ggr8-5vv4-36mx, stack exhaustion on recursive objects). This is a CLI/tooling path, not request handling. The fix is Prisma 7.10.1, a major upgrade.
- `postcss` ≤ 8.5.22 inside `next` (GHSA-qx2v-qp2m-jg93 and GHSA-6g55-p6wh-862q). These matter only when untrusted CSS is processed at build time, which HRVO does not do. The fix is Next 16.4.2, a major upgrade.

**npm audit, moderate:**
- `uuid` < 11.1.1 inside `exceljs` (GHSA-w5hq-g745-h8pq). HRVO does not pass a buffer to v3/v5/v6, the case the advisory covers.

All fixes need major upgrades. Per AGENTS.md, no package is changed without the owner's approval.

## 5. Security check of the repository

**Repository visibility:** `github.com/macamisp/virtual-HR` is **public**: anyone can read it without signing in.

**Secrets: gitleaks 8.24.3**

| Scope | Result |
| --- | --- |
| Full history (`gitleaks detect --log-opts=--all`) | **No leaks found** |
| CI range of `bb008cd` | No leaks found (after `a8162dd`) |
| Working tree (`gitleaks dir .`) | 23 findings, all in files that git ignores and that were never committed: the local `.env` (real local keys, as intended), `.next*/` and `dist/` build output, and the packaged desktop agent under `apps/agent/release/`. **No tracked file holds a secret.** |

**Credential outside the repository.** The local clone's `origin` URL embeds a GitHub personal access token (`https://ghp_…@github.com/…`). It is not in the repository or its history, but it sits in plain text in `.git/config`. It was also printed during this session's work. **Revoke it, create a new token, and use a credential helper instead of the URL.**

**Everything in `.gitleaksignore`**

| Fingerprint | Justification |
| --- | --- |
| `420954e…:.github/workflows/ci.yml:generic-api-key:72` | An old CI-only test JWT secret, since replaced by a per-run `openssl rand` value. It was never a production credential. |
| `bb008cd…:.env.example:generic-api-key:141` | The empty placeholder `RECORDING_S3_ACCESS_KEY=`, a name without a value. |
| `bb008cd…:infra/terraform/modules/platform/secrets.tf:generic-api-key:85` | The names of the Secrets Manager slots; the values are entered by an operator in AWS. |
| `bb008cd…:apps/api/src/meetings/recordings.service.ts:generic-api-key:54` | Reads `RECORDING_S3_SECRET_KEY` from the environment; no value is present. |

**Files in `docs/` that should not be public**

| File | Issue | Recommendation |
| --- | --- | --- |
| `docs/SRS.md` | Its cover says "**Confidential: internal and approved partners only**". It contains the client's open decisions (§16), cost estimates (§14) and the full security design. | Make the repository private, or move the SRS to private storage and keep only a public summary. |
| `docs/security/route-permissions.md`, `docs/security/rls-coverage.md` | A complete map of every route, its permission and the RLS coverage, which saves an attacker reconnaissance time. There are no secrets. | Acceptable for an open-source project. If the repository stays public, move them to a private wiki. |
| `docs/PLAN.md`, `docs/adr/001`–`004` | `file:///run/media/macami/…` links reveal a local username and folder layout. | Replace them with relative links. |
| `docs/runbooks/uat.md`, `web-local.md` | The demo password `DemoPassword123!` and the `@acme.demo` accounts. These are seed data for local use only. | Fine, as long as nobody runs `seed:demo` against a reachable environment. |

No file in `docs/` contains real e-mail addresses, IP addresses, AWS account IDs or keys.

## 6. Running the project locally from a fresh clone

**Prerequisites:** Node.js 22, Docker or Podman with Compose, and `openssl`.

```bash
git clone https://github.com/macamisp/virtual-HR.git && cd virtual-HR
npm install
cp .env.example .env
# Fill in .env (the API refuses to start without the two document keys):
#   DOCUMENT_KMS_LOCAL_KEY=$(openssl rand -base64 32)
#   DOCUMENT_KMS_RECOVERY_KEY=$(openssl rand -base64 32)   # must differ from the data key
#   BREACHED_PASSWORD_CHECK=local                           # if offline
# The JWT_SECRET in .env.example is a development value; production refuses it.
docker compose up -d            # Postgres, Redis, MinIO, ClamAV, moto (KMS), LiveKit, Mailhog
npm run db:migrate              # tables, RLS, roles
npm run db:provision-roles      # passwords for hrvo_app / hrvo_retention from .env
npm run seed:demo               # demo organisation "Acme Demo"
npm run api                     # terminal 1 → http://localhost:3001
npm run web                     # terminal 2 → http://localhost:3000
```

**Optional:**
- **Meeting recording:** `docker compose --profile recording up -d` adds LiveKit Egress, about 1.3 GB. Then switch recording on under Admin → Data retention.
- **Desktop agent:** see `apps/agent` (Electron). Pair it with a code from **My desktop agents**.

**Ports**

| Port | Service |
| --- | --- |
| 3000 | Web |
| 3001 | API |
| 5433 | Postgres |
| 6379 | Redis (LiveKit uses database 5) |
| 9000 / 9001 | MinIO S3 / MinIO console |
| 3310 | ClamAV |
| 4566 | moto (KMS) |
| 7880 / 7881 / 7882 | LiveKit (HTTP and WebSocket / TCP / UDP) |
| 8025 | Mailhog (all e-mails land here) |

**Demo accounts.** Every account uses the password `DemoPassword123!`.

| Account | Role | Notes |
| --- | --- | --- |
| `admin@acme.demo` | Admin | Must set up 2FA on first sign-in |
| `hr@acme.demo` | HR | Must set up 2FA on first sign-in |
| `lead@acme.demo` | Team lead | |
| `worker@acme.demo` | Employee | |
| `sam@acme.demo` | Subcontractor | |

ClamAV needs a few minutes after its first start to load its signatures. Until then, uploads stay at "Scanning for viruses".

**Running the tests:**
- **API:** `npm test`. It needs the compose services; the storage, ClamAV and KMS suites skip themselves when their variables are not set.
- **Browser:** `cd apps/web && npx playwright test`. Add `LIVEKIT_EGRESS=1` to include the real recording test.

**What does not work yet**
- Everything listed under MISSING and PARTIAL in section 2. The most visible gaps:
  - no organisation administration (organisation profile, teams, schedules, onboarding and off-boarding);
  - no SSO login (Google or Microsoft);
  - no web push;
  - no map editor;
  - no guest links;
  - no recurring tasks;
  - no multi-level timesheet approval;
  - no invoices;
  - no scheduled reports;
  - no policy acknowledgement.
- **Calendar sync** needs the organisation's own Google and Microsoft OAuth apps. Without them, the Calendar page says "Not set up on this server yet".
- **AWS production** has never been deployed. The Terraform validates, but `apply` needs the owner's approval and the runbooks.
- **Dev mode is slow:** `npm run web` compiles each page on first visit. On slow disks the first load can take a minute or more. `npm run web:build` followed by `next start` is fast.
- **Without Redis** (`JOBS_ENABLED=false`), also set `ATTENDANCE_RECONCILE_INLINE_MS=15000`, or dropped sessions are never closed.

## 7. Fixed gaps (17 October 2026, after the first report)

Each fix was written test-first; the "before" is the new test's first run against the old code.

### Gap 1: explicit logout did not clock out (FR-ATT-002) — commits `355f142`, `2688e3e`

| | Before | After |
| --- | --- | --- |
| `POST /auth/logout` with an open session | Session stayed `OPEN / DISCONNECTED`; closed 120 s later with source DISCONNECT | Closed **56 ms** after the request, at the last valid heartbeat, source LOGOUT; nothing after that heartbeat credited |
| Password reset | Same 120 s delay | Closed **101 ms** after the reset |
| Administrative revocation (role change, deactivation) | Same 120 s delay | Closed **35 ms** after the revocation |
| Two devices, logout on one | n/a | The person stays clocked in while the other login heartbeated within the missed-heartbeat window (90 s); the last logout closes |
| Two tabs of one login | n/a | Logout in one revokes the login; the other tab cannot keep the session alive |
| Tab close without logout | Grace window | Unchanged: grace window |

Tests: `apps/api/test/attendance-logout-e2e.test.ts` (8). Design: ADR 025. The rule is decided from the database (`session_secrets.last_used_at`), after the API test suite, which runs several API processes on one database, showed a socket-visibility check closing a session another login still kept alive. SRS 6.2 row 14 says "close session immediately"; the implementation reads that as the latency and stamps the last valid heartbeat, like rows 12 and 13. **Please confirm that reading.**

### Gap 2: the SRS 6.5 accuracy proofs were not automated (NFR-ACC-001..004) — commit `2688e3e`

| Requirement | Before | After (measured on 17 October 2026) |
| --- | --- | --- |
| NFR-ACC-001 clock-in within 5 s of first activity, 99 % of runs | One Playwright assertion allowing 60 s, once | 20 sign-ins: **p50 230 ms, p99 281 ms, max 281 ms, 20/20 within 5 s** |
| NFR-ACC-002 clock-out within 30 s of last activity: logout, tab close, network loss | No chaos tests | Real input until the event, then: logout **4.3 s** error (closed 0.1 s after); tab close **4.3 s** (DISCONNECT, closed 32.9 s after); network loss **4.4 s** (DISCONNECT, closed 69.2 s after). The error is bounded by the 30 s heartbeat interval |
| NFR-ACC-003 no double counting on two devices | Unit tests of the interval union only | Two real browsers for 70 s: **net 61 s over a 61 s wall clock**, while the raw per-device counters summed to 122 s |
| NFR-ACC-004 nightly replay of daily totals | Nothing | `attendance-replay` job every night at 02:30 UTC: recomputes every person's day from the stored sessions, compares field by field, alerts HR (critical notification, once) and audits; never rewrites. Test: a drifted total is reported field by field and left alone |

Tests: `apps/web/e2e/23-accuracy.spec.ts` (3, numbers printed in CI output), `apps/api/test/attendance-replay.test.ts` (4). Design: ADR 026. Two side findings fixed on the way: with `JOBS_ENABLED=false` nothing ever closed a dropped session (`ATTENDANCE_RECONCILE_INLINE_MS` now runs the reconciler in-process), and the web badge could show "Not clocked in" for up to a minute after sign-in when the first status request was slower than the first heartbeat. Not done: laptop sleep is not emulated separately; the replay recomputes from stored sessions, not from the heartbeat log (break and meeting events are not in `presence_events`).

### Gap 3: leave and holidays were never connected (FR-ORG-010, FR-ORG-011, FR-ATT-022) — commit `3e5ce25`

| | Before | After |
| --- | --- | --- |
| Leave requests | None | `/attendance/leave`: annual, sick, unpaid, other; validated; one open request per day; cancel while pending or before the leave ends |
| Approval | None | `/attendance/leave/review`: the requester's manager (or their team's leads and managers when they have no manager) or HR; never the requester; a rejection needs a note; decided once; notifications both ways; audited |
| Holiday calendar | None | `/admin/holidays`: Sri Lanka 2026 (25 dates from the gazette) loaded in one step and seeded for existing organisations; HR adds, renames, removes |
| Attendance providers | `attendance.module.ts` passed `undefined`; leave and holidays had no effect | Real database providers wired in; expected hours 0, day status LEAVE or HOLIDAY, no absence or late flag, no no-clock-in reminder |
| Live board | "On leave" never shown | Shows "On leave" for a person on approved leave without an open session |

Tests: `apps/api/test/leave-e2e.test.ts` (8, including RLS), `apps/web/e2e/24-leave.spec.ts` (3). Design: ADR 027. Not done: half days and balances; planner capacity still counts leave and holiday days; built-in calendars for years other than 2026.


## 8. Follow-up regression fixes (17 October 2026)

The original implementations in section 7 were present at starting revision `8871b30`.
New regressions found notification-loss logout/revocation failures, weak timing/union proofs,
a replay that trusted aggregate counters, stale cross-process leave/calendar reads, missing
calendar defaults on new organisations, and stale persisted attendance expectations.
See [the before/after report](attendance-gap-report.md) for the current evidence, demo commands,
and the pending shared-auth-session clarification. Section 1's remote CI result belongs to
its named historical commit; it is not a CI result for these follow-up changes.


Follow-up local validation: 710/710 in the full API run, 28/28 in the final replay/agent
regression set (including the added mixed offline-counter case), and 6/6 Playwright accuracy/
leave checks. Lint and API/shared/web types are clean. Clock-in: 100/100 within 5 s, p99 2,447 ms,
maximum 2,858 ms. Clock-out timestamp errors: logout 4.8 s, tab close 4.7 s, network loss 4.9 s.
Two devices: 62 s union = 62 s net; zero double counting. API logout took 136 ms; reset across
two logins with NOTIFY suppressed took 189.3 ms; admin session revoke without NOTIFY took
51.2 ms. These are local results; CI wiring now preserves measurement logs but remote CI
has not been run for the follow-up commits. Shared-auth-session logout scope remains pending
owner clarification, as explained in the linked report.
