# Traceability: Attendance (SRS 5.5, section 6)

The attendance engine, corrections, live board, exports and safeguards are covered by ADR 001–003, 018 and 019 (tests: attendance-*, agent-*, anti-spoofing, presence-challenge; Playwright 02–05, 19, 20). This file tracks the later fixes.

## Explicit logout (ADR 025)

| Requirement | Implementation | Tests |
| --- | --- | --- |
| FR-ATT-002 close on explicit logout, at the last valid heartbeat, source LOGOUT; password reset and administrative revocation included; a second valid login keeps the person clocked in; tab close keeps the grace window | `attendance.gateway.ts` `closeAttendanceOnRevocation` (on `hrvo_auth_events`), `attendance.service.ts` `onExplicitLogout` | attendance-logout-e2e: "POST /auth/logout closes the open session within 1 s…", "two logins (two devices)…", "two tabs of the same login…", "a tab that closes…still goes through the grace window", "a password reset…", "an administrative revocation…" |
