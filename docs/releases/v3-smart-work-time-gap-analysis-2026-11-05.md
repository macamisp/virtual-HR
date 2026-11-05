# V3 Smart Work Time: implementation-gap analysis

Date: 2026-11-05. Branch: `feat/smart-work-time-2026-11-05` (from V2 `a70219e`, the commit live on
app.virtual-hr.site). Scope: the client's seven requirements (meeting time, overtime, task time,
named work entries, analytics, Google Calendar, manual onsite time). Method: read-only audit of
ADRs 003, 007, 008, 013, 023, 027, 031, 032, 034, 048, the SRS, the Prisma schema, the API modules
and the tests. Every verdict cites code; the items marked **verified** were re-read line by line.

Legend: **Existing** = meets the requirement as is; **Partial** = foundation exists, gap named;
**Missing** = nothing to reuse beyond shared infrastructure.

## Defects found during the audit (pre-existing, live in V2)

| # | Defect | Evidence | Impact |
| --- | --- | --- | --- |
| D1 | **Meeting time double-counted when the person types during a call** (verified) | `attendance-state-machine.ts:162` adds `activeSeconds` in every state, including `IN_MEETING`; `:717` sets net = active + meeting (single-device sessions) | Net attendance inflated by the input time inside calls; feeds timesheet attendance and variance |
| D2 | **Solo calls earn meeting time** | `inCall` is client-reported and trusted (`attendance.service.ts:397-434`); `mediaRoute` puts a lone avatar in a closed room's call (`packages/shared/src/office/spatial.ts:113-123`) | An avatar alone in a meeting room gets `IN_MEETING` time |
| D3 | **Attendance correction can be reviewed twice** (verified) | `reviewCorrection` (`attendance.service.ts:959-1036`) never checks `status = PENDING`; `updateCorrection` updates by id only | A second approval creates a second CORRECTION session (duplicate attendance) |
| D4 | **Any MANAGER reviews any correction in the org** (verified) | `attendance.service.ts:983` `params.reviewerRole === UserRole.MANAGER` | Wider than the leave/timesheet scope (own reports / team) |
| D5 | **Task report "Actual (h)" is always 0** (verified) | `reports.service.ts:226` sums `tasks.actual_minutes`, which no code writes; the real figure is `actual-time.ts:19` | Wrong estimate-vs-actual in the reports page and exports |
| D6 | Calendar: any 400/401/403 marks the connection `ERROR` | `calendar.service.ts:202` | A Google 403 rate limit asks the user to reconnect |

## Requirement 1: meeting attendance counts as active

| Item | Verdict | Evidence / gap |
| --- | --- | --- |
| "In meeting" presence, counted without input | Existing | `attendance-state-machine.ts:103,196-204`; live board, tracking badge, office ring |
| Start, end, duration recorded | Partial | `attendance_segments` rows with `state='IN_MEETING'`; heartbeat calls carry no room/meeting id; no API lists intervals |
| Shown in Attendance | Existing | `attendance/page.tsx:36,196` |
| Shown in Timesheets | Missing | `timesheet_days` has attendance minutes only |
| Shown in manager reports / exports | Missing | `reports.service.ts:93-116`, attendance CSV header `attendance.service.ts:1532` |
| Survives page navigation | Existing | ADR 048 call controller; e2e spec 36 |
| Idle detection does not stop it | Existing | `:103`; unit test `attendance-state-machine.test.ts:423` |
| No double count with two tabs | Partial | One heartbeat leader per browser; but call owner and leader are elected separately (ADR 048 §6 known limit); a second device without the call ends the segment; **D1** |
| Empty room does not count | Missing | **D2** |
| Stops on call end / logout / session end | Partial | Logout and timeout close it; LiveKit `participant_left`/`room_finished` webhooks never touch attendance |

## Requirement 2: overtime request and approval

| Item | Verdict | Evidence / gap |
| --- | --- | --- |
| Worked overtime (calculated) | Existing | `attendance_daily.overtime_minutes` + `OVERTIME` flag vs schedule (`attendance.service.ts:1161,1215`) |
| Payable overtime (calculated) | Existing | `money.ts:143-209`: weekly cap (profile, else schedule, else 40 h) × `overtime_multiplier`, subcontractors only; DAILY > 8 h/day |
| Request / approval workflow | Missing | No entity, route or UI |
| Approver resolution, notifications, audit | Reusable | Leave module is the template: `leave.service.ts` (`decides()`, `FOR UPDATE`, 409 on non-PENDING, cancel), `approversFor()` (`timesheets.service.ts:442`), `appendAuditEntry`, `NotificationsService.notify` |
| **Conflict** | — | Payable overtime is paid automatically today; the brief says unapproved overtime must not become payable. Needs a product decision (see below). |

## Requirement 3: tasks connected to worked time

| Item | Verdict | Evidence / gap |
| --- | --- | --- |
| Session → project + optional task | Partial | Manual entries: both optional; timers require a task (`time-entries.service.ts:84-108`) |
| Estimated / actual / remaining | Partial | Estimate + live actual + overrun per task; no remaining per task |
| Start / Pause / Resume | Partial | Start and stop only; no pause |
| Server-authoritative time | Existing | Server clock, `serverNow`, auto-stop at clock-out, midnight split |
| No overlapping running timers | Existing | Advisory lock + unique partial index `time_entries_one_running_timer` |
| Entries linked to timesheets | Existing | `time_entries.timesheet_id` required; `refreshDay`/`refreshTotals` |
| Task/project totals in sync | Partial | Live task actual; project totals only in reports; **D5** |
| History survives task rename | Missing | Entries join the current `tasks.title` / `projects.name` (`timesheets.sql.ts:18-24`) |
| Logging on someone else's task | Gap | Any project member who can see a task can log time on it (`time-entries.service.ts:276-281`) |

## Requirement 4: employee-named work entries

| Item | Verdict | Evidence / gap |
| --- | --- | --- |
| Own title | Missing | `time_entries` has no title |
| Project optional, task optional | Existing | Manual entries |
| Start/end or duration | Partial | Minutes only; `started_at` NULL |
| Description | Existing | `note` |
| Work type office/remote/onsite | Missing | — |
| Project authorization | Existing | Membership required for project-only time (`time-entries.service.ts:304-311`); task edit rules in `task-policy.ts` |
| Conversion to an official task | Missing | Must go through task creation rules (`tasks.use`, assign rules) |

## Requirement 5: task duration analytics

| Item | Verdict | Evidence / gap |
| --- | --- | --- |
| Estimated vs actual | Partial | Per task in the task list; report column broken (**D5**) |
| Task-wise time | Missing | Report is per person |
| Project-wise time | Existing | `hours-cost` groupBy project; timesheet report by project |
| Work category breakdown | Missing | No category on entries |
| Meeting vs focused task time | Missing | Meeting time only in `attendance_daily.meeting_seconds` |
| Tasks consistently exceeding estimates | Partial | Per-task overrun flag, no list |
| Weekly / monthly trends | Partial | Month grouping in cost report; week/month in attendance report |
| Export | Existing | `exportTable` CSV/XLSX/PDF, formula-safe, audited |

## Requirement 6: Google Calendar

| Item | Verdict | Evidence / gap |
| --- | --- | --- |
| OAuth connect + consent (PKCE, single-use state) | Existing | `calendar.service.ts:86-131`; separate from Google sign-in |
| Read permissions | Partial | Scopes `calendar.events calendar.freebusy` (read/write); only our own events and free/busy are read |
| Two-way meeting sync | Existing | `events.import`, RSVP back, 5-min job + Sync now |
| Scheduling / availability | Existing | `calendar_busy`, busy hint on the schedule form |
| Token refresh / reconnect | Existing | Refresh 60 s early; `ERROR` + "Connect again"; **D6** |
| Secure token storage | Existing | Envelope-sealed with the KMS key provider |
| Upcoming events list (API + UI) | Missing | No endpoint, no panel |
| Calendar never counts as worked time | Existing | Only a real call opens `IN_MEETING` |
| Production config (names only) | To check at release | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `CALENDAR_OAUTH_REDIRECT_URL` (or `API_PUBLIC_URL`), `APP_WEB_URL`, `DOCUMENT_KMS_*`; Google app verification for `calendar.events` |

## Requirement 7: manual onsite time

| Item | Verdict | Evidence / gap |
| --- | --- | --- |
| Manual task work log | Existing | `time_entries.source='MANUAL'` with reason, flagged above the daily limit |
| Attendance correction | Existing | `attendance_corrections` (ADR 003), with **D3**, **D4**, no cancel, no notifications |
| Onsite request with start/end, location, review | Missing | — |
| Duplicate / overlap checks | Missing | Manual entries: 24 h/day cap only |
| Audit for manual entries | Missing | No `appendAuditEntry` in `time-entries.service.ts` |
| Timezone | Existing | Org timezone decides the work date everywhere |

## Shared infrastructure to reuse

- RLS: `ENABLE` + `FORCE`, policy on `current_setting('app.org_id')` (pattern:
  `20261101000100_leave_holidays_rls`); `PrismaService.runWithTenantContext`.
- Permissions: `Permission` + `ROLE_PERMISSIONS` in `packages/shared/src/auth/types.ts`;
  `@RequirePermissions` / `@RequireAnyPermission`; `userCan`.
- Audit: `appendAuditEntry(client, entry)` (hash chain, same transaction).
- Notifications: `NotificationsService.notify` with dedupe keys; types in
  `packages/shared/src/notifications/types.ts`.
- Exports: `common/export-format.ts`, `exportTable`.
- No new npm package is needed for any requirement.
