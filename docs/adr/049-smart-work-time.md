# ADR 049: Smart work time: verified meeting time, overtime requests, named work, onsite time, work-time analytics, upcoming calendar meetings

Date: 2026-11-05. Status: accepted (business rules agreed with the product owner on 2026-11-05).
Requirements: FR-WT-001..FR-WT-024 (new, SRS §5.13), FR-MEET-009, FR-ATT-006, FR-ATT-013, FR-ATT-014,
FR-TS-003, FR-TS-004, FR-TS-005, FR-TS-009, FR-TASK-008, FR-REP-002, FR-REP-004, FR-REP-006, FR-MEET-006.
Related: ADR 003 (corrections), ADR 008 (timesheets, payable), ADR 023 (calendar), ADR 027 (leave),
ADR 031 (manager hierarchy), ADR 032 (schedules), ADR 034 (weekly cap), ADR 048 (call = meeting
segment). Gap analysis: `docs/releases/v3-smart-work-time-gap-analysis-2026-11-05.md`.

## Context

The client asked for seven capabilities. Most foundations exist; the audit found five defects in
live code (D1–D6 in the gap analysis). This ADR records the business rules first, because overtime
calculation (ADR 008, automatic) and overtime authorisation (new) are different things, and
because manual declarations must never become verified attendance.

## Decisions agreed with the product owner (2026-11-05)

| Topic | Decision |
| --- | --- |
| Overtime and pay | New organisation setting `overtime_requires_approval`, **off by default**. Off: payroll is exactly ADR 008 (no change for existing data). On: only approved overtime minutes get the overtime multiplier; the rest of the minutes above the cap are paid at the base rate. Timesheets always show worked, requested and approved overtime. |
| Approved onsite time | Becomes a **time entry** with source `ONSITE` (work log), not counted against the manual-time limit, counted as covered time in the timesheet reconciliation and shown separately. **Attendance records are not touched**: it is never verified automatic attendance. |
| Correction defects D3, D4 | Fixed: a correction is reviewed only while PENDING (409 after); the reviewer scope becomes the leave/timesheet rule (own manager, team lead/manager of the requester's team with `attendance.corrections.review`, or HR with `attendance.read.all`). |
| PR base | The PR targets the V2 release branch `release/v2-office-toolbar-2026-11-04`; it is retargeted to `main` once PR #5 is merged. |

## 1. Meeting time is verified by the server (FR-WT-001..006)

**1a. No double counting inside a call (D1).** A heartbeat processed while the session is
`IN_MEETING` adds nothing to `active_seconds` or `idle_seconds`: the wall-clock meeting segment
already covers that time. The heartbeat that opens the segment still adds its counters (they cover
the time before the call). Net time stays `active + meeting + paid break`; for MULTI_DEVICE sessions
the interval union is unchanged.

**1b. Call evidence (D2).** The browser's `inCall` is a claim. `AttendanceService` asks a
`CallEvidence` port before the state machine runs; when the answer is "no", the heartbeat is
processed with `inCall = false` (input-based tracking, so a person alone idles normally). Evidence:

| Call | Evidence (server-side only) | Cost |
| --- | --- | --- |
| Office room (closed room) | The person's avatar is in the room and at least one other avatar is in the same room (`OfficeRegistry`) | in memory |
| Proximity | The person's server-computed proximity group has 2+ members | in memory |
| Scheduled / instant meeting | The heartbeat names `callMeetingId`; the meeting is LIVE, the person is its host/attendee/admitted, and LiveKit `ListParticipants` shows the person plus at least one other participant | one Twirp call per live meeting room per 30 s (cached), only while someone in it reports a call |

If LiveKit cannot be reached, the last positive answer for that room is kept for 90 s, then the
call is not counted (fail closed). The desktop agent path (`webInCallAt`) is stamped only for
verified calls. The client cannot name an office room: the server reads it from the registry.

**1c. Which call.** Meeting segments opened from a heartbeat record `call_kind` (`ROOM`,
`PROXIMITY`, `MEETING`) and, for meetings, the meeting id in a new `call_meeting_id` column
(`meeting_id` keeps its ADR 001 meaning: a segment only the meetings hook closes).

**1d. Two tabs.** The tab that owns the call broadcasts its call state on a `BroadcastChannel`
every 15 s and on change; the heartbeat leader reports `inCall` when its own tab or a fresh (≤ 45 s)
broadcast says so. This closes the ADR 048 §6 known limit.

**1e. A second device does not end the call.** A heartbeat without a call closes the heartbeat
meeting segment only when it comes from the device that reported the call
(`attendance_sessions.call_device_id`), or when that device has not confirmed the call for two
heartbeat intervals (`call_confirmed_at`).

**1f. End of a call.** Within one heartbeat of: the client leaving the call, the evidence failing
(the other person left, the room emptied, the meeting ended), logout, session timeout, midnight or
maximum length (already credited by `closeLastSegment`, ADR 048).

**1g. Where meeting time is shown.** My attendance (per day, plus a new "Meetings" list of
intervals: start, end, duration, kind), `GET /attendance/me/meetings` and the manager equivalent in
scope, timesheet days (`meeting_minutes`, reconciled as part of attendance, not added to it), the
attendance report and CSV/XLSX (`meeting_hours`), the timesheet report, the live board (today's
meeting time), and the work-time report.

## 2. Overtime requests (FR-WT-007..012)

Table `overtime_requests` (org_id, forced RLS, no DELETE for `hrvo_app`). Columns: `user_id`,
`work_date` (org-local), optional `planned_start` / `planned_end` (local time of day; end after
start, same day), `requested_minutes` (15–720; computed from the times when given), `project_id?`,
`task_id?`, `work_description` (3–500), `reason` (3–500), `notes?` (≤ 1000), `status`
(PENDING, APPROVED, REJECTED, CANCELLED), `approved_minutes` (≤ requested), `decided_by`,
`decided_at`, `decision_comment`, `cancelled_at`, timestamps, `version`.

Rules:
- The owner submits for a date from 14 days ago up to 60 days ahead (pre-approval or after the fact).
- **No duplicate claims:** at most one PENDING or APPROVED request per person per work date
  (partial unique index; 409). To change one, cancel it and submit again.
- The project must be one the person may log time to (ADR 008 rule); the task must be visible.
- **Approvers:** never the owner (HR included). `timesheets.approve.all` decides for everyone;
  `timesheets.approve.team` decides for direct reports, or for members of their own team who have no
  manager (the leave rule, ADR 027). Overtime reuses the timesheet permissions instead of adding new
  ones, so custom roles keep working.
- Decide only while PENDING (`FOR UPDATE`, 409 otherwise). Rejection needs a comment. Approval may
  lower the minutes (`approved_minutes`); default is the requested minutes.
- The owner cancels while PENDING. An APPROVED request whose timesheet is still DRAFT/REJECTED can
  be cancelled by HR (`timesheets.approve.all`) with a comment; it is never edited in place.
- Audit: `OVERTIME_REQUESTED`, `_APPROVED`, `_REJECTED`, `_CANCELLED` (hash chain, same transaction).
- Notifications (after commit, deduplicated): request → approvers (`approversFor`, ADR 031),
  decision → owner, in-app and e-mail by preference.

Three different numbers, never merged:
- **Worked overtime (calculated):** per day, `attendance_daily.overtime_minutes` (net above the
  schedule, ADR 032); per ISO week for pay, ADR 008's minutes above the weekly cap.
- **Requested overtime:** the sum of `requested_minutes` of PENDING and APPROVED requests.
- **Approved overtime:** the sum of `approved_minutes` of APPROVED requests.

**Payable effect** (only when `organizations.overtime_requires_approval` is on): in each ISO week,
the overtime minutes paid at the multiplier are `min(calculated weekly overtime, approved overtime
for that week's dates)`; the remaining calculated overtime minutes are paid at the base rate. The
same chronological rule as ADR 008 decides which minutes are overtime. DAILY rate type: the same
cap per day. FIXED: no overtime. Approved timesheets keep their stored amounts. The setting is
edited by `org.manage` and audited.

## 3. Task timers and time entries (FR-WT-013..016)

- `time_entries` gains `title` (≤ 200), `work_type` (`OFFICE`, `REMOTE`, `ONSITE`, nullable for
  legacy rows), `category` (fixed list in `packages/shared`: DEVELOPMENT, DESIGN, TESTING, REVIEW,
  DOCUMENTATION, SUPPORT, RESEARCH, ADMIN, MEETING, TRAVEL, OTHER; nullable), `task_title` and
  `project_name` (snapshots written on insert and backfilled once; reads show the snapshot, so a
  rename keeps history), and declared `started_at`/`ended_at` for manual entries (§4).
- **Timers without a task:** `POST /timer/start` with `{ taskId? , projectId?, title?, workType?,
  category? }`; at least a task or a title. The ADR 008 routes stay.
- **Pause / Resume:** pause stops the running entry (as today); `POST /timer/resume` starts a new
  entry with the same task, project, title, work type and category as the person's last stopped
  entry of today. The UI groups them. There is still only one running entry (DB index).
- **Remaining estimate** per task = max(0, estimate − actual), shown with estimate and actual.
- **Logging on someone else's task:** a task assigned to another person accepts time only from
  people who manage the task (`task-policy.managesTask`); an unassigned task from project members.
- Project and task totals: computed from entries (as ADR 008); `GET /projects/:id/time` adds the
  project total in scope.

## 4. Employee-named work entries (FR-WT-017..018)

A manual entry may carry a title, work type, category and declared start/end times (org-local, same
day, not in the future). With times, minutes are computed and the entry must not overlap the
person's other entries that have times (409). Without times, minutes as today. All ADR 008 rules
stay: reason required, "Manual" badge, flagged above the daily manual limit, editable only while
the timesheet is DRAFT/REJECTED. A named entry does not create or change a task. Turning one into
an official task uses the normal task creation route (`POST /tasks`, its project and assignment
rules) and then links the entry (`PATCH /time-entries/:id` with `taskId`, allowed only when the
person may log time to that task). Manual entries are now audited (`TIME_ENTRY_MANUAL_ADDED`,
`_UPDATED`, `_DELETED`; metadata only, never the notes).

## 5. Work-time analytics (FR-WT-019..021)

`GET /reports/work-time?from&to&userId?&projectId?&format=json|csv|xlsx` (range ≤ 366 days).
Scope: one's own data with `timesheets.use`; others with `reports.team` (team and reports) or
`reports.all`. Exports audited (`WORK_TIME_REPORT_EXPORTED`, filters and row count only).

From server records only:
- **Attendance** (net, sessions), **meeting** (`IN_MEETING` segments), **task time** (finished
  time entries). **Focused task time** = task-time intervals minus their overlap with meeting
  segments (timer entries have real intervals; manual and onsite entries without times count as
  focused). The overlap is reported as "task time during meetings", so nothing is counted twice.
- Per task (estimate, actual in range, actual all time, remaining, % of estimate), per project, per
  category, per work type, weekly and monthly trend series, and "tasks over estimate" (actual >
  estimate, with how many of the person's completed tasks in the range went over).
- D5: the task report's actual time now sums time entries.
- Copy on every analytics view: activity time does not measure the quality or value of anyone's
  work; the numbers are prompts for planning (estimates, meeting load), not ratings.

## 6. Upcoming Google Calendar meetings (FR-WT-022)

`GET /calendar/upcoming?days=1..14` reads the connected Google primary calendar on demand
(`events.list`, `singleEvents`, ordered by start, ≤ 50, no deleted events), cached 60 s per person in
memory; nothing is stored, nothing logged but the HTTP status. The existing scope `calendar.events`
already permits reading, so no new consent is needed. Each item: title, start/end (or all day),
source (`Google Calendar (primary)`; marked "Virtual-HR meeting" when its iCal UID is ours, which
then links to the meeting page), the person's response (accepted/declined/tentative/needs action),
and an open link (our meeting page, else the Google Meet link, else the event's Google page; only
`https://` links are returned). Outlook connections return the same shape from `calendarView`.
A calendar event never creates attendance or meeting time (§1 needs a real call).

D6: only `invalid_grant` on refresh and 401 mark a connection `ERROR` ("Connect again"); 403 with
a rate-limit reason and 429 are temporary (`last_error` set, status unchanged).

## 7. Onsite work requests (FR-WT-023..024)

Table `onsite_work_requests` (org_id, forced RLS, no DELETE for `hrvo_app`): `user_id`,
`work_date`, `started_at`/`ended_at` (timestamptz computed from the org-local date and times; same
day; not in the future), `minutes`, `location` (3–200), `project_id?`, `task_id?`, `description`
(3–1000), `reason` (3–500), `status` (PENDING, APPROVED, REJECTED, CANCELLED), `decided_by`,
`decided_at`, `decision_comment`, `time_entry_id` (set on approval), timestamps.

Rules:
- Up to 30 days back. At most 16 h per request and per day across PENDING/APPROVED requests.
- **Duplicate checks (409):** no overlap with the person's other PENDING/APPROVED onsite requests,
  with their timed time entries, or with their attendance sessions (if they were clocked in, the
  right tool is an attendance correction or a manual task log, and the message says so).
- Approvers and the decide/cancel rules: as overtime (§2). Approval needs the period's timesheet to
  be DRAFT or REJECTED (409 "reopen the timesheet first" otherwise) and inserts the `ONSITE` time
  entry in the same transaction.
- Reconciliation: `timesheet_days.onsite_minutes`; variance compares logged time with attendance +
  approved onsite. Onsite minutes are not "manual minutes" for the daily manual limit.
- Audit `ONSITE_WORK_REQUESTED/_APPROVED/_REJECTED/_CANCELLED`; notifications as overtime.

The three manual paths stay distinct in the UI and the data:

| Path | Table | Changes attendance? | Review |
| --- | --- | --- | --- |
| Manual task log | `time_entries` (MANUAL) | No | With the timesheet |
| Attendance correction | `attendance_corrections` → CORRECTION session | Yes, flagged CORRECTED | Manager/HR per correction |
| Onsite work | `onsite_work_requests` → `time_entries` (ONSITE) | No | Manager/HR per request |
| Overtime request | `overtime_requests` | No | Manager/HR per request |

## 8. Web

A **My work time** page (`/work-time`) with a running timer (task or own title), today's entries
and the add-work form; **Onsite work** (`/work-time/onsite`), **Overtime** (`/work-time/overtime`),
**Review** (`/work-time/review`: overtime and onsite queues in scope), **Work-time report**
(`/work-time/reports`) and an **Upcoming meetings** panel (dashboard and `/work-time`). Existing
components (shadcn/ui, status badges, the leave pages' patterns); loading, empty and error states;
phone width without horizontal scroll.

## 9. Migration and compatibility

One migration per slice, from `20261107000000_meeting_call_evidence` (§1: call columns on sessions
and segments, `meeting_minutes` on timesheet days and periods, backfilled for display only). New
columns are nullable or have defaults, snapshots are backfilled, the `time_entries.source` CHECK
gains `ONSITE`, the new tables get forced RLS and grants like ADR 027. No existing row changes
meaning; with the setting off, payable amounts are identical (tested). Export columns are only ever
appended, so existing column positions stay. Rollback: the V2 images ignore the new columns and
tables.

## Consequences

- Meeting time on the live site will drop for people who sat alone in rooms or typed during calls
  (D1, D2): those minutes were never real meeting time. Release notes must say so.
- Meetings need LiveKit's server API reachable from the API (already true for recording and
  moderation).
- Overtime approval affects pay only when an organisation turns it on.

## Implementation notes (2026-11-05, branch `feat/smart-work-time-2026-11-05`)

What was built, and where it differs from the plan above:

- **Migrations:** `20261107000000_meeting_call_evidence` (§1), `20261107000100_work_entries` (§3, §4;
  the snapshot backfill disables the user triggers of `time_entries` inside the migration only),
  `20261107000200_overtime_onsite` (§2, §7). `schema.prisma` matches (`prisma migrate diff` is empty).
- **§1b meeting id:** the heartbeat's existing signed `meetingId` field names the meeting of a call;
  the validator now refuses a non-string or over-long value. Evidence lives in
  `apps/api/src/media/call-evidence.service.ts`, registered on `AttendanceService` at start-up; without
  a registered check (unit tests only) the client's claim is used as before.
- **§1g:** meeting titles are shown only to the person; managers see kind, times and durations.
  Export columns are appended (`meeting_hours`, `Meetings (h)`), never inserted.
- **§3 project totals:** no separate `GET /projects/:id/time`; project totals are the project
  breakdown of the work-time report (§5), computed from the same entries.
- **§7 cancel:** the owner cancels a pending onsite request. Approved onsite work has no withdraw
  action yet: its ONSITE entry cannot be deleted by the owner (409), and HR returns or reopens the
  timesheet if it must change. Tracked as a known limit.
- **§6:** built in a separate commit (`calendar.service.ts` `upcoming()`); a 401 with a token not
  refreshed in this request earns one refresh and retry before `ERROR`.
- **§8:** the Upcoming meetings card is on `/work-time`, the manager dashboard and `/account/calendar`.
- **Defects:** D1-D6 fixed with tests (state machine, correction-review-e2e, work-time-report-e2e,
  calendar-upcoming-e2e).
