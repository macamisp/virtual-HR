# ADR 002: PostgreSQL Persistence with Row-Level Security, Multi-Device Interval Union Merging, and Reconciler Edge Cases

**Status:** Accepted  
**Date:** 13 October 2026  
**Context:** Requirements [`docs/SRS.md`](file:///run/media/macami/DataDrive/Hr%20virtual%20office/docs/SRS.md) Section 5.5 (`FR-ATT-007` through `FR-ATT-010`), Section 6.2, 6.3, and 6.6 Edge Cases.

## Context

Following the initial attendance state machine implementation (`FR-ATT-001..005`), the system requires production-grade persistence and edge-case handling:
1. **Durable Persistence & Server Restart Recovery (Section 6.6):** Sessions, segments, device sequences, nonces, and per-session secrets must survive server crashes or restarts. In-memory state alone is insufficient.
2. **PostgreSQL Row-Level Security (Mandatory Security Rule):** Every attendance table must have `org_id` and PostgreSQL RLS enabled to prevent tenant data leakage.
3. **Application Role Hardening & FORCE RLS:** The application must never connect as a superuser or table owner. A dedicated non-superuser role without `BYPASSRLS` must be used. `FORCE ROW LEVEL SECURITY` must be enabled across all tenant tables.
4. **Mandatory Tenant Context & Transactions:** Every repository query must run within a transaction that calls `SELECT set_config('app.org_id', $1, true)` before executing SQL. Queries without tenant context must be rejected.
5. **Multi-Device Concurrency & Anti-Double-Counting (`FR-ATT-010`, `NFR-ACC-003`):** When a user is concurrently active across multiple devices (e.g. laptop and tablet), wall-clock overlap must never be double-counted.
6. **Periodic Reconciler Idempotency & Cleanups (`Section 6.3`):** The 60-second periodic reconciler job must be strictly idempotent, and stale nonces (>5 min) and inactive device sequences must be pruned.
7. **Breaks & Paid/Unpaid Policy (`FR-ATT-007`):** Explicit break tracking with configurable daily paid break caps (e.g., 60 minutes).
8. **IANA Timezone Midnight Split (`FR-ATT-008`):** Split sessions crossing local midnight cleanly using audited IANA timezone logic (`date-fns-tz`), resilient against Daylight Saving Time (DST) shifts.

## Approved Dependencies & Justification

Per project rules ("Never add a new npm package without asking me first"), the following packages were approved:
1. **`pg` and `@types/pg` (`^8.23.1`):**
   - *Justification:* Standard PostgreSQL client driver for Node.js. Provides native connection pooling, prepared statements, and transactional session variable management (`set_config('app.org_id', ...)`) required for PostgreSQL Row-Level Security.
2. **`date-fns` (`^4.4.0`) and `date-fns-tz` (`^3.2.0`):**
   - *Justification:* Audited, tree-shakable IANA timezone handling library. Required by `FR-ATT-008` to compute local midnight in arbitrary IANA timezones (e.g., `Asia/Colombo`, `America/New_York`) and handle Daylight Saving Time (DST) spring-forward (23h) and fall-back (25h) days without calendar drift or off-by-one errors.

## Decision

1. **PostgreSQL Schema & Row-Level Security Hardening:**
   - Designed schema in `apps/api/src/attendance/schema.sql` with tables:
     - `organizations`, `users`
     - `attendance_sessions`, `attendance_segments`
     - `heartbeat_nonces`, `device_sequences`, `session_secrets`
   - Created dedicated application role `hrvo_app` with `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`.
   - Enabled `FORCE ROW LEVEL SECURITY` on all tenant tables (`organizations`, `users`, `attendance_sessions`, `attendance_segments`, `heartbeat_nonces`, `device_sequences`, `session_secrets`).
   - RLS policies enforce `org_id = NULLIF(current_setting('app.org_id', true), '')::uuid` for both `USING` and `WITH CHECK`. Missing context returns zero rows; foreign org inserts/updates are rejected.
   - `PostgresAttendanceRepository` connects as `hrvo_app` for all application queries. Table owner (`postgres`) is restricted to migrations and test wipe operations only.

2. **Mandatory Transactional RLS Context Enforcement:**
   - Implemented `queryWithRls(orgId, text, params)` in `PostgresAttendanceRepository`:
     - Validates that `orgId` is provided and non-empty; throws immediate error if tenant context is missing.
     - Wraps execution in `BEGIN ... COMMIT` (with `ROLLBACK` on error).
     - Calls `SELECT set_config('app.org_id', $1, true)` as the first statement in the transaction.

3. **Interval Union Merging Algorithm (`interval-merger.ts`):**
   - Implemented `computeIntervalUnionDurationSeconds(intervals)`:
     - Filters invalid intervals ($end < start$).
     - Sorts intervals chronologically.
     - Merges contiguous or overlapping intervals into disjoint spans.
     - Sums span lengths.
   - Automatically triggered whenever `MULTI_DEVICE` is present on a session, guaranteeing mathematical compliance with `NFR-ACC-003` (zero double-counting).

4. **Reconciler Worker Execution Order & Idempotency:**
   - Reconciler order:
     1. Expired nonce cleanup (>5 minutes).
     2. Midnight split check (`FR-ATT-008`, Row 15) must precede the 90s silence timeout check so cross-midnight active sessions split cleanly at `23:59:59.999` local time.
     3. Max length capping (`FR-ATT-009`, Row 16, $>14$ hours).
     4. Socket disconnect grace expiry (Row 12, $>120$s).
     5. Missing heartbeat timeout (Row 13, $>90$s silence).
   - All transition methods check explicit conditions before mutating, guaranteeing strict idempotency (subsequent runs produce 0 duplicate closed or split sessions).

5. **Pruning & Cleanup Jobs:**
   - `cleanupExpiredNonces`: Prunes `heartbeat_nonces` older than 5 minutes (300 seconds).
   - `cleanupStaleDeviceSequences`: Prunes `device_sequences` inactive past the stale retention window (e.g., 30 days).

6. **Edge Cases Tested and Handled (Section 6.6):**
   - **Laptop sleep / lid closed:** Heartbeats cease immediately; reconciler closes session at the last heartbeat timestamp; upon waking, a clean new session starts, leaving the sleep gap unpaid.
   - **10-minute network outage:** Disconnect grace expires at 120s; session closes with `source: DISCONNECT`; reconnection after 10m starts a new session.
   - **Forgotten logout overnight:** Night inactivity accrued 0 payable seconds; capped by max session length (14h) with `MAX_LENGTH` and `MIDNIGHT_SPLIT` flags.
   - **DST transition (America/New_York):** Spring-forward (23-hour day) and fall-back (25-hour day) handled cleanly via `date-fns-tz` without calendar drift.
   - **Server restart recovery:** Server instance crash simulated; new instance restored session and monotonic sequence directly from PostgreSQL; sequence replays rejected.

## Consequences

- Full compliance with `FR-ATT-007` through `FR-ATT-010`, Section 6.2, 6.3, and Section 6.6 edge cases.
- PostgreSQL RLS enforces zero data leakage between tenants with non-superuser defense-in-depth.
- All dependencies documented and justified.
- 100% of test suites pass with comprehensive coverage.
