# ADR 026: Automated accuracy proofs for attendance (SRS 6.5)

**Status:** Accepted
**Date:** 17 October 2026
**Requirements:** NFR-ACC-001, 002, 003, 004 (SRS 6.5); FR-ATT-002, 003, 010; client HR requirement 7 (SRS 2.7).

## Problem

SRS 6.5 says how each accuracy figure is proven: Playwright timing for clock-in, chaos tests for clock-out, a dual-device simulation and a nightly replay. None of these existed. The only timing assertion allowed 60 seconds for a clock-in, once.

## Decisions

### NFR-ACC-001 and 002 and 003: a Playwright spec against the real stack

`apps/web/e2e/23-accuracy.spec.ts` drives the real web app, API and Postgres, and takes every timestamp from the server. Every measurement is printed, so the CI log carries the numbers, not only pass or fail.

- **Clock-in (001):** 20 sign-ins. The sign-in click (or the notice acceptance, when the gate shows) is the first real activity; the recorded `clock_in_at` must be within 5 s of it, in every run. Between runs the person signs out, which closes the session at once (ADR 025).
- **Clock-out (002):** three scenarios with continuous real input until the event, so the "real last activity" is known to the millisecond: logout, tab close (`context.close()`), network loss (`context.setOffline(true)`). The recorded `clock_out_at` must be no more than 30 s before the last activity. Since the clock-out is the last heartbeat and heartbeats are 30 s apart, the design's worst case is exactly the target; the assertion allows 1 s for timer and network jitter and the ADR records the measured values. Laptop sleep is not emulated separately: from the server's point of view it is the network-loss case (heartbeats stop).
- **Two devices (003):** two browser contexts of one person, both with real input for 70 s. The session's `net_seconds` must not exceed the wall-clock span between the first clock-in and the last heartbeat. The raw per-device counters are printed next to it: they do add up across devices, which is why net time comes from the interval union (FR-ATT-010).

**Time budget.** The e2e organisation uses the shortest windows SRS 6.4 allows (grace 30 s, silence 60 s), and the e2e API runs the reconciler in-process every 5 s. The heartbeat interval stays the real 30 s, because that is what bounds the clock-out error.

### Reconciler without Redis

With `JOBS_ENABLED=false` nothing ran the reconciler, so a dropped session never closed: a real gap for local development, and the reason the chaos tests could not run under Playwright. `ATTENDANCE_RECONCILE_INLINE_MS` (opt-in) runs `attendanceReconcile`, including its FR-ATT-021 notifications, on a timer inside the API when jobs are off. Production keeps the BullMQ scheduler.

### NFR-ACC-004: the nightly replay

- `AttendanceService.computeDailySummary` is the pure recomputation of one person's day from the stored sessions and schedule; the daily close saves its result. `replayDay(orgId, date)` recomputes every person's day and compares it with the stored `attendance_daily` row field by field. It reports and never rewrites. A person with sessions but no row is reported too.
- `attendance-replay` runs every night at 02:30 UTC (BullMQ cron schedule) for yesterday in each organisation's timezone. Any difference sends HR a **critical** notification `ATTENDANCE_REPLAY_MISMATCH` (cannot be muted; once per day through the dedupe key), writes an audit entry with a sample of the differences, and logs an error for the monitoring alerts (ADR 020).
- The replay recomputes from the **stored sessions**, not from the heartbeat log. A heartbeat-level replay would need break, meeting and device events in `presence_events`, which are not recorded today; that remains a gap.

## Measured on 17 October 2026

See the test output quoted in `docs/STATUS.md`, section "Fixed gaps".

## Consequences

- Specs 02–22 run with the e2e organisation's shorter windows; a session that drops during a test closes after 30–60 s instead of 2–3 minutes. The next sign-in starts a new session.
- `SCHEDULES` entries may now carry a cron `pattern` instead of `everyMs`; the BullMQ test checks whichever is set.
