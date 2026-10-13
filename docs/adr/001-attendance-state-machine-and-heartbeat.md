# ADR 001: Attendance State Machine & Cryptographic Heartbeat Ingestion

**Status:** Accepted  
**Date:** 13 October 2026  
**Context:** Requirements [`docs/SRS.md`](file:///run/media/macami/DataDrive/Hr%20virtual%20office/docs/SRS.md) Section 5.5 (`FR-ATT-001` through `FR-ATT-005`, `FR-ATT-017`) and Section 6.

## Context

The core capability of the HRVO platform is automatic, fair, and tamper-resistant detection of work in/out times without manual employee punching. 
The system must guarantee:
1. **Server-authoritative time:** Client timestamps are untrusted and ignored; all state transitions derive exclusively from the server NTP clock in UTC.
2. **Automatic clock-in & clock-out:** First active heartbeat triggers clock-in; logout, disconnects beyond grace (120s), or silence beyond timeout (90s) trigger clock-out.
3. **Idle time segregation:** Idle time is tracked separately from active time and excluded from net payable hours unless approved by a manager.
4. **Anti-spoofing and replay protection:** Heartbeats must be authenticated via HMAC-SHA256, deduplicated via single-use nonces, and ordered via monotonic sequence numbers.
5. **Privacy guardrails:** Heartbeats transmit telemetry counters only (active/idle seconds, focus, in-call status); no keystroke content, URLs, or screenshots are collected.

## Decision

1. **State Machine (`AttendanceStateMachine`):**
   - Implemented as a pure, deterministic state machine with 7 explicit states: `OFFLINE`, `ACTIVE`, `IDLE`, `PAUSED`, `IN_MEETING`, `ON_BREAK`, and `DISCONNECTED`.
   - Every row of the 16-row transition matrix in SRS Section 6.2 is formally modeled and unit tested.
   - Idle thresholds: 5 minutes of inactivity transitions `ACTIVE` $\to$ `IDLE`; 15 minutes transitions `IDLE` $\to$ `PAUSED`. Resuming input restores `ACTIVE` and flags `LONG_IDLE`.
   - Meeting credit: Joining meetings transitions to `IN_MEETING` and accumulates into `meetingSeconds` and `netSeconds`.
   - Grace period: Socket disconnections transition to `DISCONNECTED` with a 120s grace timer. Reconnection within 120s restores the prior state seamlessly.
   - Org-timezone midnight: Daily boundaries are computed analytically in the organisation's timezone (default `Asia/Colombo`), closing the prior day at `23:59:59.999` and opening a new day session at `00:00:00.000` with `MIDNIGHT_SPLIT` flag.
   - Max length capping: Sessions open $>14$ hours are closed at the last valid heartbeat with `MAX_LENGTH` flag.

2. **Heartbeat Cryptographic Validation (`HeartbeatValidator`):**
   - Every heartbeat payload is authenticated using HMAC-SHA256 over a canonical representation with constant-time equality check (`timingSafeEqual`).
   - Replay protection: Nonces are cached with a 5-minute sliding TTL. Duplicate nonces immediately trigger security rejection.
   - Monotonic sequence numbers: Monotonically increasing sequence counters per device prevent out-of-order execution or replayed historical telemetry.
   - Content filter: Rejects any payload containing forbidden surveillance fields (`keystrokes`, `screenshots`, `urls`).

3. **Reconciliation Engine (`AttendanceService.runReconciliation`):**
   - Runs every 60 seconds to inspect active sessions for grace expiration, 90s silence timeout, midnight boundary transitions, and $>14$ hour duration limits.

## Consequences

- Full compliance with IEEE 29148 requirements `FR-ATT-001` through `FR-ATT-005` and accuracy specifications in `NFR-ACC-001..005`.
- Deterministic and testable behavior: All 20 transition rules verified with TDD before implementation.
- Zero extra dependencies required: Leverages Node 22 native crypto and Intl APIs.
