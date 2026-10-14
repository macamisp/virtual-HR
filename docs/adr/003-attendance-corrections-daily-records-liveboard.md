# ADR 003: Attendance Corrections, Daily Aggregation, Schedule Compliance, Live Board, and Transparency

**Status:** Accepted  
**Date:** 14 October 2026  
**Context:** [`docs/SRS.md`](file:///run/media/macami/DataDrive/Hr%20virtual%20office/docs/SRS.md) Section 5.5 (`FR-ATT-013` through `FR-ATT-016`, `FR-ATT-019`, `FR-ATT-020`), Section 5.6 (`FR-TS-001`), Section 6.3 (Daily close job), Section 7.4 (`attendance_daily`, `attendance_corrections`, `work_schedules`), and [`AGENTS.md`](file:///run/media/macami/DataDrive/Hr%20virtual%20office/AGENTS.md).

---

## 1. Context

Following the core state machine (`FR-ATT-001..005`) and reconciler/persistence (`FR-ATT-007..010`), the attendance system requires advanced operational, supervisory, compliance, and reporting capabilities:
1. **Attendance Corrections (`FR-ATT-013`):** Workflow for employees to request adjustments for missed clock-ins/outs with reason and optional evidence document ID; manager/HR review; immutable preservation of original sessions with status `ADJUSTED`; strict prevention of self-approval.
2. **Schedule Compliance Engine (`FR-ATT-014`):** Comparison of actual daily attendance against shift schedules (`work_schedules`), accounting for grace periods, flexible hours, and suppressing absence/late flags on approved leave or declared holidays.
3. **Daily Attendance Materialization & Draft Timesheets (`FR-ATT-015`, Section 6.3, `FR-TS-001`):** Idempotent daily close job executed shortly after local midnight in the organization's timezone to materialize day status (`PRESENT`, `LATE`, `EARLY_LEAVE`, `HALF_DAY`, `ABSENT`, `LEAVE`, `HOLIDAY`) into `attendance_daily` and automatically generate draft timesheets (`draft_timesheets`).
4. **Live Attendance Board (`FR-ATT-016`):** Real-time aggregation of user presence states (`ACTIVE`, `IDLE`, `ON_BREAK`, `IN_MEETING`, `ON_LEAVE`, `OFFLINE`) scoped by role permissions (Team Leads view own team; HR/Admin view all).
5. **Audited Data Exports (`FR-ATT-019`):** Secure CSV and XLSX exports of attendance records with mandatory audit trail logging.
6. **Worker Transparency & Consent (`FR-ATT-020`, `FR-AUD-004`):** Self-service transparency endpoint providing employees with their raw presence events and plain-language policy disclosures, coupled with versioned consent recording.
7. **Security & Cryptographic Audit Trails:** Every new table must have Row-Level Security enforced for non-superuser `hrvo_app`, and audit logs must form an immutable, tamper-evident SHA-256 hash chain.

---

## 2. Approved Dependencies & Justification

Per project rules ("Never add a new npm package without asking me first"):
- **`exceljs` (`^4.4.0`):**
  - *Approval:* Explicitly approved by user on 2026-10-14.
  - *Justification:* Pure TypeScript/JavaScript workbook creation library supporting streamed and in-memory XLSX generation without requiring external binary runtimes or system libraries. Required for compliance with `FR-ATT-019` (XLSX export).

---

## 3. Decisions & Architecture

### 3.1 Attendance Corrections (`FR-ATT-013`)
- **Correction Request Lifecycle:**
  - An employee requests a correction for a given work date or target session (`PENDING`).
  - Allowed reviewers: The employee's assigned direct manager (`manager_id`), or any user with role `HR` or `ADMIN`.
  - **Self-Approval Prohibition:** A user cannot approve their own correction under any circumstances (enforced in `reviewCorrection`).
  - Upon approval (`APPROVED`), the original session status is transitioned to `ADJUSTED` (never deleted or overwritten), and a new adjusted session is created with `clockInSource: 'MANUAL_CORRECTION'`.
  - Both request and review actions emit entries into `audit_logs`.

### 3.2 Schedule Compliance Engine (`FR-ATT-014`)
- **Shift Calculation in Org Timezone:**
  - Shift start and end times (e.g. `09:00` - `18:00`) are resolved against the work date in the organization's timezone using `date-fns-tz`.
  - Grace periods (`graceMinutes`) are applied to shift start. Clock-in past start + grace produces `LATE_ARRIVAL` with the exact delay minutes.
  - Clock-out prior to shift end produces `EARLY_LEAVE`.
  - Net seconds exceeding expected shift hours produce `OVERTIME`.
- **Leave and Holiday Provider Interfaces:**
  - Lookups are abstracted behind `ILeaveProvider` and `IHolidayProvider` interfaces.
  - If a user is on approved leave (`HALF_DAY_LEAVE`, `FULL_DAY_LEAVE`) or the date is a declared holiday, late arrival and absence exceptions are suppressed.

### 3.3 Daily Attendance Record & Idempotent Close Job (`FR-ATT-015`, Section 6.3, `FR-TS-001`)
- **Daily Close Worker:**
  - Scheduled to run at `00:05` local time after midnight in each organization's configured IANA timezone.
  - Iterates over all active users in the tenant and computes aggregated counters (`first_in`, `last_out`, `active_seconds`, `idle_seconds`, `break_seconds`, `meeting_seconds`, `net_seconds`, `expected_seconds`, `late_arrival_minutes`, `early_leave_minutes`, `overtime_minutes`).
  - Derives `day_status`: `HOLIDAY`, `LEAVE`, `ABSENT` (0 net seconds on working day), `LATE`, `EARLY_LEAVE`, `HALF_DAY`, or `PRESENT`.
  - Auto-generates a `draft_timesheets` row per user (`FR-TS-001`).
  - **Idempotency:** Implemented via PostgreSQL `ON CONFLICT (org_id, user_id, work_date) DO UPDATE` to ensure reruns produce deterministic, identical results without duplicates.

### 3.4 Role-Scoped Live Board (`FR-ATT-016`)
- Aggregates daily sessions to derive the current operational presence state:
  - If user is on approved leave -> `ON_LEAVE`.
  - If no open session exists -> `OFFLINE`.
  - If open session exists -> reflects session's `currentState` (`ACTIVE`, `IDLE`, `ON_BREAK`, `IN_MEETING`).
- **Authorization Scoping:**
  - `EMPLOYEE`: Access denied or restricted to self.
  - `TEAM_LEAD`: Restricted to users sharing the lead's `team_id`.
  - `MANAGER`: Restricted to users whose `manager_id` matches the caller.
  - `HR` / `ADMIN`: Unrestricted org-wide visibility.

### 3.5 Audited Exports (`FR-ATT-019`)
- Supports CSV (RFC 4180 format) and XLSX (`exceljs`) export formats.
- Parameters allow filtering by `startDate`, `endDate`, `teamId`, or `userId`.
- Every export call verifies caller permissions (Team Lead scoped, HR/Admin org-wide) and writes an audit log entry (`ATTENDANCE_EXPORT_CSV` / `ATTENDANCE_EXPORT_XLSX`).

### 3.6 Transparency & Privacy Notice Consent (`FR-ATT-020`, `FR-AUD-004`)
- Self-service endpoint `GET /attendance/me/events` returns raw presence telemetry records for the authenticated employee.
- Returns plain-language transparency notice explicitly confirming:
  - We collect minimal presence counters (heartbeat interval, active/idle time, meeting/break time).
  - **Zero invasive surveillance:** No screenshots, no webcam capture, no browser history, no keystroke logging.
  - Retention duration is documented (90 days).
- Consent endpoint records `monitoring_consents` with version identifier, client IP, user agent, and authoritative server clock timestamp.

### 3.7 Database Schema & RLS Hardening
- Extended PostgreSQL schema in `apps/api/src/attendance/schema.sql`:
  - `teams`, `work_schedules`, `attendance_corrections`, `attendance_daily`, `draft_timesheets`, `presence_events`, `audit_logs`, `monitoring_consents`.
- `FORCE ROW LEVEL SECURITY` enabled on every table.
- Policies enforce `org_id = NULLIF(current_setting('app.org_id', true), '')::uuid` on `USING` and `WITH CHECK`.
- Application queries execute exclusively through `hrvo_app` within transactions with tenant session variable set.
- **Tamper-Evident Audit Hash Chain:**
  - Each `audit_logs` record includes a cryptographic SHA-256 hash chaining to the preceding log entry for the organization (`hash = SHA256(prev_hash + canonical_json(entry))`).
  - Key ordering in JSON is strictly normalized to guarantee validation across database round-trips.

---

## 4. Verification & Testing

- Full TDD test suite in `apps/api/test/attendance-advanced-features.test.ts` with 20 distinct integration test scenarios.
- 100% passing tests (73/73 tests green across all 16 test suites).
- Test line coverage: **97.11%** (Repository: 94.97%, Service: 91.25%, State Machine: 100%, Interval Merger: 100%, Types: 100%).
- Real PostgreSQL 16 instance with RLS policy and non-superuser role tests verified.
