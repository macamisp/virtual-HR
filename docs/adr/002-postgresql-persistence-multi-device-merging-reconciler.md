# ADR 002: PostgreSQL Persistence with Row-Level Security, Multi-Device Interval Union Merging, and Reconciler Edge Cases

**Status:** Accepted  
**Date:** 13 October 2026  
**Context:** Requirements [`docs/SRS.md`](file:///run/media/macami/DataDrive/Hr%20virtual%20office/docs/SRS.md) Section 5.5 (`FR-ATT-007` through `FR-ATT-010`), Section 6.2, 6.3, and 6.6 Edge Cases.

## Context

Following the initial attendance state machine implementation (`FR-ATT-001..005`), the system requires production-grade persistence and edge-case handling:
1. **Durable Persistence & Server Restart Recovery (Section 6.6):** Sessions, segments, device sequences, nonces, and per-session secrets must survive server crashes or restarts. In-memory state alone is insufficient.
2. **PostgreSQL Row-Level Security (Mandatory Security Rule):** Every attendance table must have `org_id` and PostgreSQL RLS enabled to prevent tenant data leakage.
3. **Multi-Device Concurrency & Anti-Double-Counting (`FR-ATT-010`, `NFR-ACC-003`):** When a user is concurrently active across multiple devices (e.g. laptop and tablet), wall-clock overlap must never be double-counted.
4. **Periodic Reconciler Idempotency (`Section 6.3`):** The 60-second periodic reconciler job must be strictly idempotent (running it multiple times at the same timestamp produces zero duplicate transitions or data anomalies).
5. **Breaks & Paid/Unpaid Policy (`FR-ATT-007`):** Explicit break tracking with configurable daily paid break caps (e.g., 60 minutes).
6. **IANA Timezone Midnight Split (`FR-ATT-008`):** Split sessions crossing local midnight cleanly using audited IANA timezone logic (`date-fns-tz`), resilient against Daylight Saving Time (DST) shifts.

## Decision

1. **PostgreSQL Schema & Row-Level Security:**
   - Designed schema in `apps/api/src/attendance/schema.sql` with tables:
     - `organizations`, `users`
     - `attendance_sessions`, `attendance_segments`
     - `heartbeat_nonces`, `device_sequences`, `session_secrets`
   - Every business table enforces `org_id` foreign keys and PostgreSQL Row-Level Security (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY; CREATE POLICY ... USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)`).
   - `PostgresAttendanceRepository` uses connection pooling (`pg`) and sets RLS context per transaction via `SELECT set_config('app.org_id', $1, true)`.

2. **Interval Union Merging Algorithm (`interval-merger.ts`):**
   - Implemented `computeIntervalUnionDurationSeconds(intervals)`:
     - Filters invalid intervals ($end < start$).
     - Sorts intervals chronologically.
     - Merges contiguous or overlapping intervals into disjoint spans.
     - Sums span lengths.
   - Automatically triggered whenever `MULTI_DEVICE` is present on a session, guaranteeing mathematical compliance with `NFR-ACC-003` (zero double-counting).

3. **Reconciler Worker Execution Order & Idempotency:**
   - Reconciler order:
     1. Midnight split check (`FR-ATT-008`, Row 15) must precede the 90s silence timeout check so cross-midnight active sessions split cleanly at `23:59:59.999` local time.
     2. Max length capping (`FR-ATT-009`, Row 16, $>14$ hours).
     3. Socket disconnect grace expiry (Row 12, $>120$s).
     4. Missing heartbeat timeout (Row 13, $>90$s silence).
   - All transition methods check explicit conditions before mutating, guaranteeing strict idempotency (subsequent runs produce 0 duplicate closed or split sessions).

4. **Edge Cases Tested and Handled (Section 6.6):**
   - **Laptop sleep / lid closed:** Heartbeats cease immediately; reconciler closes session at the last heartbeat timestamp; upon waking, a clean new session starts, leaving the sleep gap unpaid.
   - **10-minute network outage:** Disconnect grace expires at 120s; session closes with `source: DISCONNECT`; reconnection after 10m starts a new session.
   - **Forgotten logout overnight:** Night inactivity accrued 0 payable seconds; capped by max session length (14h) with `MAX_LENGTH` and `MIDNIGHT_SPLIT` flags.
   - **DST transition (America/New_York):** Spring-forward (23-hour day) and fall-back (25-hour day) handled cleanly via `date-fns-tz` without calendar drift.
   - **Server restart recovery:** Server instance crash simulated; new instance restored session and monotonic sequence directly from PostgreSQL; sequence replays rejected.

## Consequences

- Full compliance with `FR-ATT-007` through `FR-ATT-010`, Section 6.2, 6.3, and Section 6.6 edge cases.
- PostgreSQL RLS enforces zero data leakage between tenants.
- 100% of attendance state machine, interval union, and validator tests pass with comprehensive coverage.
