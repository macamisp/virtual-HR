# Traceability: Attendance (SRS 5.5, section 6)

The attendance engine, corrections, live board, exports and safeguards are covered by ADR 001–003, 018 and 019 (tests: attendance-*, agent-*, anti-spoofing, presence-challenge; Playwright 02–05, 19, 20). This file tracks the later fixes.

## Explicit logout (ADR 025)

| Requirement | Implementation | Tests |
| --- | --- | --- |
| FR-ATT-002 close on explicit logout, at the last valid heartbeat, source LOGOUT; password reset and administrative revocation included; a second valid login keeps the person clocked in; tab close keeps the grace window | `attendance.gateway.ts` `closeAttendanceOnRevocation` (on `hrvo_auth_events`), `attendance.service.ts` `onExplicitLogout` | attendance-logout-e2e: "POST /auth/logout closes the open session within 1 s…", "two logins (two devices)…", "two tabs of the same login…", "a tab that closes…still goes through the grace window", "a password reset…", "an administrative revocation…" |

## Accuracy proofs (ADR 026, SRS 6.5)

| Requirement | Implementation | Tests |
| --- | --- | --- |
| NFR-ACC-001 clock-in within 5 s of first activity | heartbeat hook sends the first heartbeat on connect; server stamps | Playwright 23 "NFR-ACC-001: clock-in within 5 s of the first activity, 20 sign-ins" (prints every delta) |
| NFR-ACC-002 clock-out within 30 s of last activity (logout, tab close, network loss) | ADR 025 close on revocation; grace window and reconciler; `ATTENDANCE_RECONCILE_INLINE_MS` when jobs are off | Playwright 23 "NFR-ACC-002: clock-out within 30 s…"; attendance-logout-e2e (latency) |
| NFR-ACC-003 no double counting across two devices | `recomputeNetSeconds` interval union for MULTI_DEVICE sessions | Playwright 23 "NFR-ACC-003: two devices at once never count more than the wall clock"; attendance-postgres-edge-cases "FR-ATT-010: Merges overlapping multi-device sessions…" |
| NFR-ACC-004 nightly replay recomputes daily totals and alerts on any difference | `computeDailySummary`, `replayDay`, `ScheduledWorkService.attendanceReplay`, job `attendance-replay` (02:30 UTC), notification `ATTENDANCE_REPLAY_MISMATCH` | attendance-replay (4): "recomputing a day…matches…exactly", "a stored total that drifted…is reported field by field…", "a person with sessions but no daily row…", "the nightly job…alerts HR once and writes an audit entry…" |
