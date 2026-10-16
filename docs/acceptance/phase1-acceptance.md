# Phase 1 acceptance — HR Virtual Office

Date: 16 October 2026. Scope: SRS §2.7 (the seven client HR requirements), §14.2 (AC-01..AC-16), NFR-ACC-001..004 under load, §10.3 security controls. No new features were added for this pass; the fixes made are listed in §5.

Status words: **PASS** = demonstrated by an automated test named below (API suite 469+ tests, Playwright 37 specs) or by the load run; **FAIL** = was failing at the start of the pass and is fixed (see §5); **N/A** = Phase 2 scope per SRS §13.4.

## 1. HR requirement compliance matrix (SRS §2.7)

| # | Client requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Auto detection of in/out times | PASS | Heartbeat engine, state machine rows 1–16 (`attendance-state-machine.test.ts`), reconciler and Postgres edge cases (`attendance-postgres-edge-cases.test.ts`), live board (`attendance-self-service-e2e`), Playwright 02, 03, 05. Web client only in Phase 1; no desktop agent. |
| 2 | Documentation handling and storage | PASS | Upload/scan/versions/ACL/access log/expiry (`documents-e2e.test.ts`, 20 tests), Playwright 10. FR-DOC-014/016/018/020 (OCR, e-signature, search index, bulk) are P2/P3. |
| 3 | Timesheet and task management per subcontractor | PASS | `timesheets-e2e.test.ts` (33), `tasks-e2e.test.ts` (19), rates and project overrides, Playwright 06, 09. |
| 4 | Meetings and connecting | N/A | Virtual office and meetings are Phase 2 (SRS §13.4). The attendance engine already credits `IN_MEETING` time from the `inCall` signal (state machine rows 6–7). |
| 5 | Daily and weekly task lists | PASS | Today list, confirm, end-of-day report, carry-over, weekly planner (`planning-e2e.test.ts`, `notifications-e2e` "automatic carry-over"), Playwright 07. |
| 6 | Password-protected documentation | PASS | Vault: re-authentication, document password with lockout and recovery, envelope encryption, share links, watermark (`vault-rules.test.ts`, `vault-e2e.test.ts` 21), Playwright 11. |
| 7 | Accurate in/out detection | PASS | Server-authoritative clock (`FR-ATT-003` test), 30 s heartbeat / 120 s grace, NFR-ACC-001..004 verified under load (§3). |

## 2. Acceptance criteria (SRS §14.2)

| Ref | Scenario | Status | Evidence / manual script |
| --- | --- | --- | --- |
| AC-01 | Sign in at 09:00:00, move the mouse → clock-in 09:00:00–09:00:05, no button | PASS | The worker sends a heartbeat immediately on socket connect and on becoming leader (`heartbeat.worker.ts` `connect` → `sendHeartbeat()`); the first ack creates the session. Load run: first-ack p99 in §3. Tests: state machine row 1, `attendance-self-service-e2e` "a WebCrypto-signed heartbeat clocks in", Playwright 02. Manual: UAT-03. |
| AC-02 | Close the tab at 17:30 → closed within 30 s after grace, clock-out = last heartbeat | **FAIL → fixed** | Clock-out already equalled the last heartbeat (rows 12–13), but the reconciler ran every 60 s, so closure could lag up to 60 s after the grace window. Now every 15 s (`jobs.service.ts`). Verified in §3 (NFR-ACC-002). Manual: UAT-07. |
| AC-03 | Internet cut 60 s then restored → same session, gap logged | PASS | `attendance-reconnect.test.ts` "the same session continues (no second clock-in)", row 11; Playwright 02 "a dropped connection … recovers". Manual: UAT-06. |
| AC-04 | Internet cut 10 min → closed at last heartbeat; correction suggestion when back | **FAIL → fixed** | Closure: `attendance-postgres-edge-cases` "10-minute network outage". The suggestion did not exist: `GET /attendance/me/today` now returns `lastClosed` (time, cause, unaccounted minutes) and the attendance page shows a notice linking to the correction form. Manual: UAT-06. |
| AC-05 | No input 6 min → IDLE; 16 min → PAUSED; idle not payable | PASS | State machine rows 2, 4; `FR-ATT-005` test; thresholds are per organisation (ADR 011) with 5/15 min defaults. Manual: UAT-04. |
| AC-06 | 30-minute meeting without input → counted as meeting time | PASS (engine) | Rows 6–7 credit `meeting_seconds` from the `inCall` signal. The meeting product itself is Phase 2, so the signal comes from the client flag only. |
| AC-07 | Laptop and phone at once → one merged session, no double counting, flag | PASS | `FR-ATT-010` interval-union tests; `MULTI_DEVICE` flag; load run with 20 two-device users (§3, NFR-ACC-003). Manual: UAT-08. |
| AC-08 | Session across midnight → split at org midnight, totals correct | PASS | Row 15 (state machine, service, Postgres), DST case `America/New_York`. |
| AC-09 | 42 h attendance vs 30 h logged → variance alert; approve with comment or reject | PASS | `timesheets-e2e` "daily close … flags variance over 15 %", "flagged past days raise one in-app variance alert", "reject needs a comment", "the manager approves"; Playwright 09. Manual: UAT-16. |
| AC-10 | Approved timesheet edited → blocked; only reopen permission, audited | PASS | `timesheets-e2e` "a submitted timesheet is locked, in the API and in the database", "only timesheet.reopen reopens … audited". Manual: UAT-17. |
| AC-11 | Open another subcontractor's contract by URL → denied and logged, no leak | PASS | `documents-e2e` "subcontractors see only their own", "every view … is logged"; `vault-e2e` "without a grant every route answers 404 and the body names nothing"; Playwright 10. Manual: UAT-22. |
| AC-12 | Confidential download after 15 min → re-auth; wrong password logged; right one streams | PASS | Re-auth window default 10 min (≤ 15), `vault-e2e` "Re-authentication", "a wrong password fails, is logged, and the third locks"; Playwright 11. Manual: UAT-21. |
| AC-13 | Bucket + DB dump → content and confidential names unreadable | PASS | `vault-e2e` "a database dump plus a bucket dump contain no content, file name or confidential title". |
| AC-14 | Daily plan Monday, 2 unfinished → carried to Tuesday, on the weekly planner | PASS | `planning-e2e` "end-of-day report … carries unfinished plan items over", "weekly planner … carry-over"; `notifications-e2e` "automatic carry-over"; Playwright 07. Manual: UAT-12. |
| AC-15 | Two users walk into the same room → A/V in 3 s, meeting credit | N/A | Phase 2 (virtual office). |
| AC-16 | Contract expiring in 30 days → email and in-app alert to HR and manager | **FAIL → fixed** | Only document expiry reminders existed (owner + HR). Added `contractReminders` in the hourly document job: HR and the person's manager, in-app + email, at the 60/30/7/0-day stages inside the contract's notice period, once each (`documents-e2e` "AC-16"). Manual: UAT-24. |

## 3. Load test and accuracy (NFR-ACC-001..004)

Setup: dedicated API instance (`PORT=3102`, database `hrvo_load`, Redis db 2, jobs enabled), 200 seeded employees, k6 v2.3 (`load/heartbeat.js`): each virtual user signs in, opens a Socket.IO connection and sends a signed heartbeat every 30 s for 15 minutes; 20 extra "phone" connections re-use users 1–20 as a second device. Verification script `load/verify-accuracy.mjs` ran against the database after the run.

**Run of 16 October 2026, 03:33–03:49 UTC** (`load/out/summary-15m.json`, `load/out/k6.log`, `load/out/accuracy-15m.txt`):

| Measure | Result | Target |
| --- | --- | --- |
| Connections | 220 (200 users + 20 second devices), all signed in and connected | 200 concurrent |
| Heartbeats sent / accepted by the server | 6 600 / 6 600 (every ack `success: true`; 0 rejected; 0 errors in the API log) | error rate < 1 % |
| Heartbeat round trip (send → server ack) | p50 **46 ms**, p95 **77 ms**, max 3 466 ms | p95 < 500 ms |
| Sign-in (Argon2id + session issue), 220 in 20 s | p95 1 129 ms | — |
| WebSocket connect + auth | p95 42 ms | — |
| Persisted | 200 sessions, 6 600 presence events, 220 audit entries | — |

k6's own `heartbeat_errors` metric read 3 % in this run; every one of those entries was the script counting its own socket close as an error (an ack still in flight at the moment the virtual user hung up). The server rejected nothing: sent = acknowledged = stored events. The metric is corrected in `load/heartbeat.js` (`heartbeats_unacked_at_close` is now informational) for future runs.

| NFR | Result | Detail |
| --- | --- | --- |
| NFR-ACC-001 clock-in ≤ 5 s | **PASS** | The first acknowledgement is the session creation: p50 173 ms, worst of 220 connections 3 466 ms (during the 220-sign-in burst). The web client sends that first heartbeat immediately on connect and on the first activity. |
| NFR-ACC-002 clock-out ≤ 30 s after grace, = last heartbeat | **PASS** | `clock_out_at` equals the last heartbeat for 200/200 sessions; all closed by the reconciler with source `DISCONNECT`. Timing from the client's close instant: 12.8 s p95 / 13.3 s max after grace in the dedicated run below (the 15-minute run can only bound it from the last heartbeat: ≤ 47 s including up to 30 s of idle interval before the socket closed). |
| NFR-ACC-003 no double counting | **PASS** | 20 users on two devices: one session each, flagged `MULTI_DEVICE`, net time = wall clock (e.g. 1 800 s claimed by two devices, 882 s counted); 0 overlapping sessions; 0 sessions over the wall clock beyond one heartbeat interval. |
| NFR-ACC-004 deterministic totals | **PASS** | 200 person-days recomputed twice from the stored sessions: identical both times and equal to the stored `attendance_daily` row and the session sum. |

**Dedicated ACC-002 timing run** (20 users, 2 minutes, each virtual user logs the instant it closes its socket; `load/out/accuracy-acc002.txt`): 20/20 sessions closed with `clock_out_at` = last heartbeat, source `DISCONNECT`; closure **12.8 s p95, 13.3 s max after the 120 s grace window** (reconciler every 15 s) — within the 30 s target. 80/80 heartbeats accepted; clock-in p99 108 ms (NFR-ACC-001 again).

Observations (not failures): (1) a load client that reports a full 30 s of activity in its very first heartbeat is credited those 30 s before the clock-in instant — the real client reports 1 s there; the k6 script now does the same. (2) The daily close writes `PRESENT` with zero seconds for a day with no sessions when the organisation has no work schedule; with a schedule the day is `ABSENT` or a rest day. Worth a `REST_DAY` default when nothing is expected (follow-up).

## 4. Security pass (SRS §10.3)

| Control | Status | Evidence |
| --- | --- | --- |
| Security headers (API) | PASS | Helmet with CSP `default-src 'none'`, `frame-ancestors 'none'`, HSTS in production, `X-Content-Type-Options`, `Referrer-Policy`, CORP (`configure-app.ts`); `auth-hardening-e2e` "sets helmet security headers". |
| Security headers (web) | PASS | `next.config.mjs`: CSP (self + API + storage), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (camera, microphone, geolocation off), `poweredByHeader` off. Gap: `script-src 'unsafe-inline'` until nonce-based CSP (ADR 006). HSTS is set at the edge (TLS terminator). |
| CSRF | PASS | Bearer tokens in memory, never cookies, for every API call; the refresh cookie is HttpOnly, SameSite=Strict, path `/auth/refresh`, and `/auth/refresh` also requires the `X-HRVO-CSRF` header and an allow-listed Origin; WebSocket handshakes reject other origins and never read cookies. Tests: `auth-hardening-e2e` "CORS", "WebSocket handshakes", "refresh cookie", "cookie-based /auth/refresh requires the CSRF header". |
| Rate limits | PASS | Per-IP buckets: login 10/min, refresh 30/min, password reset 5/min, vault 20/min, share links 30/min, unsubscribe 20/min; heartbeat 10/min per user; account lockout after 5 failed logins. Tests: `auth-hardening-e2e` "Rate limits". In-memory store: a shared Redis store is required before running more than one API instance (ADR 005). |
| RBAC on every route | PASS | `docs/security/route-permissions.md` (generated by `scripts/route-permissions.mjs`): 151 routes, every one behind `JwtAuthGuard`+`PermissionsGuard` with a named permission, in the self-service allow-list, or a public route in the allow-list. The generator exits non-zero on any unlisted route. |
| RLS on every table | PASS | `docs/security/rls-coverage.md`: 50 tenant tables with RLS enabled **and forced** and an org policy; the app role has NOBYPASSRLS; `_prisma_migrations` is the only exception (no tenant data). Tests: every module's "tenant-isolated" test; `attendance-hardening-coverage` RLS tests. |
| Least privilege in the database | PASS | `hrvo_app` cannot UPDATE/DELETE audit logs, presence events, consents, access logs, approvals or task activity; `hrvo_retention` prunes raw events and notifications only (`rls-coverage.md` privilege column; `attendance-hardening-coverage`). |
| Secrets scan | PASS | gitleaks over the full history: one finding, a hard-coded **CI test** `JWT_SECRET` in an early commit of `.github/workflows/ci.yml`, since replaced by a per-run `openssl rand` value. Recorded in `.gitleaksignore` by fingerprint; a gitleaks step was added to CI so new findings fail the build. |
| Dependency audit | DOCUMENTED | `npm audit`: 7 advisories, all requiring **major** upgrades (`next` 15→16, `prisma` 6→7, `eslint-config-next`, `exceljs`, `tailwindcss` with no fix). Runtime exposure: `exceljs`→`uuid` (buffer bounds, moderate; we never pass a buffer to uuid) and `postcss` (build-time only). The rest are dev tooling. Decision needed from the product owner: schedule the Next 16 / Prisma 7 upgrades as their own slice. |
| Presigned URLs 5 min, no public buckets | PASS | Documents module (ADR 009): 5-minute presigned part URLs; bucket is private; non-TLS denial is a deployment policy (documented in ADR 009). |
| Encryption at rest and KMS | PASS / DEPLOYMENT | Envelope encryption per version (ADR 009/010). `LocalKeyProvider` is refused in production; the AWS KMS adapter is still to be written before go-live. |
| Pen test, IR runbook, break-glass IAM | NOT IN SCOPE | Organisational controls for launch (SRS §12, §13.4 P3). |

## 5. Fixes made during this pass

1. Reconciler cadence 60 s → 15 s so a dropped client is closed within AC-02's 30 s window.
2. `GET /attendance/me/today` returns `lastClosed`; the attendance page shows the outage notice with a link to the correction form (AC-04).
3. Contract expiry reminders to HR and the manager, in-app and by email, once per stage (AC-16); new notification type `CONTRACT_EXPIRING` with its own preference.
4. Audit chain verification (fixed earlier in the sprint, included here for completeness): ids crossing a digit boundary were sorted as text.
5. `.gitleaksignore` for the historic CI test secret; gitleaks step in CI; `scripts/route-permissions.mjs` and the RLS table added as generated security evidence.

## 6. Open items for the product owner

- Decide on the major dependency upgrades (Next 16, Prisma 7) — security advisories are low-exposure but will not go away otherwise.
- AWS KMS adapter and production mail provider before go-live (known since ADR 009/012).
- Nonce-based CSP for the web app.
- Shared Redis rate-limit store before horizontal scaling.
