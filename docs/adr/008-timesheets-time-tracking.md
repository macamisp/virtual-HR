# ADR 008: Timesheets and Time Tracking

**Status:** Accepted (slice 1 of 2: time entries, timesheets, approvals, payable)
**Date:** 15 October 2026
**Requirements:** SRS 5.6 FR-TS-001..006, 009, 011..013; 6.3 daily close; 6.4 parameters; 7.4 time_entries, timesheets.

## 1. Decisions agreed with the product owner (15 Oct 2026)

| Topic | Decision |
| --- | --- |
| Finance role | No new role: `AUDITOR` is the SRS §3 "Finance / Auditor" role. It gets `timesheets.read.all` (timesheets, rates, reports, exports) and nothing that changes data. |
| Rates | A minimal `subcontractor_profiles` now, with only the FR-ORG-002 rate fields: `rate_type`, `rate`, `currency`, `overtime_multiplier`, `weekly_hours_cap`. Plus `project_members.rate_override` (FR-ORG-004). HR edits them on the Rates page. Encrypted tax and bank fields come with the ORG slice. Only subcontractors get an amount; employees get hours. |
| Overtime | Per ISO week, hours above the profile's weekly cap (else the work-schedule capacity, else 40 h) are paid at rate × multiplier. HOURLY = hours × rate. DAILY = each day with time pays the day rate; hours beyond 8 h that day are paid at rate / 8 × multiplier. FIXED = the rate per period, with no overtime and no overrides. |
| XLSX | Hand-written Office Open XML in a zip, built with Node's own `zlib` (`deflateRaw`, `crc32`). No new package. |

## 2. Data model (`20261017000000_timesheets`)

- **`timesheets`**: one per user per period (FR-TS-002). The period is weekly, bi-weekly (14-day blocks from `organizations.timesheet_period_anchor`, a Monday) or monthly, set by `organizations.timesheet_period`. A timesheet is created on first use, and a new period never overlaps an existing one: after a change of setting it is shortened to fit. Columns: `status` (DRAFT, SUBMITTED, APPROVED, REJECTED; LOCKED and PAID are reserved), totals, `amount` numeric(14,2), `currency`, and the stored `payable` breakdown (jsonb). It also records submit, approve, reject and reopen stamps, and a `version` for optimistic concurrency.
- **`timesheet_days`**: the daily draft (FR-TS-001), one row per user per day. It holds net attendance minutes, logged minutes, manual minutes, variance minutes and percent, and flags (VARIANCE, NO_ATTENDANCE, MANUAL_LIMIT).
- **`time_entries`**: the SRS 7.4 columns plus `work_date` (org-local day), `flag_reason` and `auto_stopped`. A partial unique index allows one running entry per user (FR-TS-003). CHECKs: a manual entry needs a reason of at least 3 characters; only a timer can be open-ended; 0–1440 minutes.
- **`timesheet_approvals`**: append-only history of SUBMIT, APPROVE, REJECT and REOPEN. It feeds the approval-turnaround reports.
- **`subcontractor_profiles`** (see §1) and **`project_members.rate_override`**.
- **Org settings (SRS 6.4)**: `manual_time_limit_minutes` (default 120, range 0–480), `timesheet_variance_pct` (default 15, range 5–50), `timesheet_submit_due_days` (default 1, range 0–14), plus the period setting and anchor above.
- **RLS** is forced on every new table. `hrvo_app` cannot delete timesheets, days or profiles, and cannot change approvals.
- **Lock guard:** a `BEFORE INSERT/UPDATE/DELETE` trigger on `time_entries` refuses writes when the entry's timesheet is not DRAFT or REJECTED (error hint `TIMESHEET_LOCKED`). This holds whatever the caller. Cascading deletes (an organisation or user being removed) are allowed.

### Merging `draft_timesheets` (ADR 003 note)

The migration copies every `draft_timesheets` row into `timesheet_days` inside the weekly timesheet of its date, then recomputes the totals. It then checks that every legacy row has a merged day and aborts otherwise. It runs with `row_security = off`, so a migration role without BYPASSRLS fails loudly instead of silently skipping rows.

The old table is **renamed** to `draft_timesheets_legacy`, not dropped, and `hrvo_app` loses all access to it. A later migration drops it once the merge has been checked on real data; nothing is deleted in this one. The merge was checked against an existing development database (495 attendance minutes on 14 Oct, now in the 12–18 Oct week).

## 3. Behaviour

- **Server clock only.** Timer start and stop times and the "today" boundary come from the server, in the org timezone. Request bodies carry no timestamps; a `startedAt` sent by a client is ignored, and a test checks this.
- **Timers (FR-TS-003):** `POST /tasks/:id/timer/start|stop`, `POST /timer/stop`, `GET /timer` (with `serverNow`, so the browser shows elapsed time without trusting its own clock).
  - Starting a timer needs an open attendance session, a visible task, and acceptance if you are its assignee.
  - Starting another timer stops the current one. A timer that crosses local midnight is split into one entry per day.
- **Auto-stop at clock-out:** the attendance repository notifies listeners after a session closes. This covers logout, disconnect, timeout and max-length. It does not fire for the midnight split (work continues) or for correction re-saves.
  - The running timer ends at the session's clock-out time, which is the last valid heartbeat. A timer started after that gets 0 minutes.
  - It does not stop while another device is still clocked in.
  - An earlier draft required "timer started before clock-out". That would have left timers running after a network loss, because the session closes at the last heartbeat. Dropped.
- **Manual time (FR-TS-004):** a reason is required and the entry is shown as "Manual" with its reason. No future days, and at most 24 h of time per day.
  - Manual minutes beyond the org's daily limit are **accepted but flagged** (MANUAL_LIMIT), in the order they were added. Deleting an earlier entry clears the flag. This follows SRS 7.4 (`flagged` = "manual-limit exceeded") rather than refusing the entry.
- **Reconciliation (FR-TS-005):** attendance is the sum of `net_seconds` of the day's sessions, excluding cancelled and adjusted ones. Logged time is the day's finished entries.
  - A day is flagged when |logged − attendance| is more than the threshold percentage of attendance, or when time is logged with no attendance. The rule uses integer arithmetic and "more than" is strict.
  - The day is recomputed on every entry change, by the attendance daily close (replacing the old draft write), when viewing today, and for every day at submission.
- **Approval (FR-TS-006, 011):**
  - **Submit:** the owner submits on or after the last day of the period, with no timer running.
  - **Approve or reject:** done by the owner's manager, leads and managers of the owner's team (`timesheets.approve.team`), or HR (`timesheets.approve.all`). A rejection needs a comment and returns the timesheet to the owner.
  - **Locking:** an approved timesheet is locked, in the API and in the trigger.
  - **Own timesheets:** nobody approves their own, HR included. Self-reopen is refused too.
  - **Reopen:** needs `timesheet.reopen` (HR manager, admins) and a reason, and returns the timesheet to DRAFT with the amount cleared.
  - **Audit:** approve, reject and reopen go to the hash-chained audit log, as do rate and policy changes.
  - **Stale writes:** stale versions get a 409.
- **Visibility:** owner; approvers in scope; `timesheets.read.all` read-only. Subcontractors hold none of the wider permissions, so they only ever see their own. Invisible and missing both return 404.
  - A new guard decorator, `RequireAnyPermission`, lets read routes accept `timesheets.use` or `timesheets.read.all`.
- **Payable (FR-TS-009):** `money.ts` uses no floats. Amounts are bigint cents and multipliers bigint hundredths; results are exact fractions rounded half-up once per project line. The total is the sum of the lines, so a breakdown always adds up.
  - Numeric columns are read as text, and money in the API is a decimal string (numbers are refused).
  - Overtime falls on the chronologically last minutes of the week. The whole ISO week counts towards the cap even when it straddles two periods, but only this period's minutes are paid.
  - Before approval the amount is a live estimate. At approval it is stored with the currency and breakdown, so later rate changes do not alter it (tested).
  - Amounts that do not fit numeric(14,2) are refused.
- **Estimate vs actual (FR-TASK-008):** the stub from ADR 007 is replaced. A task's actual time is the sum of its finished time entries.

## 4. Web

- **Task page:** a Timer card. The header shows a badge with the running task, its elapsed time and a Stop button.
- **My timesheet:** totals, days with flags, entries (timer or manual with reason, plus the over-limit warning), an add-manual-time form, notes, the payable estimate or final amount, history, Submit, and links to other periods.
- **Review timesheets:** the approval queue in scope, plus all or team timesheets with a status filter. Approve, reject (comment required) and reopen (reason required) are on the timesheet itself. For Finance/Auditor the page is read-only.
- **Rates:** subcontractor rates and project overrides, editable with `rates.manage` and read-only for the auditor. The org timesheet policy is editable with `org.manage`.

## 5. Tests (slice 1)

- **`timesheet-rules.test.ts`** (written first):
  - money parsing and formatting, and rejected inputs;
  - payable edge cases: rounding, float drift, overrides, chronological overtime, a week straddling a period, DAILY, FIXED, zero, overflow;
  - periods: weekly, bi-weekly in both directions, monthly with leap years;
  - the variance boundary;
  - the permission matrix;
  - the midnight split.
- **`timesheets-e2e.test.ts`** (24 tests):
  - timers: clock-in and acceptance required, one at a time, DB-level uniqueness, auto-stop at the last heartbeat, no auto-stop while another device is online, actual time on the task;
  - manual time: rules, limit flags and their recalculation;
  - daily close and variance, period shape, settings;
  - rates: validation and audit;
  - the full submit / reject / resubmit / approve / reopen cycle, with amounts, locking in the API and the DB, versions, visibility and route permissions;
  - RLS on every table, append-only approvals, and no access to the legacy table.
- **Playwright `09-timesheets.spec.ts`:** a timer from the task page and the header badge; manual time with its reason, over-limit flag and payable USD 63.75; submit; the lead rejects (a comment is required); resubmit; approve and lock.
