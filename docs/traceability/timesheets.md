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
