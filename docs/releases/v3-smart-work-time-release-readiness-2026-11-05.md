# V3 Smart Work Time: release readiness

Date: 2026-11-05. Branch `feat/smart-work-time-2026-11-05`, based on V2 `a70219e` (live on
app.virtual-hr.site). PR target: `release/v2-office-toolbar-2026-11-04` (retarget to `main` once
PR #5 is merged). Design: ADR 049; requirements: SRS §5.13 FR-WT-001..024; gap analysis:
`v3-smart-work-time-gap-analysis-2026-11-05.md`.

**Not deployed.** Nothing was changed on AWS, the production database, Cloudflare or the
infrastructure. Deployment needs a separate approval.

## Business rules agreed (2026-11-05)

| Topic | Decision |
| --- | --- |
| Overtime and pay | `overtime_requires_approval` per organisation, **off by default** (pay = ADR 008 exactly). On: only approved overtime gets the multiplier; the rest is paid at the base rate. |
| Approved onsite time | An ONSITE time entry (work log), counted as covered time in reconciliation; never attendance. |
| Correction defects | Fixed: decided once; reviewers = manager, team reviewers or HR. |

## What changed for users

| Requirement | Delivered |
| --- | --- |
| 1 Meeting time | Calls count as "In meeting" only with at least one other person (server-checked); no double counting with typing, a second tab or a second device; meeting intervals listed on My attendance (and for managers, without titles); meeting time in timesheets, attendance and timesheet reports, exports and the live board. |
| 2 Overtime | Request (times or duration, project/task, description, reason, notes); manager/HR approve (fewer minutes allowed) or reject with a comment; cancel; history; worked vs requested vs approved on the timesheet; optional pay rule. |
| 3 Tasks and time | Timers on a task, project or own title; Pause/Resume; remaining estimate; names kept after renames; time on someone else's task only for people who manage it. |
| 4 Named work entries | Own title, project, task, start-end or duration, notes, work type (office/remote/onsite), category; overlap check; link to a task later; audited. |
| 5 Analytics | `/work-time/reports`: estimate vs actual per task, project/category/work-type breakdown, meeting vs focused task time (overlap counted once), over-estimate list, weekly and monthly trends, CSV/Excel; planning observations; "time is not quality" statement. |
| 6 Google Calendar | Upcoming meetings card (title, time, source, response, open link) on `/work-time`, the dashboard and `/account/calendar`; no new consent (existing `calendar.events` scope); calendar events never count as worked time. |
| 7 Onsite work | Report onsite work (date, times, location, project/task, description, reason) for review; approval adds an ONSITE entry; overlap with onsite claims, timed entries and attendance refused; 16 h a day; 30 days back. |

## Defects fixed (live in V2)

| # | Defect | Effect after release |
| --- | --- | --- |
| D1 | Input during a call was counted as active time and meeting time | Net attendance during calls drops to the wall clock |
| D2 | Alone in a room or meeting counted as meeting time | Solo time is ordinary, input-based time |
| D3 | A correction could be approved twice (two sessions) | 409 on the second decision |
| D4 | Any MANAGER could review any correction | Manager, team reviewers or HR only |
| D5 | Task report "Actual" always 0 | Real actual time |
| D6 | A Google rate limit asked users to reconnect | Temporary errors keep the connection |

D1 and D2 lower recorded meeting/net time for affected people from the release on (earlier days
are not recomputed). Release notes must say so.

## Database migrations (3, additive)

| Migration | Contents | Backward compatible |
| --- | --- | --- |
| `20261107000000_meeting_call_evidence` | `attendance_sessions.call_device_id`, `call_confirmed_at`; `attendance_segments.call_kind`, `call_meeting_id` (+ CHECK, partial index); `timesheet_days.meeting_minutes`, `timesheets.meeting_minutes` (backfilled from sessions, display only) | Yes: nullable / default 0 |
| `20261107000100_work_entries` | `time_entries.title`, `work_type`, `category`, `task_title`, `project_name` (+ CHECKs); one-time snapshot backfill (user triggers disabled inside the migration only) | Yes: nullable |
| `20261107000200_overtime_onsite` | `organizations.overtime_requires_approval` (default false); tables `overtime_requests`, `onsite_work_requests` (forced RLS, no DELETE grant, one-claim-a-day partial unique index); `time_entries.source` gains ONSITE; `timesheet_days.onsite_minutes` | Yes: V2 code ignores the new columns and tables |

`prisma migrate diff` against the migrated database is empty. Rollback: the V2 images run on the
migrated schema; the migrations need not be reverted. Back up the database first (runbook §5).

## Automated results (local, 2026-11-05)

| Check | Result |
| --- | --- |
| API tests (node:test, real Postgres/Redis/S3/KMS/LiveKit) | **971 / 971 pass**, 0 skipped |
| New API tests | state machine +4 (written first), call-evidence 10, call-share 4, meeting-time-e2e 7, correction-review-e2e 3 (written first), work-entries-e2e 7, timesheet-rules +7 (written first), work-requests-e2e 11, work-time-report-e2e 7, calendar-upcoming-e2e 9 |
| Playwright 40 (new) | 5 / 5 pass (one earlier run timed out once on the first timer start and passed on rerun) |
| Playwright full suite (V2 regression + 40) | **101 pass, 2 skipped** (the two real-recording tests, skipped unless LIVEKIT_EGRESS=1, as in V2); 37 min |
| Lint (eslint API + web) | clean |
| Typecheck (API + web) | clean |
| Production build (`next build`) | success; all five `/work-time` routes built |
| `prisma migrate diff` | empty |

## Screenshots

Captured by Playwright 40 (desktop 1280 px and phone 390 px): My work time with a running timer,
overtime request, onsite report, review queue, work-time report, and the four pages on a phone.

## Production configuration needed (names only)

- Calendar: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `CALENDAR_OAUTH_REDIRECT_URL`
  (or `API_PUBLIC_URL`), `APP_WEB_URL`, `DOCUMENT_KMS_*`. Google must verify the app for the
  `calendar.events` scope before people outside the test-user list can connect. Not checked on the
  server (no access from this session).
- Meetings: the API must reach LiveKit's HTTP API (`LIVEKIT_HTTP_URL`, `LIVEKIT_API_KEY`,
  `LIVEKIT_API_SECRET`), as it already does for recordings. If it cannot, meeting-room calls stop
  counting as meeting time after 90 s (office room and proximity calls are unaffected).

## Known limitations

- Approved onsite work cannot be withdrawn from the request page; HR returns or reopens the
  timesheet to change it.
- No per-person picker on the report page (the API supports `scope=person&userId=`).
- Meeting time of a call still running appears in reports after it ends (completed segments).
- Office room calls are verified by avatar presence in the same room, not by LiveKit membership.
- Earlier days are not recomputed for D1/D2.
- Production OAuth configuration was not inspected.

## Release decision

Ready for review. Deploy only after: PR review, green CI on the exact commit, the user's approval,
a database backup, and the runbook's migrate step (the migrations above).
