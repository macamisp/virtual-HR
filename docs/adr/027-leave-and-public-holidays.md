# ADR 027: Leave requests and the public holiday calendar

**Status:** Accepted
**Date:** 17 October 2026
**Requirements:** FR-ORG-010 (leave requests with manager approval), FR-ORG-011 (public holiday calendar, Sri Lanka default, HR-editable), FR-ATT-022 (leave and holidays suppress absence alerts), FR-ATT-016 (live board shows "on leave"), FR-ADM-001.

## Problem

The attendance engine already understood leave and holidays through `ILeaveProvider` and `IHolidayProvider`, but production wired neither (`attendance.module.ts` passed `undefined`). Only in-memory test fakes exercised those paths. There was no leave request, no approval, and no holiday calendar.

## Decisions

**Data.** `leave_requests` (whole days; type ANNUAL, SICK, UNPAID, OTHER; status PENDING, APPROVED, REJECTED, CANCELLED; decision, decider, note) and `public_holidays` (one row per organisation and date). Both carry `org_id` with forced RLS. Requests are cancelled, never deleted (no DELETE for the application role). CHECKs hold the enumerations, `end_date >= start_date`, at most 90 days, and a decision time on every decided row.

**Who decides.** Never the requester. HR and admins (`leave.approve.all`) decide for everyone. A team approver (`leave.approve.team`: team leads and managers) decides for their direct reports, or for people in their team who have no manager: the same rule as timesheet approval, so the two never disagree about who someone's approver is. A rejection needs a note. A request is decided once.

**Overlaps.** A person has at most one pending or approved request covering any day.

**Cancelling.** The requester may cancel a pending request, or approved leave that has not ended yet (a person who booked today off and comes in anyway).

**Holidays.** HR (`holidays.manage`) adds, renames and removes days. "Load the Sri Lanka calendar" inserts the built-in list for a year without touching dates HR already set. The migration seeds the 2026 calendar for existing organisations. The 2026 list comes from the Government Printing Department's calendar and the May 2025 gazette notice under the Holidays Act, as published by [Ada Derana](https://www.adaderana.lk/news/116465/sri-lankas-2026-holiday-calendar-heres-the-full-list-) and the [Royal Danish Consulate's 2026 list](https://indien.um.dk/en/-/media/country-sites/indien-en/about-us/sri-lanka-2026.ashx); both agree on every date. 1 May is both May Day and Vesak Poya in 2026 and is one row. Later years need their gazette added to `sri-lanka-holidays.ts`; until then HR adds the days by hand.

**Effect on attendance.** `PgLeaveProvider` and `PgHolidayProvider` answer from the tables (10 s cache per organisation, cleared on every change) and are the providers the engine receives in production. Through the existing engine code: expected seconds are 0, the day is LEAVE or HOLIDAY instead of ABSENT or LATE, the no-clock-in reminder stays quiet, and the live board shows "On leave" for a person without an open session. The daily close and the nightly replay (ADR 026) see the same answers.

**Notifications and audit.** `LEAVE_REQUESTED` goes to the approvers; `LEAVE_APPROVED` or `LEAVE_REJECTED` to the requester (with the note). Every request, decision, cancellation and calendar change is an audit entry.

## Not done here

- Half days and leave balances or entitlements (FR-ORG-010 does not ask for them).
- Planner capacity (FR-TASK-004) still counts holidays and leave days as working days.
- Sri Lanka calendars for years other than 2026.
