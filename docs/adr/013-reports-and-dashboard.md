# ADR 013: Manager Dashboard and Reports

**Status:** Accepted
**Date:** 16 October 2026
**Requirements:** SRS 5.10 FR-REP-001 (dashboard), 002 (attendance), 003 (hours and cost), 004 (tasks and workload), 005 (compliance, as agreed), 006 (CSV/XLSX/PDF), 008 (role and team scope).

## 1. Decision agreed with the product owner

| Topic | Decision |
| --- | --- |
| Compliance | **Required categories + defer onboarding.** HR configures which document categories each role must have on file; the report shows missing and expired documents per person. Onboarding does not exist in this release and is shown as "not available" rather than guessed. |

## 2. Scope (FR-REP-008)

- Two permissions: `reports.team` (managers, team leads) and `reports.all` (HR, HR manager, admin, auditor, super admin). Every `/reports/*` route needs one of them; the data is then filtered inside the query, not by the route.
- **Team scope** = the viewer, their direct reports (`manager_id`) and everyone in their own team. Unlike timesheet approval, the viewer is included: a lead's dashboard counts the lead.
- `teamId` and `userId` filters only narrow within the scope. Asking for someone outside it returns an empty report, never a 403, so the response does not confirm who exists.
- Exports use exactly the same query, so a file never contains more than the screen.

## 3. Dashboard (FR-REP-001)

- "Today" is the organisation's calendar day. Attendance counts come from today's sessions: working (open, not on a break), on break (open, state `ON_BREAK`/`PAUSED`), finished (only closed sessions), not yet in, and on leave or off (today's `attendance_daily` rows with LEAVE/HOLIDAY/REST_DAY, which exist once the daily close has run).
- **Late arrivals** are computed live, because `attendance_daily` is only written at the daily close. The schedule precedence is the same as the daily close (`findWorkScheduleForUser`: person, then team, then organisation; effective dates are not considered there either), with the schedule's grace minutes, and flexible schedules are never late.
- Pending approvals: SUBMITTED timesheets and PENDING corrections of people in scope, with the oldest submission.
- Overdue tasks: open, not deleted, due before today, assignee in scope (first 20 plus a total).
- Expiring within 30 days: documents (by linked person, else owner) and contracts (within the larger of 30 days and the contract's own notice period). Titles of CONFIDENTIAL and RESTRICTED documents are replaced by "(confidential)" (ADR 010).

## 4. Reports

- **Attendance (FR-REP-002):** from `attendance_daily`, grouped by person, team, day, ISO week (Monday) or month; days present (PRESENT, LATE, EARLY_LEAVE, HALF_DAY), late days and minutes, early leaves, absent, on leave, net and expected hours, overtime. A totals row covers the whole scope. At most 366 days per request.
- **Hours and cost (FR-REP-003):** hours from finished time entries in the range (logged, billable, and those on approved timesheets). **Cost comes only from the payable stored at approval**, for timesheets whose period overlaps the range, counted in full, per currency and never summed across currencies (as in FR-TS-013). By person and month the payable total is used; by project its per-project lines. Money is handled as integer cents.
- **Tasks and workload (FR-REP-004):** per person in scope, including people without tasks: open, in progress, blocked, completed in the range, completed on time, overdue, remaining estimate, estimate vs actual of completed work, and a **load index** = remaining estimate ÷ scope average (1.0 = average). Subtasks count like tasks.
- **Compliance (FR-REP-005):** `required_document_categories (org_id, role, category)` with RLS, edited by `org.manage`, readable by report viewers, audited (`COMPLIANCE_REQUIREMENTS_UPDATED`). Per person: categories with no non-expired document (`missing`), expired documents, and those expiring within 30 days. Infected or rejected uploads do not count. `compliant` = nothing missing and nothing expired. `onlyIssues` keeps people with findings or something expiring.

## 5. Exports (FR-REP-006)

- `format=csv|xlsx|pdf` on every report route; JSON is the default. CSV and XLSX reuse `export-format.ts` (UTF-8 BOM, formula-injection protection). **PDF is new:** `toPdf` renders a paginated A4-landscape table with pdf-lib, which is already a dependency (ADR 010); no new package.
- Every export is audited as `REPORT_EXPORTED` with the report name, format, filters and row count.
- Scheduled e-mailed reports (FR-REP-007) are out of scope.

## 6. Tests

- `reports-e2e.test.ts` (11 tests, real Postgres): the 403 matrix for employees and subcontractors; team vs organisation scope and filters that cannot widen it; the dashboard for a lead and for HR (counts, 50-minute lateness against a 09:00 schedule with 10 minutes grace, approvals, overdue, confidential title hidden, contracts); each report's numbers and groupings; range validation; requirements permissions and validation; the compliance findings; and CSV/XLSX/PDF for every report with magic bytes, filenames and audit entries.
- Playwright `14-reports.spec.ts`: dashboard and reports for a lead, PDF download, the requirements editor for an admin, and the employee seeing nothing.

## 7. Known gaps

- No scheduled reports (FR-REP-007), no charts; tables only.
- "On leave or off" today is only known after the daily close; before that, people on leave show as "not yet in".
- The PDF is text-only (Helvetica, clipped cells); fine for an audit trail, not a designed document.
- Hours and cost per month attributes a whole timesheet's cost to the month its period starts in.
