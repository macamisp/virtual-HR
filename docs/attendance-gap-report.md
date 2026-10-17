# Attendance gap fixes — 17 October 2026

Starting revision: `8871b30`. That revision already contained the initial logout, accuracy,
and leave implementations described in ADRs 025–027. This pass checked those claims against
new regression tests and corrected the remaining gaps. No packages were added.

## Before and after

| Requirement | Before this pass | After |
| --- | --- | --- |
| FR-ATT-002: explicit logout | Attendance closure depended on a Postgres notification. Suppressing it left the session OPEN/ACTIVE beyond 900 ms. A cached secret could then accept another heartbeat after revocation. | Logout awaits closure after committing revocation. Every heartbeat checks the live login and its authenticated session ID. Closed time equals the last valid server heartbeat; source LOGOUT. |
| FR-ATT-002: password reset/admin revoke | Reset depended on the same notification. The SRS-listed administrative session DELETE endpoint was absent. | Reset closes attendance across two live logins even without notifications. DELETE /auth/sessions/:id requires users.manage, validates its UUID, enforces tenant RLS, audits the action and awaits closure. Role changes also await closure. |
| FR-ATT-002: multiple clients/tab close | A second valid, recently heartbeating login preserved attendance; revoked shared-login tabs stopped. Ordinary disconnect used grace. | Those cases remain tested. Logout of the last valid login closes immediately; tab close keeps the grace window. The meaning of the requested shared-session exception remains pending owner clarification below. |
| NFR-ACC-001 | Only 20 clock-in samples; no lower bound protected against a stale earlier timestamp. | Browser proof measures 100 sign-ins, prints every delay and p50/p99/max, rejects negative timestamps, and enforces at least 99/100 within 5 s. |
| NFR-ACC-002 | Browser assertions allowed 31 s timestamp error and 2 s logout detection; some API closure checks allowed 3 s. | Absolute clock-out timestamp error is limited to 30 s. Logout, reset and administrative revocation enforce 1 s, including API latency. Browser logout/tab-close/network-loss print timestamp error and detection delay separately. |
| NFR-ACC-003 | An upper-bound-only assertion would also pass lost/uncounted time. | Two real browser contexts must share one open attendance session; counted net seconds must equal the union of stored active/meeting segments exactly. |
| NFR-ACC-004 | Replay trusted materialised session counters. Adding 7 s to both a session and its daily total produced no mismatch. | Accepted raw inputs and policy snapshots replay through the state machine. Session, segments and input commit atomically under RLS. Matching aggregate corruption is detected; midnight/grace, missing history, missing daily rows, rollback, RLS, notification and audit paths are covered. |
| FR-ORG-010 / FR-ATT-016 | Four leave types, manager approval and On leave UI already existed, but another process could cache obsolete answers for 10 s. | Direct tenant-scoped reads make approval/cancellation immediately visible across processes. API and browser tests exercise approval and On leave. |
| FR-ORG-011 | Existing organisations were seeded with the Sri Lanka calendar; new ones started empty. Another process could cache old HR edits for 10 s. | New organisations receive the existing reviewed Sri Lanka 2026 calendar automatically. HR can add, rename, remove and reload dates; all processes read committed edits immediately. |
| FR-ATT-022 | Dynamic provider checks suppressed absence/late flags, but persisted daily expectations could remain unchanged after an approval or calendar edit. | Regression coverage includes persisted daily records, zero expected hours on leave/holidays, restoring hours after cancellation/removal, suppressed reminders, and no late flag even when an actual session starts late. |
| CI evidence | Measurements scrolled past in CI output and were not retained as their own artifact. | Existing API coverage and Playwright CI steps preserve both output logs as attendance-accuracy-measurements for 14 days, including failed runs. No remote CI result is claimed for this working session. |

## Validation and measured results

- Full API run: **710/710 passed**, zero failures or skips.
- Browser accuracy and leave workflow run: **6/6 passed**, zero failures or skips.
- Final replay/desktop-agent regression run: **28/28 passed**, including the added mixed offline-counter case.
- API/shared typecheck, web typecheck, API/shared lint and web lint: passed.
- The additive holiday migration applied successfully to separate local API and browser test databases.
- Browser NFR-ACC-001: **100/100** clock-ins within 5 s; median **694 ms**, p99 **2,447 ms**, maximum **2,858 ms**. The clock-out chaos proof also passed.

| API scenario | Measured request/event to closed attendance |
| --- | ---: |
| POST /auth/logout | 136 ms |
| Logout with NOTIFY suppressed | 60.8 ms |
| Password reset, two live logins, NOTIFY suppressed | 189.3 ms |
| Administrative role revocation | 72 ms |
| Admin DELETE session, NOTIFY suppressed | 51.2 ms |

| Browser clock-out case | Timestamp error versus last activity | Detection after event | Source |
| --- | ---: | ---: | --- |
| Logout | 4.8 s | 0.3 s | LOGOUT |
| Tab close | 4.7 s | 33.1 s | DISCONNECT |
| Network loss | 4.9 s | 68.5 s | DISCONNECT |

The two-device run observed **62 s** of wall-clock span and an exact **62 s** segment union.
Recorded net time was **62 s**, giving **0 s** double counting. Raw counters across both devices
summed to 122 s; they are not used as payable net time.

Every closure asserts source LOGOUT and the last valid server heartbeat timestamp. The reset
also proves both old logins' heartbeats are refused. Raw replay reproduced 120 net seconds
exactly; changing both aggregates to 127 seconds exposed the seven-second difference. The
nightly-job test verified the HR notification, audit entry and duplicate-alert suppression.
The mixed offline replay reproduced 12 active and 48 idle seconds exactly.

The 30-second accuracy target concerns the recorded clock-out timestamp. Browser tab close
and network loss still wait for the configured grace/timeout before detection. Production's
120-second disconnect grace remains unchanged; browser tests use the SRS-allowed 30-second
minimum and a 5-second inline reconciler.

Raw history cannot be reconstructed retroactively for old sessions which never recorded the
required actions. The replay reports missing input history and alerts HR instead of treating
session totals as independent proof. The built-in holiday dataset is 2026; HR maintains other
years until reviewed calendars are supplied.

## Shared-session clarification

Ordinary logout currently revokes the auth-session family, so a second tab using that same
login cannot legitimately keep sending heartbeats. A separate valid login can preserve the
same merged attendance session while it continues heartbeating. The owner has been asked
whether the requested exception means changing ordinary logout to end just the requesting
tab's attendance connection, or retaining shared-login revocation. No change to that auth
contract has been assumed while the answer is pending.

## Demo

With local Compose PostgreSQL/Redis configured through PG* and the additive migration applied:

1. Run `npm run test:attendance` for the API regressions and printed logout/replay measurements.
2. Run `npm run e2e:attendance` for 100 real sign-ins, logout/tab-close/network-loss, two devices,
   manager leave approval, On leave, and HR calendar editing.
3. In the UI, request sick leave under Attendance → Leave. Approve it as the worker's manager
   under Leave requests. Sign the worker out and check On leave on the live board.
4. Under Admin → Public holidays, add a company closure date. Expected hours become zero;
   removing the date restores scheduled expectations. Ordinary workers cannot edit this calendar.
5. The replay regression injects seven seconds of matching aggregate drift and verifies that
   the nightly job reports differences through HR notifications and the audit log.

Decisions: ADR 028 (revocation delivery), ADR 029 (raw replay), ADR 030 (leave/calendar freshness).


Implementation commits:

- `1d0b590`: await attendance closure after auth revocation (FR-ATT-002).
- `a0e71ae`: reject revoked heartbeats and add guarded admin session revocation (FR-ATT-002).
- `facebe8`: default calendars and fresh provider reads (FR-ORG-010, FR-ORG-011, FR-ATT-022).
- `92e2f18`: refresh saved daily expectations after leave/calendar changes (FR-ATT-022).

- `2e910cd`: raw-input replay, strict browser accuracy proofs and CI measurement artifacts (NFR-ACC-001..004).
