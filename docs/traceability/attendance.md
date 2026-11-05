# Traceability: Attendance (SRS 5.5, section 6)

The attendance engine, corrections, live board, exports and safeguards are covered by ADR 001–003, 018 and 019 (tests: attendance-*, agent-*, anti-spoofing, presence-challenge; Playwright 02–05, 19, 20). This file tracks the later fixes.

## Explicit logout (ADR 025)

| Requirement | Implementation | Tests |
| --- | --- | --- |
| FR-ATT-002 close on explicit logout, at the last valid heartbeat, source LOGOUT; password reset and administrative revocation included; a second valid login keeps the person clocked in; tab close keeps the grace window | `attendance.gateway.ts` `closeAttendanceOnRevocation` (on `hrvo_auth_events`), `attendance.service.ts` `onExplicitLogout` | attendance-logout-e2e: "POST /auth/logout closes the open session within 1 s…", "two logins (two devices)…", "two tabs of the same login…", "a tab that closes…still goes through the grace window", "a password reset…", "an administrative revocation…" |

## Accuracy proofs (ADR 026, SRS 6.5)

| Requirement | Implementation | Tests |
| --- | --- | --- |
| NFR-ACC-001 clock-in within 5 s of first activity | heartbeat hook sends the first heartbeat on connect; server stamps | Playwright 23 "NFR-ACC-001: clock-in within 5 s of the first activity, 100 sign-ins" (prints every delta) |
| NFR-ACC-002 clock-out within 30 s of last activity (logout, tab close, network loss) | ADR 025 close on revocation; grace window and reconciler; `ATTENDANCE_RECONCILE_INLINE_MS` when jobs are off | Playwright 23 "NFR-ACC-002: clock-out within 30 s…"; attendance-logout-e2e (latency); lock-order (ADR 038): session saves and DISCONNECT inputs are never lost to a deadlock or to shutdown (scenarios 1, 2, 5, 7) |
| NFR-ACC-003 no double counting across two devices | `recomputeNetSeconds` interval union for MULTI_DEVICE sessions | Playwright 23 "NFR-ACC-003: two devices at once never count more than the wall clock"; attendance-postgres-edge-cases "FR-ATT-010: Merges overlapping multi-device sessions…" |
| NFR-ACC-004 nightly replay recomputes daily totals and alerts on any difference | `computeDailySummary`, `replayDay`, `ScheduledWorkService.attendanceReplay`, job `attendance-replay` (02:30 UTC), notification `ATTENDANCE_REPLAY_MISMATCH` | attendance-replay (4): "recomputing a day…matches…exactly", "a stored total that drifted…is reported field by field…", "a person with sessions but no daily row…", "the nightly job…alerts HR once and writes an audit entry…"; lock-order (ADR 038) scenario 5: concurrent writers leave the audit hash chain intact |

## Leave and public holidays (ADR 027)

| Requirement | Implementation | Tests |
| --- | --- | --- |
| FR-ORG-010 leave requests (annual, sick, unpaid, other), manager approval, attendance expectations updated | `leave/leave.service.ts`, `leave.controller.ts`, `leave_requests`; screens `/attendance/leave`, `/attendance/leave/review` | leave-e2e: "an employee requests leave…", "only the manager (or HR) decides…", "approved leave: expected hours are zero…", "a rejected request…"; Playwright 24 |
| FR-ORG-011 public holiday calendar, Sri Lanka default, HR-editable, excluded from expected time | `public_holidays`, `sri-lanka-holidays.ts`, `/holidays` routes; screen `/admin/holidays` | leave-e2e: "HR keeps the public holiday calendar…", "a holiday is excluded from expected time…"; Playwright 24 |
| FR-ATT-022 leave and holidays suppress absence alerts; FR-ATT-016 "on leave" on the live board | `attendance/leave-providers.ts` wired in `attendance.module.ts` | leave-e2e: "leave today shows as \"On leave\" on the live board…", reminder assertions; Playwright 24 |

## A call is a meeting segment (ADR 048)

| Requirement | Implementation | Tests |
| --- | --- | --- |
| FR-ATT-006 / SRS 6.2 rows 6–7 from the heartbeat: `inCall` while ACTIVE, IDLE or PAUSED opens an `IN_MEETING` segment (no input needed, never idle); a heartbeat without `inCall` closes it, credits `meeting_seconds` and returns to ACTIVE; a hook-opened meeting (with a meeting id) is untouched; a session closed mid-call (logout, timeout, midnight, maximum length) keeps the meeting time | `attendance-state-machine.ts` `handleHeartbeat` (before the activity rows), `closeLastSegment` (credit) | attendance-state-machine "ADR 048: a call reported by the heartbeat" (5 cases), agent-companion "a call in the browser keeps the session in the call…", attendance-replay; Playwright 36 |

## Verified meeting time (ADR 049 §1)

| Requirement | Implementation | Tests |
| --- | --- | --- |
| FR-WT-001, FR-WT-002 a call counts only with someone else in it (room: another avatar; proximity: group of 2+; meeting: LiveKit lists this person and another) | `media/call-evidence.service.ts` `ServerCallEvidence`, wired by `CallEvidenceRegistrar`; `AttendanceService.ingestHeartbeat` processes unverified calls as ordinary heartbeats | call-evidence (10): alone in a room, two in a room, proximity, meetings, forged ids, 30 s cache, 90 s grace then fail closed, forged `callKind` ignored; meeting-time-e2e "the real server check refuses a call nobody else is in" |
| FR-WT-003 no double counting (input during a call, a second device, two tabs) | `attendance-state-machine.ts` (counters skipped while `IN_MEETING`; `call_device_id`/`call_confirmed_at`); `call-share.ts` + `use-heartbeat.ts` BroadcastChannel | attendance-state-machine "ADR 049" (4); call-share (4) |
| FR-WT-004 the call ends on leaving, on failed evidence, logout, timeout | state machine (unchanged ADR 048 closing) + evidence | attendance-state-machine ADR 048 + 049 suites |
| FR-WT-005 meeting intervals for the person and, without titles, the manager in scope | `attendance/meeting-time.service.ts`, `GET /attendance/me/meetings`, `GET /attendance/users/:id/meetings`; My attendance "Meetings" card | meeting-time-e2e: own list with titles, manager without titles, other team 404, peer 403, RLS |
| FR-WT-006 meeting time in timesheets, reports, exports, live board | `timesheet_days`/`timesheets.meeting_minutes`, report and export columns (appended), `todayMeetingSeconds` | meeting-time-e2e (timesheet, report, CSV, live board); timesheets-e2e export column order |
