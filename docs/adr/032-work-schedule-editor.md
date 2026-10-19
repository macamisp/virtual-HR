# ADR 032: Work schedule editor and schedule rules in the compliance engine

**Status:** Accepted
**Date:** 19 October 2026
**Requirements:** FR-ORG-005 (fixed or flexible hours, working days, expected daily hours, break allowance, grace for late arrival and early leave), FR-ATT-014 (compliance), NFR-ACC-004 (replay). SRS 7.4 `work_schedules`.

## Problem

`work_schedules` existed and the compliance engine read it, but there was no screen or API to edit it, and the engine had four gaps:

1. It ignored `effective_from` / `effective_to`: with two versions it used an arbitrary one, and an ended schedule still applied.
2. It ignored `flexible`: flexible schedules were flagged late and early.
3. One `grace_minutes` served late arrival and early leave.
4. There was no break allowance.

The dashboard's late-arrival list and planning capacity each read schedules with their own, slightly different SQL.

## Decision

- **Schema** (migration `20261103000100`): `early_leave_grace_minutes` (null = same as `grace_minutes`, so existing schedules behave as before), `break_allowance_minutes` (null = no limit), `attendance_daily.excess_break_minutes`. CHECKs: grace 0–240, allowance 0–600, `effective_to >= effective_from`, and a schedule belongs to a person *or* a team, never both (SRS 7.4 "one of the two"). `grace_minutes` stays the late-arrival grace.
- **Which schedule applies on a day:** the person's own, else their team's, else the organisation default; within one level, the latest version in force on that date. `findWorkScheduleForUser(org, user, onDate)`, the dashboard and planning now use the same rule.
- **Engine:** flexible hours keep expected hours and absence but never flag late arrival or early leave. Early leave uses its own grace. Break allowance is **flag only** (owner's decision, 19 October 2026): break time already is outside net time; when a working day's breaks exceed the allowance the day gets `EXCESS_BREAK` and `excess_break_minutes`. Net time does not change.
- **Replay:** the compared fields are one exported list, `REPLAY_FIELDS`, now including `excessBreakMinutes`. A test asserts that every computed field of a day is in it, so a future field cannot escape the nightly check.
- **Editor:** `GET /schedules`, `PUT /schedules`, `POST /schedules/end`, permission `schedules.manage` (new; super admin, admin, HR manager, HR). Versions of one scope never overlap: a change starts on a date, **today or later**; versions that would start on or after it are replaced and the running one ends the day before. Past days keep the schedule they were computed with, so stored days and the replay stay consistent. A change from today recomputes today's stored days at once. Each change takes an advisory lock per scope and is audited (`SCHEDULE_SET`, `SCHEDULE_ENDED`, before/after).
- **Screens:** `/admin/schedules` (organisation default, team or person; shows which schedule a person works to today); the live board shows "Break over allowance"; "My days" shows "Break +N m".

## Consequences

- Overnight shifts are not supported (a day must end after it starts); the engine places a day's start and end on the same date.
- A team schedule follows a person's *current* team. Moving someone to another team changes the schedule for future days only, since past days are stored.
- On the live board the allowance is looked up only for people with break time today, so a large board does not run one schedule query per person.
