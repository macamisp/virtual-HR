# ADR 030: Fresh leave decisions and default calendars on every organisation

Status: Accepted
Date: 2026-10-17
Requirements: FR-ORG-010, FR-ORG-011, FR-ATT-022, FR-ATT-016

The leave workflow, manager approvals, four request types, permission guards, RLS, audit,
HR calendar UI and real attendance providers already existed in the starting revision.
Two regression tests exposed remaining gaps: another API process cached an obsolete leave
or holiday answer for ten seconds, and new organisations had no default calendar.

Read tenant-scoped leave and holidays directly from PostgreSQL on evaluation. Committed
approvals, cancellations and HR calendar edits then affect every process immediately.
A restricted trigger provisions the existing Sri Lanka 2026 calendar for each new organisation;
it does not repopulate calendars HR has edited. The calendar uses the same previously
reviewed dates as ADR 027. Other years still require HR input until a reviewed list is supplied.
The trigger function has a fixed search path and no public EXECUTE privilege; holiday rows
remain protected by forced RLS and the existing HR permission guard.

Demo: run `npm run test:attendance` or `npm run e2e:attendance`. Request sick leave under
Attendance > Leave, approve as the worker's manager under Leave requests, sign the worker
out, and check On leave on the live board. Add a date under Admin > Public holidays. The
API suite checks zero expected hours, suppressed reminders/absence/late flags, cross-process
freshness, tenant isolation, permissions and audit entries.
