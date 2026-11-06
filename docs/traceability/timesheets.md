# Traceability: Timesheets (SRS 5.6)

| Requirement | Implementation | Tests |
| --- | --- | --- |
| FR-TS-001 daily draft from attendance + entries | `timesheet-store.ts` `refreshDay`; attendance daily close → `refreshTimesheetDay` | timesheets-e2e "daily close writes attendance…", attendance-advanced-features, attendance-hardening-coverage |
| FR-TS-002 periodic timesheet (weekly / bi-weekly / monthly) | `periods.ts`, `ensureTimesheet`, `PUT /timesheets/settings` | timesheet-rules "Timesheet periods", timesheets-e2e "Org settings" |
| FR-TS-003 task timers, one at a time, auto-stop at clock-out | `time-entries.service.ts`, partial unique index, repository `onSessionClosed` | timesheets-e2e "Task timers", timesheet-rules "midnight", Playwright 09 |
| FR-TS-004 manual time, reason, daily limit | `addManual`, `refreshDay` MANUAL_LIMIT flags, CHECK constraint | timesheets-e2e "Manual time", Playwright 09 |
| FR-TS-005 reconciliation + variance alert | `reconcile.ts`, `refreshDay`, `timesheetReminders` variance | timesheet-rules "Reconciliation", timesheets-e2e daily draft + variance alert |
| FR-TS-006 submit / approve / reject, locked | `timesheets.service.ts`, `timesheet-policy.ts`, lock-guard trigger | timesheet-rules "permissions", timesheets-e2e lifecycle, Playwright 09 |
| FR-TS-009 payable amount | `money.ts` `computePayable`, stored at approval | timesheet-rules "Payable amount", timesheets-e2e amounts |
| FR-TS-011 reopen with timesheet.reopen, audited | `reopen`, `TIMESHEET_REOPEN` permission, audit chain | timesheets-e2e "only timesheet.reopen…" |
| FR-TS-012 reminders to submit and to approvers | `ScheduledWorkService.timesheetReminders`, `TimesheetNotificationsListener` | timesheets-e2e "Notifications, reminders…", jobs-bullmq-e2e schedulers |
| FR-TS-013 reports + CSV/XLSX export | `reports.service.ts`, `common/export-format.ts` | export-format.test, timesheets-e2e "Reports and exports", Playwright 09 |

Decisions and known gaps: ADR 008.

## Smart work time (ADR 049, SRS 5.13)

| Requirement | Implementation | Tests |
| --- | --- | --- |
| FR-WT-007..010 overtime request, decided once by manager/team approver/HR, never oneself, one claim a day, history | `work-requests/work-requests.service.ts`, `overtime_requests` (partial unique index, forced RLS, no DELETE); `/work-time/overtime`, `/work-time/review` | work-requests-e2e (overtime: validation, one per day, own/other team 403, fewer minutes, decided once, cancel rules, RLS); Playwright 40 |
| FR-WT-011 worked / requested / approved shown apart; pay rule when the organisation requires approval | `money.ts` `approvedOvertime`, `timesheets.service.ts` `overtimeSummary`, `organizations.overtime_requires_approval` | timesheet-rules "Payable with overtime approval" (7); work-requests-e2e "pay: setting off = ADR 008; on = only approved minutes…" |
| FR-WT-012, FR-WT-024 audit and notifications | `appendAuditEntry` in the same transaction; `NotificationsService.notify` after commit; types OVERTIME_*/ONSITE_* | work-requests-e2e (audit counts, notifications) |
| FR-WT-013 timer on a task, project or own title; pause/resume; one at a time | `time-entries.service.ts` `startTimer`/`resumeTimer`, `POST /timer/start`, `POST /timer/resume`; `/work-time` | work-entries-e2e; Playwright 40 |
| FR-WT-014 estimate, actual, remaining | `tasks.sql.ts` `remainingMinutes`; report task table | work-entries-e2e; work-time-report-e2e |
| FR-WT-015 names kept after rename | `time_entries.task_title`/`project_name` snapshots | work-entries-e2e "entries keep the task and project names…" |
| FR-WT-016 someone else's task only by people who manage it | `assertMayLogOn` | work-entries-e2e "FR-WT-016…" |
| FR-WT-017, FR-WT-018 named entries, declared times, overlap, audit | `addManual`, `assertNoOverlap`, `TIME_ENTRY_MANUAL_*` | work-entries-e2e; Playwright 40 |
| FR-WT-019..021 work-time analytics, no double counting, export, wording | `reports/work-time.service.ts`, `GET /reports/work-time`; `/work-time/reports` | work-time-report-e2e (totals with overlap, scope, project filter, CSV audit, insight wording); Playwright 40 |
| FR-WT-023 onsite work, approval into an ONSITE entry, never attendance | `requestOnsite`/`decideOnsite`, `onsite_work_requests`, `timesheet_days.onsite_minutes`; `/work-time/onsite` | work-requests-e2e (onsite: overlap with onsite/entries/attendance, future, 30 days; approval adds an entry, no session, variance covered, entry not deletable) |
| FR-TASK-008 / D5 task report actual from entries | `reports.service.ts` task report | work-time-report-e2e "D5"; reports-e2e |
