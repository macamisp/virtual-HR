# ADR 034: Weekly hours cap with 80 % and 100 % warnings

**Status:** Accepted
**Date:** 19 October 2026
**Requirements:** FR-ORG-004 (weekly hours cap with warnings at 80 % and 100 %), FR-ORG-002 (`weekly_hours_cap` on the subcontractor profile).

## Problem

`subcontractor_profiles.weekly_hours_cap` existed and is set on the rates screen, but it only fed the overtime split of the payable amount. Nobody was warned when a subcontractor approached or passed it.

## Decision (owner's choices, 19 October 2026)

- **What counts:** hours logged in time entries in the week, **Monday to Sunday in the organisation's time zone**. Stopped entries count their minutes; a running timer counts the time so far. Attendance time does not count.
- **Thresholds:** `WARN` from 80 %, `OVER` from 100 % (`capStatus`, pure; no cap or a zero cap is `NONE`).
- **Who is told:** the subcontractor, their approvers (the manager, else their team's leads and managers, the same rule as timesheet approval), and HR (`HR`, `HR_MANAGER`). In-app notifications `WEEKLY_CAP_WARNING` / `WEEKLY_CAP_REACHED` in the Timesheets group, so people can mute or email them from their preferences.
- **Once per threshold per week:** the notification dedupe key `weekly-cap:<person>:<week start>:<80|100>` with the existing unique `(user_id, dedupe_key)` index. Jumping from below 80 % past 100 % in one entry sends only the 100 % notice.
- **When it is checked:** after every time-entry write that adds time (manual entry, edit, timer stop, automatic stop at clock-out), through a `time.logged` domain event that the notifications module handles after commit (the timesheets module stays unaware of delivery, as for other timesheet events). The 15-minute `timesheet-reminders` job also checks subcontractors with a running timer, so a long timer that crosses the cap is caught without any write.
- **Banner:** `GET /timesheets/weekly-cap` (`timesheets.use`, the caller only) drives a banner on the subcontractor's timesheet page: a line below 80 %, a warning from 80 %, an alert from 100 %.

## Consequences

- The cap is a warning, not a block: time over the cap can still be logged (and is paid at the overtime multiplier, FR-TS-009, as before).
- Not done: FR-ORG-004's **per-project** cap and rate override per assignment. Rate overrides exist (`project_members.rate_override`); a per-project weekly cap would need a column there and the same check per project.
- The module is split to avoid an import cycle: `timesheets/weekly-cap.ts` (status, no service imports) and `notifications/weekly-cap-notifications.ts` (recipients and messages).
