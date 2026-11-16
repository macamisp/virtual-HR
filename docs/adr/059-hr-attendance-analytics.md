# ADR 059: HR attendance analytics and office connection intervals

Date: 2026-11-15. Status: proposed (built and tested locally on `feature/hr-attendance-analytics`; not pushed, not deployed; the migration is applied to the local development database only).
Related: FR-REP-009, FR-REP-002, FR-REP-008, FR-ATT-010, FR-ADM-004, FR-AUD-003; ADR 013 (reports), 015 (office), 048 (office presence and the reload grace), 049 (verified meeting time).

## Context

HR and workspace owners want one view of how people work: verified work attendance, time in the
virtual office and time in meetings. Two of these exist already (attendance sessions and daily
summaries, server-confirmed meeting segments). Office presence lives only in memory: when the API
restarts or a person leaves, nothing remains. The view must not mistake being signed in, or being
in the office, for work, must not count anything twice, must follow the organisation's calendar
day, and must not become surveillance of where people go or what they do in the office.

## Decision

### 1. Three measures, never added together

| Measure | Source | Notes |
|---|---|---|
| **Verified work attendance** | `attendance_sessions` per person and work date, adjusted and cancelled sessions left out, summed as `computeDailySummary` does (first check-in, last check-out, net, active, break, meeting); status, late and early leave from `attendance_daily` | The only measure that is work time. A day with an open session is `IN_PROGRESS`; a finished day without a daily summary yet is `NOT_SUMMARISED`; days with only a summary (leave, absence, holiday) are shown with their status. |
| **Office connected time** | `office_presence_intervals` (new) | Not work time. Merged per person (several tabs, reconnects and duplicate rows count once), then cut at organisation-local midnights with the IANA timezone (a 23 h or 25 h day across a daylight-saving change). An open interval counts up to its `last_seen_at`, never later. |
| **Confirmed meeting time** | `meeting_seconds` of the same sessions (ADR 049 in-meeting segments), capped at work time as the work-time report does | Part of work time. The person detail lists meetings from `meeting_participants`, each person's connections to one meeting merged (a reconnect counts once), a connection whose end was never received capped at the meeting's end or now and flagged. |

The API returns them as separate fields; the UI shows them in separate columns with a
definitions panel ("Office connected time … is not proof of work and is never added to work
time"). Nothing in the code sums them.

### 2. Schema (one additive migration, `20261115000000_office_presence_intervals`)

```
office_presence_intervals
  id            uuid PK default gen_random_uuid()
  org_id        uuid NOT NULL → organizations ON DELETE CASCADE
  user_id       uuid NOT NULL → users ON DELETE CASCADE
  started_at    timestamptz NOT NULL
  ended_at      timestamptz NULL
  last_seen_at  timestamptz NOT NULL
  end_reason    varchar(16) NULL  CHECK IN ('LEFT', 'DROPPED', 'SERVER_RESTART')
  created_at    timestamptz NOT NULL default now()
  CHECK ended_at IS NULL OR ended_at >= started_at
  CHECK last_seen_at >= started_at
  CHECK (ended_at IS NULL) = (end_reason IS NULL)
  INDEX (org_id, user_id, started_at)
  UNIQUE (org_id, user_id) WHERE ended_at IS NULL     -- one open interval per person
  ENABLE + FORCE ROW LEVEL SECURITY; policy org_id = current_setting('app.org_id')
  hrvo_app: SELECT, INSERT, UPDATE (DELETE and TRUNCATE revoked)
  hrvo_retention: SELECT, DELETE
fn_close_stale_office_presence(p_stale_before timestamptz) → integer
  SECURITY DEFINER, search_path public, EXECUTE to hrvo_app only: closes open intervals last seen
  before the cutoff, at their last_seen_at, reason SERVER_RESTART (the only cross-tenant write)
```

No existing table or column changes. There is no room, position, desk, game, nudge or avatar
action column, and a test checks the column list.

### 3. Office connection lifecycle (server clock only)

`OfficePresenceStore` (`apps/api/src/office/office-presence.ts`) is driven by the office world's
own avatar lifecycle, never by the 10 Hz movement stream. One avatar per person, so one interval
per person however many tabs.

| Event | Interval |
|---|---|
| First office socket joins (no avatar yet) | opened at now |
| Another tab joins, or a tab closes while others remain | unchanged, nothing written |
| Last socket drops | nothing written yet; the drop time is kept on the avatar (ADR 048 grace, 8 s) |
| The same sign-in rejoins within the grace (a reload) | the same interval continues: the few seconds of the reload are **included** (bridged) |
| The grace runs out, or a new sign-in replaces the avatar | closed at the **drop time**, `DROPPED`: the grace is **excluded** |
| The person leaves the office (or the grace is 0) | closed at now, `LEFT` (or `DROPPED`) |
| Every minute | `last_seen_at` = now for everyone connected, one UPDATE per organisation |
| API stops or crashes | the interval stays open with a `last_seen_at` at most about a minute old |
| The person connects again after a restart | the leftover is closed at its `last_seen_at`, `SERVER_RESTART`; a new interval opens |
| Startup, and every minute | intervals not refreshed for 3 minutes are closed at their `last_seen_at`, `SERVER_RESTART` |

So a reload never splits or ends an interval, a real disconnection never counts its grace, and a
crash never counts beyond the last time the server saw the person (at most about 60 s are lost).
The sweep only closes intervals unrefreshed for 3 minutes, so it never closes one another live
process keeps fresh. Writes are queued per person, so an open never overtakes the close before it.
Every failure is caught, counted (`stats.failures`) and logged with the error code only; joining,
moving and every HR operation continue. Attendance recording is not touched.

### 4. API

| Route | Guard | Purpose |
|---|---|---|
| `GET /reports/attendance-analytics` | `reports.team` or `reports.all`; CSV/XLSX/PDF also `attendance.export` | Summary, rows per person and day/week/month, paging (≤ 200), sorting (date, name, work, office, meeting), team and person filters, the people and teams in scope for the filters |
| `GET /reports/attendance-analytics/people/:userId` | `reports.team` or `reports.all`, then `attendance.read.all`, or `attendance.read.team` for a direct report or team member; anyone else, or nobody, is 404 | One person: days, weeks, months, total, attendance segments (state and times only), office intervals, meetings, correction requests (status and times, no reason text) |
| `GET /attendance/me/analytics` | `attendance.read.own` | The same detail for oneself, with meeting titles |

Strict Zod queries (`from`, `to`, at most 366 days; unknown keys refused). Scope uses the existing
`reportScope`/`scopeSql`; every query runs in the tenant context under RLS. Meeting titles appear
only to the person themselves, as in `MeetingTimeService`. Exports use the existing
`exportTable` and are audited as `REPORT_EXPORTED` with the report name, format, filters and row
count. Employees export their own records through the existing personal data export.

### 5. Permission matrix

| Who (built-in role) | Dashboard | Person detail | Export | Own detail |
|---|---|---|---|---|
| Owner (super admin), Admin, HR manager, HR | organisation | anyone in the organisation | yes | yes |
| Auditor | organisation | anyone | yes | yes |
| Manager, Team lead | self, direct reports, own team | those people; anyone else 404 | no | yes |
| Employee, Subcontractor, Intern | no (403) | no (403, before any lookup) | no | yes |

The owner flag gives nothing by itself: an owner is always a super admin (an existing database
constraint), and access comes from the resolved permissions only, including custom roles.

### 6. Interface

- Reports → **Attendance analytics** tab: period presets (today, this week, last week, this month,
  last month, custom), team, person, day/week/month; four summary figures; a sortable (mouse and
  keyboard, `aria-sort`), paged table; export buttons only for `canExport`; the definitions panel;
  a note when office data before a date has been deleted by retention.
- `/reports/attendance-analytics/[userId]`: the person page (totals, weekly and monthly summaries,
  days, attendance timeline, office connections, meetings, correction requests).
- My attendance: a "Work, meetings and office time" card (this week, this month) and
  `/attendance/analytics`, the same person page for oneself.
- "What we collect": a "Virtual office connection times" section, and "where you go or what you do
  in the virtual office" in the never-collected list.
- Times are shown in the organisation's timezone. Loading, empty, error and access-denied states
  use the existing components.

### 7. Retention and privacy

Office intervals follow the organisation's presence retention (`retention_presence_days`, default
90): the daily presence-retention job deletes intervals that ended before the cutoff, through the
retention role; an open interval is never deleted. Attendance retention is unchanged. The personal
data export lists the person's intervals (`attendance.officeConnections`); anonymisation lists and
deletes them with the raw presence events. Reports state the first day office data can exist for
(`officeDataFrom`).

## Local migration and rollback

- Verified target before any change: the local podman Postgres (`hrvo-pg-tasks`, `localhost:5544`,
  PostgreSQL 16 Alpine), database `hrvo_demo`; no Supabase or remote host in `.env`.
- Rehearsed on a scratch copy (`hrvo_mig_rehearsal`, created from `hrvo_demo` and dropped
  afterwards): up, constraint and RLS checks as `hrvo_app`, `prisma migrate diff` (no drift),
  rollback, re-apply, checks and diff again; attendance row counts unchanged throughout.
- Applied to `hrvo_demo` with `npm run db:migrate` (37 → 38 migrations).
- Rollback (`apps/api/prisma/rollback/20261115000000_office_presence_intervals.down.sql`, as the
  schema owner, after the previous API version is running): drops the function, the table and its
  migration record. Only office connection intervals are lost.
- Production (Supabase) is untouched. A production rollout needs its own approval, the encrypted
  backup first, `migrate deploy` with the release migrate image, and the web and API images.

### Hardening migration `20261116000000_office_presence_security`

A follow-up migration (the first one stays immutable for databases that already applied it):

- `users (org_id, id)` is unique, and an interval's person must belong to the interval's
  organisation (`FOREIGN KEY (org_id, user_id) REFERENCES users (org_id, id)`). A cross-tenant row is
  rejected even for the schema owner, below RLS.
- `fn_close_stale_office_presence` qualifies its table, puts `pg_temp` last in its search path (a
  caller's temporary table cannot shadow the target), and never closes an interval seen in the last
  3 minutes, whatever cutoff the caller passes (a future cutoff cannot close live intervals across
  organisations). The API already passes `now − 3 min`, so its behaviour is unchanged.
- Rollback: `apps/api/prisma/rollback/20261116000000_office_presence_security.down.sql` restores the
  single-column key and the original function; no interval is lost. Run it before the
  `20261115000000` rollback, never after.
- 2026-11-16, local: rehearsed on a restored copy of `hrvo_demo` (up, no drift, down, up, no drift;
  73 intervals kept), then applied to `hrvo_demo` (38 → 39) after a local `pg_dump` backup.
  `office-presence-security.test.ts` 4/4, with the presence and analytics suites 23/23.

## Consequences

- One more write per person per office join and leave, and one UPDATE per organisation per minute.
- Office time is approximate by up to a minute after a crash (by design, never over-counted).
- The office, and so this table's writer, is single-instance (ADR 015 §4); the sweep is safe with
  more processes, the in-memory world is not.
- Aggregation runs per request over the range (366 days at most, indexed by organisation, person
  and date). A very large organisation over a full year may want a summary table later.
- Tests:
  - `apps/api/test/attendance-analytics-days.test.ts` (unit): merging, Asia/Colombo midnight,
    Europe/London and America/New_York daylight saving, open intervals and stale observations,
    grouping and summary, range and query validation;
  - `apps/api/test/office-presence-e2e.test.ts` (socket): startup recovery, tabs, reload within
    the grace, drop (grace excluded), leave, refresh, sweep, restart leftovers, database failure,
    cross-organisation RLS, column list, no attendance written;
  - `apps/api/test/attendance-analytics-e2e.test.ts` (API): values, grouping, paging, sorting,
    filters, owner, HR, auditor, manager, employee and another organisation, 404 rules, exports
    and their audit, validation, retention, data export and anonymisation;
  - `apps/web/e2e/47-attendance-analytics.spec.ts` (browser): HR dashboard and detail, manager,
    employee, empty and error states, phone layout, keyboard sorting, exports.

## Test evidence (2026-11-15, local)

| Check | Result |
|---|---|
| Root and web typecheck, root and web lint, production web build | pass |
| `prisma validate`; `prisma migrate diff` against the migrated local database | valid; no drift |
| Migration rehearsal on a scratch copy: up, checks, drift, down, up, checks, drift | pass |
| New API tests: unit 7, socket 9, API 10 (plus the port guard) | 27 / 27 |
| Full API suite | 1053 / 1053, none skipped |
| Full Playwright suite (with LiveKit Egress, under a sleep inhibitor) | 136 passed, 1 failed: spec 02, whose `link 'My attendance'` matched the new "My attendance analytics" link on "What we collect". The link text was changed to "your attendance analytics page"; spec 02 (4/4), spec 47 (5/5) and the all-pages console sweep of spec 38 then passed |
| 200-avatar office benchmark (headless) | 12 fps, 0.86 ms of script per frame (noisy; no movement-path change) |

Screenshots (desktop 1440 x 900 and phone 390 x 844) are in `docs/assets/attendance-analytics/`.
