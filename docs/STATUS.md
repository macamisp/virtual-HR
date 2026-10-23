# HRVO project status

**As of:** 23 October 2026, on `main` after merging `feat/workspace-signup-owner` (PR #1).
**Prepared for:** the product owner.
**Method:**
- Every one of the 151 requirement IDs in `docs/SRS.md` was checked again against the code and the automated tests, not against earlier documents.
- Every test title quoted below was matched against the test files.
- **DONE:** every clause of the SRS row is implemented, and at least one automated test exercises it.
- **PARTIAL:** some clauses are implemented and some are not; the missing ones are named.
- **MISSING:** essentially nothing is implemented.

**Stricter re-check.** This check was stricter than the one on 19 October. Eleven requirements went from DONE to PARTIAL because one clause of each is not met. No feature was removed. Two of them conflict with the SRS through a deliberate design choice, and need the owner's decision (section 6).

## 1. CI pipeline

**Result: green.** Run 39895676489 on `main` at `6dfba2c` (the merge of PR #1): every job succeeded.
- **API:** 839 / 839.
- **Browser:** 77 passed, 2 skipped (recording).
- **Database:** zero "deadlock detected" and zero conflict retries in the log.
- **One flaky test:** `24-leave` › "the worker sees the approval; an admin loads the Sri Lanka 2026 calendar" failed once and passed on CI's single retry. It is the same locator race described in section 4, and it is fixed in the commit after this one.

- **ADR 038 deadlock fix:** on the branch, the same commit was green three times in a row before the merge (run 39884559761, attempts 1 to 3).
- **Each of those runs:** 839/839 API tests, 78 browser tests passed, zero "deadlock detected", zero conflict retries.
- **Jobs:** `test`, `terraform`, `images` and the three `agent-installers`.

## 2. Requirements status against the SRS

| Module | IDs | DONE | PARTIAL | MISSING | Missing IDs |
| --- | ---: | ---: | ---: | ---: | --- |
| AUTH | 12 | 7 | 4 | 1 | FR-AUTH-012 |
| ORG | 12 | 5 | 5 | 2 | FR-ORG-007, 008 |
| VO | 14 | 9 | 3 | 2 | FR-VO-011, 014 |
| MEET | 14 | 9 | 4 | 1 | FR-MEET-014 |
| ATT | 23 | 19 | 4 | 0 | none |
| TS | 13 | 10 | 2 | 1 | FR-TS-007 |
| TASK | 16 | 6 | 6 | 4 | FR-TASK-009, 012, 014, 015 |
| DOC | 20 | 15 | 3 | 2 | FR-DOC-018, 020 |
| NOTIF | 6 | 3 | 0 | 3 | FR-NOTIF-003, 005, 006 |
| REP | 8 | 5 | 2 | 1 | FR-REP-007 |
| ADM | 8 | 3 | 2 | 3 | FR-ADM-003, 005, 008 |
| AUD | 5 | 4 | 1 | 0 | none |
| **Total** | **151** | **95** | **36** | **20** | |

### By phase

"Weighted" counts a PARTIAL requirement as half done.

| Phase | IDs | DONE | PARTIAL | MISSING | % DONE | Weighted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| P1 Core HR MVP | 74 | 57 | 16 | 1 | 77 % | 88 % |
| P2 Virtual office and meetings | 60 | 32 | 19 | 9 | 53 % | 69 % |
| P3 Hardening and advanced | 17 | 6 | 1 | 10 | 35 % | 38 % |
| **All** | **151** | **95** | **36** | **20** | **63 %** | **75 %** |

The only P1 requirement that is MISSING is FR-ORG-008: an onboarding checklist for each new person. The `/onboarding` wizard sets up the workspace for the owner; it is not that checklist.

### What changed since 19 October

**Owner's decisions, applied on 23 October (ADR 039, SRS 1.1):** FR-AUTH-001 and FR-AUTH-004 are DONE.
- **FR-AUTH-001:** the SRS now says what the product does. Anyone may create a new workspace. People join an existing one by invitation only. The one exception is an owner-enabled own-domain Google join, off by default, which refuses public mail domains.
- **FR-AUTH-004:** Owner, Admin and HR always answer 2FA after a Google sign-in. The owner's switch now covers only people who turned 2FA on for themselves.

**Moved from DONE to PARTIAL, each confirmed in the code:**
- **FR-AUTH-004, 2FA mandatory for Admin and HR:** an owner could switch off "2FA after a Google sign-in". *Fixed the same day (decision above).*
- **FR-VO-002, avatars.** An avatar is a coloured disc with initials. There is no photo and no chosen character.
- **FR-VO-005, proximity.** The radius is fixed at 96 when the office is created. No screen or API changes it.
- **FR-ATT-013, corrections with evidence.** Evidence is an unchecked document id in the API. No screen attaches or shows it, and no test uses it.
- **FR-ATT-016, live board by team.** The team filter exists in the API, but the board screen never offers it.
- **FR-TASK-007, acceptance escalation.** The escalation time is a database value (default 24 h) that no screen or API can change.
- **FR-REP-006, PDF export.** The four reports under Reports export PDF. The timesheet report exports only CSV and XLSX.

**Same verdict, new reason:**
- **FR-AUTH-001:** invitations are e-mailed, resent and revoked, but self-service signup conflicted with "invitation only". *Resolved the same day by the SRS amendment (decision above).*
- **FR-ORG-001:** the organisation now has a profile and an onboarding wizard (name, time zone, work week). Logo, currency and colours are still missing.
- **FR-ORG-009:** people can now be suspended and offboarded, with sessions ended and tasks reassigned. Timesheets are not locked, and retention is not applied, at offboarding.

**Totals:** 100 / 30 / 21 became 93 / 38 / 20, and after the owner's decisions of 23 October (below) 95 / 36 / 20. The old total row also had one arithmetic slip: its module rows added up to 20 MISSING, not 21.

### What makes each PARTIAL partial

**AUTH**
- **FR-AUTH-005:** Google works end to end (ADR 037). Microsoft is missing. The client id is per server, not per organisation.
- **FR-AUTH-007:** lockout works, but there is no CAPTCHA on sign-in and no lockout e-mail.
- **FR-AUTH-009:** an administrator can end a session or suspend a person, but nobody can list sessions, and a person cannot see or end their own devices.
- **FR-AUTH-011:** a failed sign-in for an unknown address is not audited. No test checks the logout audit row.

**ORG**
- **FR-ORG-001:** no logo, currency or brand colours.
- **FR-ORG-003:** a contract has no rate of its own.
- **FR-ORG-004:** the weekly hours cap is per subcontractor, not per project.
- **FR-ORG-009:** offboarding does not lock timesheets or apply retention.
- **FR-ORG-012:** the office people search exists, but there is no directory with profile cards.

**VO and MEET**
- **FR-VO-002:** no avatar photo or character.
- **FR-VO-005:** the proximity radius cannot be configured, and no test checks the volume falloff.
- **FR-VO-006:** no map editor screen; the map is replaced as JSON through the API.
- **FR-MEET-001:** a call cannot be started from a chat.
- **FR-MEET-004:** simulcast is switched on but untested. The 50-participant limit is set only in the development LiveKit configuration.
- **FR-MEET-009:** meeting time is not credited to attendance. The meetings code never calls the attendance meeting hooks.
- **FR-MEET-010:** no background blur. No test covers the quality features.

**ATT**
- **FR-ATT-005:** a manager cannot approve idle time as payable.
- **FR-ATT-007:** breaks are never suggested automatically.
- **FR-ATT-013:** correction evidence is not checked, shown or tested.
- **FR-ATT-016:** the board cannot be filtered by team on screen.

**TS**
- **FR-TS-008:** billable is a per-entry flag, and the screen always sends true. The project's billable setting is stored but not used.
- **FR-TS-010:** no invoice export or PDF, and subcontractors cannot produce one.

**TASK**
- **FR-TASK-001 and 006:** attachments are https links, not uploaded files.
- **FR-TASK-002:** the workflow is fixed in code.
- **FR-TASK-007:** the escalation time cannot be configured.
- **FR-TASK-010:** no cycle time; completion and on-time are counts, not rates.
- **FR-TASK-013:** a task can be made from a meeting action item, but not from a chat message.

**DOC**
- **FR-DOC-008:** only the database link's TLS is tested. HSTS and the minimum TLS version are configuration only.
- **FR-DOC-016:** search covers title and tags only. There is no owner filter and no full-text search.
- **FR-DOC-019:** no Office-to-PDF preview.

**REP, ADM and AUD**
- **FR-REP-005:** no "unsigned policies" (FR-DOC-018 is missing). Onboarding is reported as not available.
- **FR-REP-006:** the timesheet report has no PDF export.
- **FR-ADM-004:** no retention setting for chat.
- **FR-ADM-007:** no map editor, and no browser test of room administration.
- **FR-AUD-005:** no privacy dashboard. A person can download their own data, but cannot see what is collected, how long it is kept, or who opened their documents.

## 3. Client HR requirements (SRS §2.7)

| # | HR requirement | Verdict | Evidence | Still missing |
| --- | --- | --- | --- | --- |
| 1 | Automatic detection of in and out times | **PASS** | e2e `02-clock-in-heartbeat` › "heartbeats carry counters only (no content) and are signed"; `attendance-state-machine` › "FR-ATT-001: Automatic clock-in requires zero manual button press"; `attendance-logout-e2e` › "POST /auth/logout closes the open session within 1 s, at the last valid heartbeat, source LOGOUT"; e2e `19-desktop-agent` › "consent screen, pairing with a web code, tray icon, agent heartbeats" | Nothing for detection. The live board cannot be filtered by team on screen (FR-ATT-016), which is not part of detection. |
| 2 | Document handling and storage | **PARTIAL** | `documents-e2e` › "a new upload adds a version; restoring an old one adds another, nothing is overwritten", › "every view, download, upload, ACL change, restore and deletion is logged with who, IP and agent", › "60/30/7 days to the owner and HR, the tightest stage reached, once"; e2e `10-documents` | No full-text or owner search (FR-DOC-016), policy acknowledgement (FR-DOC-018), Office preview (FR-DOC-019) or bulk ZIP download (FR-DOC-020). |
| 3 | Timesheets and task management for each subcontractor | **PARTIAL** | `timesheets-e2e` › "the manager approves; the amount is stored with the currency and the approval is audited", › "stops automatically at clock-out, at the last valid heartbeat"; `subcontractor-profile-e2e`; `weekly-cap-e2e` › "80 % and 100 % reach the subcontractor, their manager and HR once each; another week does not count"; e2e `09-timesheets`, `06-tasks` | No multi-level approval (FR-TS-007) and no invoice (FR-TS-010). Billable is not taken from the project (FR-TS-008). No recurring tasks, dependencies or CSV import (FR-TASK-009, 014, 015). Task attachments are links only. No per-project hours cap. |
| 4 | Meetings and connecting with each other | **PARTIAL** | `meetings-e2e` › "an instant call rings the invited; they go straight in, others wait in the lobby", › "host controls: mute all and remove; attendees cannot; removal sends people back to the lobby"; e2e `16-office`, `17-meetings`, `25-office-calls`, `18-chat` | No map editor (FR-VO-006), guest links (FR-VO-011), background blur (FR-MEET-010), AI summary (FR-MEET-014) or call from chat (FR-MEET-001). Meeting time is not credited to attendance (FR-MEET-009). In the planned AWS layout, room and proximity audio would fail (section 5, item 1). |
| 5 | Daily and weekly task lists | **PASS** | e2e `07-planning` › "the worker plans the day, confirms it and submits an end-of-day report", › "the weekly planner schedules by drag and by keyboard, shows capacity and keeps goals"; `notifications-e2e` › "automatic carry-over moves open tasks planned on earlier days to today, logged" | Nothing. |
| 6 | Password-protected documents for contracts and similar | **PASS** | `vault-e2e` › "a database dump plus a bucket dump contain no content, file name or confidential title", › "the download limit, revocation and bad tokens all end in the same 404", › "a wrong password fails, is logged, and the third locks the user out and tells HR"; e2e `11-vault` | HSTS and the TLS version are configuration only, with no test (FR-DOC-008). |
| 7 | Accurate detection of in and out times | **PASS** | Playwright `23-accuracy` on 23 October: clock-in 100/100 within 5 s (about 230–290 ms); clock-out time 4.4–4.5 s from the last activity for logout, tab close and network loss; two devices never counted more than the wall clock (61 s = 61 s). `attendance-replay` and `attendance-raw-replay` (NFR-ACC-004, 0 differences, injected drift found). `lock-order` (ADR 038): no attendance write is lost to a deadlock or to shutdown. | Laptop sleep is not emulated separately (from the server it is the network-loss case). Clock-drift monitoring (NFR-ACC-005) is an infrastructure alert, not a test. |

## 4. Tests: results, skips and confirmations

**Local run on `main` (23 October 2026):**

| Check | Result |
| --- | --- |
| `npm run lint` (API, shared, web) | Clean |
| `npm run typecheck`, `npm run web:typecheck` | Clean |
| API tests with coverage | **839 / 839 passed, 0 skipped**. Coverage 97.2 % lines, 80.6 % branches, 95.5 % functions. |
| Playwright, full suite | **77 passed, 2 skipped, 1 failed** in 17.9 minutes. The skips are the two recording tests (below). The failure was `24-leave` › "the worker sees the approval; an admin loads the Sri Lanka 2026 calendar". Its `Year` locator also matched the "Remove … New Year Day" buttons whenever the holiday list had loaded first, so it was a race in the test, not a product fault. The locator now matches the label exactly, and the spec passed 6 of 6 (run twice). |

**Skipped tests, and why**
- **Browser `22-recording` (2 tests):** skipped unless `LIVEKIT_EGRESS=1` and `S3_ENDPOINT` are set. Recording needs LiveKit's Egress container, about 1.3 GB with a headless Chrome inside, which CI does not start. The recording API is covered in CI by `recordings-e2e`. This is the only skip on purpose, and `npm run verify` fails on any other.
- **Suites that skip themselves when a service is missing:** API `documents-e2e`, `vault-e2e`, `esign-e2e` and `recordings-e2e`, and browser `10-documents`, `11-vault` and `21-esign`. They skip without S3 or ClamAV settings. CI and `npm run verify` provide those services, so they ran in every run above.
- The full list of what is not tested automatically is in `docs/verification/untested-and-skipped.md`.

**Three behaviours confirmed by a test on 23 October:**
- **(a) Logout closes the attendance session immediately.** `attendance-logout-e2e` › "POST /auth/logout closes the open session within 1 s, at the last valid heartbeat, source LOGOUT" (10/10 in that suite). Measured in Playwright `23-accuracy`: closed 0.2 s after logout.
- **(b) Leave and public holidays suppress the absence and late flags, and the live board shows "On leave".**
  - `leave-e2e` › "approved leave: expected hours are zero, no absence flag, the day is LEAVE, the reminder stays quiet".
  - `leave-e2e` › "a holiday is excluded from expected time and suppresses the absence and late flags".
  - `leave-e2e` › "leave today shows as "On leave" on the live board and can no longer be cancelled once it has started".
  - Browser `24-leave` › "the lead approves it and the live board shows the worker on leave".
  - **Test fix found on the way:** these tests seeded work schedules with the wrong field names (`startTime`/`endTime` instead of `start`/`end`). Nobody could ever be late in them, so the late-flag assertions passed without proving anything. The data is corrected, a control case (late on an ordinary working day) was added, and the suite passes 10/10. The same fix went into `attendance-replay`.
- **(c) The LAN HTTPS setup exists.** `npm run lan:env`, `lan:certs`, `lan:check`, `lan:share-ca`, `lan:up` and `lan:down` are in `scripts/lan.ts`, `lan-proxy.ts` and `lan-https.sh` (ADR 036, `docs/runbooks/lan-https.md`). Certificates come from mkcert when it is installed, otherwise from a local OpenSSL CA. A Node TLS proxy serves HTTPS. `lan-config.test.ts` passes 10/10. `lan:check` itself is a manual diagnostic, not a CI test.

## 5. Known limitations, in plain language

1. **The planned AWS layout would break parts of the office.** AWS has never been deployed, but in the planned layout every REST request goes to the API tasks, while the office lives in the memory of one separate "realtime" task. As a result:
   - joining room or proximity audio would answer "Enter the office first";
   - admin changes to rooms or the map would not reach the live office;
   - the office page would show everyone offline.

   `docs/verification/single-instance-assumptions.md` lists all 16 places that assume one API instance, with the change each needs. A local or single-server install is not affected.
2. **Mail must be set up to receive account e-mails.** In development run Mailhog with `MAIL_TRANSPORT=smtp`; for real delivery use Resend (`docs/runbooks/mail.md`). With `MAIL_TRANSPORT=memory` nothing arrives. Links use `APP_WEB_URL`, which must be the LAN or public HTTPS address when people open e-mails on other devices.
3. **Meeting time does not count separately in attendance.** It counts as ordinary active time.
4. **The office avatar is a disc with initials**, and the proximity radius cannot be changed.
5. **No onboarding checklist for new people, no CSV import, no policy acknowledgement, no invoices, no multi-level approvals, no recurring tasks, no scheduled reports, no web push, no guest links, no map editor and no Microsoft sign-in.** These are the MISSING and PARTIAL items in section 2.
6. **No metrics package yet.** Database conflict retries show up as a `db_conflict_retry` log line and an in-process counter. At deployment, a CloudWatch log metric filter turns them into an alarm (ADR 038, `infra/terraform/README.md`).
7. **Calendar sync needs the organisation's own Google and Microsoft OAuth apps.** Without them, the Calendar page says "Not set up on this server yet".
8. **Only Chromium is tested.** Firefox, Safari and phones are not tested. There is no automated accessibility scan.
9. **Without Redis** (`JOBS_ENABLED=false`), set `ATTENDANCE_RECONCILE_INLINE_MS=15000`. Otherwise dropped sessions are never closed.
10. **npm audit:** high-severity findings in `prisma` (tooling) and in `postcss` inside `next` (build time only). The fixes are major upgrades, which need the owner's approval.

## 6. Decisions needed from the owner

1. **Decided on 23 October (applied in ADR 039):** Owner, Admin and HR always need 2FA after a Google sign-in. Self-service workspace creation stays. Joining an existing workspace is by invitation only, and domain auto-join stays off by default.
2. *(no open decision)*
3. **Branches.** After the merge of PR #1 on 23 October, every branch except one is fully contained in `main`:
   - **`feat/workspace-signup-owner`** (local and remote): merged.
   - **`feat/audit-hardening`** (local and remote): merged.
   - **Local only, merged:** `feat/calls-chat`, `feat/internet-demo`, `feat/org-people`, `feat/verification-pack`. Each is checked out in a worktree left by an earlier session.
   - **`feat/org-people-original`** (local only): **not merged on purpose.** It is the pre-rewrite copy of `feat/org-people`. Its nine commits are on `main` under new commit ids, and merging it would duplicate that history.

   All of these can be deleted. Nothing was deleted, because that is the owner's call.
4. **Credentials:** rotate the Google client secret that was pasted into `.env.example` on 23 October; it was never committed, but it appeared in a working session. Also replace the GitHub token embedded in the local `origin` URL with a credential helper.

## 7. Security check of the repository

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

## 8. Running the project locally from a fresh clone

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
docker compose up -d            # Postgres, Redis, storage (SeaweedFS), ClamAV, moto (KMS), LiveKit, Mailhog
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
| 9000 | Document storage (S3 API, localhost only) |
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

## 9. History (17 to 19 October 2026)

Kept as written at the time. Their counts and verdicts are superseded by section 2.

### H1. Fixed gaps (17 October 2026, after the first report)

Each fix was written test-first; the "before" is the new test's first run against the old code.

#### Gap 1: explicit logout did not clock out (FR-ATT-002) — commits `355f142`, `2688e3e`

| | Before | After |
| --- | --- | --- |
| `POST /auth/logout` with an open session | Session stayed `OPEN / DISCONNECTED`; closed 120 s later with source DISCONNECT | Closed **56 ms** after the request, at the last valid heartbeat, source LOGOUT; nothing after that heartbeat credited |
| Password reset | Same 120 s delay | Closed **101 ms** after the reset |
| Administrative revocation (role change, deactivation) | Same 120 s delay | Closed **35 ms** after the revocation |
| Two devices, logout on one | n/a | The person stays clocked in while the other login heartbeated within the missed-heartbeat window (90 s); the last logout closes |
| Two tabs of one login | n/a | Logout in one revokes the login; the other tab cannot keep the session alive |
| Tab close without logout | Grace window | Unchanged: grace window |

Tests: `apps/api/test/attendance-logout-e2e.test.ts` (8). Design: ADR 025. The rule is decided from the database (`session_secrets.last_used_at`), after the API test suite, which runs several API processes on one database, showed a socket-visibility check closing a session another login still kept alive. SRS 6.2 row 14 says "close session immediately"; the implementation reads that as the latency and stamps the last valid heartbeat, like rows 12 and 13. **Please confirm that reading.**

#### Gap 2: the SRS 6.5 accuracy proofs were not automated (NFR-ACC-001..004) — commit `2688e3e`

| Requirement | Before | After (measured on 17 October 2026) |
| --- | --- | --- |
| NFR-ACC-001 clock-in within 5 s of first activity, 99 % of runs | One Playwright assertion allowing 60 s, once | 20 sign-ins: **p50 230 ms, p99 281 ms, max 281 ms, 20/20 within 5 s** |
| NFR-ACC-002 clock-out within 30 s of last activity: logout, tab close, network loss | No chaos tests | Real input until the event, then: logout **4.3 s** error (closed 0.1 s after); tab close **4.3 s** (DISCONNECT, closed 32.9 s after); network loss **4.4 s** (DISCONNECT, closed 69.2 s after). The error is bounded by the 30 s heartbeat interval |
| NFR-ACC-003 no double counting on two devices | Unit tests of the interval union only | Two real browsers for 70 s: **net 61 s over a 61 s wall clock**, while the raw per-device counters summed to 122 s |
| NFR-ACC-004 nightly replay of daily totals | Nothing | `attendance-replay` job every night at 02:30 UTC: recomputes every person's day from the stored sessions, compares field by field, alerts HR (critical notification, once) and audits; never rewrites. Test: a drifted total is reported field by field and left alone |

Tests: `apps/web/e2e/23-accuracy.spec.ts` (3, numbers printed in CI output), `apps/api/test/attendance-replay.test.ts` (4). Design: ADR 026. Two side findings fixed on the way: with `JOBS_ENABLED=false` nothing ever closed a dropped session (`ATTENDANCE_RECONCILE_INLINE_MS` now runs the reconciler in-process), and the web badge could show "Not clocked in" for up to a minute after sign-in when the first status request was slower than the first heartbeat. Not done: laptop sleep is not emulated separately; the replay recomputes from stored sessions, not from the heartbeat log (break and meeting events are not in `presence_events`).

#### Gap 3: leave and holidays were never connected (FR-ORG-010, FR-ORG-011, FR-ATT-022) — commit `3e5ce25`

| | Before | After |
| --- | --- | --- |
| Leave requests | None | `/attendance/leave`: annual, sick, unpaid, other; validated; one open request per day; cancel while pending or before the leave ends |
| Approval | None | `/attendance/leave/review`: the requester's manager (or their team's leads and managers when they have no manager) or HR; never the requester; a rejection needs a note; decided once; notifications both ways; audited |
| Holiday calendar | None | `/admin/holidays`: Sri Lanka 2026 (25 dates from the gazette) loaded in one step and seeded for existing organisations; HR adds, renames, removes |
| Attendance providers | `attendance.module.ts` passed `undefined`; leave and holidays had no effect | Real database providers wired in; expected hours 0, day status LEAVE or HOLIDAY, no absence or late flag, no no-clock-in reminder |
| Live board | "On leave" never shown | Shows "On leave" for a person on approved leave without an open session |

Tests: `apps/api/test/leave-e2e.test.ts` (8, including RLS), `apps/web/e2e/24-leave.spec.ts` (3). Design: ADR 027. Not done: half days and balances; planner capacity still counts leave and holiday days; built-in calendars for years other than 2026.


### H2. Follow-up regression fixes (17 October 2026)

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

### H3. Organisation and people (19 October 2026)

Four slices on branch `feat/org-people`, each with migration, API, screens, tests and an ADR. Owner's decisions on the open points are recorded in the ADRs.

| Requirement | Before | After |
| --- | --- | --- |
| FR-ORG-006 teams and manager hierarchy | `teams` and `manager_id` existed and drove approvals; no API or screen to change them | `/admin/teams` and `/admin/org-chart` (HR, admins): teams, leads, each person's team and manager; loops refused (direct, indirect, and two opposite changes at once); team names unique per organisation; every change audited. ADR 031 |
| FR-ORG-005 work schedules | No editor; the engine ignored effective dates and `flexible`, used one grace for late and early, had no break allowance | `/admin/schedules` (`schedules.manage`): organisation default, team or person, versions from today on; engine uses the schedule in force on the day, no late/early flags for flexible hours, separate early-leave grace, break allowance flagged (`EXCESS_BREAK`, net unchanged) on the day, the live board and "My days"; the replay checks the new field. ADR 032 |
| FR-ORG-002 subcontractor profile | Rates only | Legal name, company, country, contact, emergency contact; tax ID and bank details AES-256-GCM under a per-profile key wrapped by the KeyProvider; masked for HR, clear only through the audited reveal (the person, or HR manager/admin); every read audited without values. ADR 033 |
| FR-ORG-004 weekly cap warnings | Cap used only for overtime pay | 80 % and 100 % warnings to the subcontractor, their approvers and HR, once per threshold per week; banner on the timesheet page; running timers checked every 15 minutes. Per-project cap not done. ADR 034 |
| FR-ORG-008 onboarding | Missing | Still missing (owner: a separate slice) |

Proofs asked for: `subcontractor-profile-e2e` › "a subcontractor cannot read, reveal, edit or list another person's profile…" and › "a database dump does not reveal tax or bank values: every row of every table, as text, in plain, hex or base64 form" (with a positive control), plus a log-capture test. Engine and crypto tests were written first (`schedule-compliance`, `profile-crypto`).

Gates on the branch (19 October 2026): lint and typecheck clean; API **743 / 744** with coverage 97.2 % lines, 80.8 % branches, 95.5 % functions (the one failure is the date-dependent timesheet reminder test below); Playwright **67 passed, 2 skipped** (recording needs Egress), 1 failed and 1 not run in the full run: `11-vault` › "a share link opens one document…" got a generic download file name under load and passes alone (3 / 3). Two suites also hit a Postgres deadlock in their setup (`DELETE FROM organizations` racing another suite's `presence_events` inserts). Root cause found and fixed on 23 October 2026 (ADR 038): inconsistent lock order between session saves, audit appends and parent-row writers, plus attendance writes outliving `app.close()`; reproduced deterministically in `lock-order.test.ts`.

Found on the way, not fixed here: three tests fail on `main` as well on 19 October 2026 (`timesheets-e2e` › "owners are reminded to submit on the last day…", `reports-e2e` › "per assignee…", `attendance-guards-e2e` › "several open items alert the manager once per week"); they look date-dependent and need their own fix. The server accepts a 2FA code only inside its own 30-second step (no tolerance); the new e2e admin sign-in waits for a fresh step.

### H4. Verification pack results (19 October 2026)

- **CI** on `main` at `50648cc` (internet demo merged): all jobs green (`test`, `terraform`, `images`, three `agent-installers`).
- **`npm run verify`** on a development computer: lint PASS, types PASS, API tests 759 passed / 0 failed / 0 skipped, browser tests 70 passed / 1 failed / 1 not run (because of the failure) / 2 skipped. The failure was the share-link download file name in spec `11-vault` (a random name instead of the document's); it passed when run alone straight after (3 of 3). See known issue 17.
- **Measured accuracy:** NFR-ACC-001 median 220 ms, 99th percentile 277 ms (100/100 within 5 s); NFR-ACC-002 logout clock-out closed 0.1 s after the event, tab close 35.4 s, network loss 69.2 s (clock-out time itself 4.3-4.4 s off); logout closes the session 65 ms after the request; NFR-ACC-003 wall clock 61 s counted 61 s; NFR-ACC-004 a total altered by 600 s was reported.
- **Why 2 browser tests are skipped:** the two `22-recording` tests need LiveKit's Egress container (about 1.3 GB). CI starts LiveKit but not Egress, so they are skipped there; they passed on 17 October with `LIVEKIT_EGRESS=1`. Recording is covered in CI by the API tests.
- **Where the three earlier fixes landed (all on `main`):** logout closes the session: 355f142, 2688e3e, 1d0b590, a0e71ae. Accuracy numbers (NFR-ACC-001..004): 2688e3e, 2e910cd, 53d6c44. Leave and holidays: 3e5ce25, facebe8, 92e2f18, f76c6ec.
