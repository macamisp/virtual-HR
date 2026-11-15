# Release readiness: Arcade redesign, Avatar Nudge, HR Attendance Analytics

Date: 2026-11-15. Branch `feature/hr-attendance-analytics`, tested at commit `56dbc6c` (this report is
the only later commit). Local only: not pushed, no PR, not deployed, production database untouched.

**Verdict: ready for a production rollout decision.** Every required check passed on the final
code. Rollout itself needs separate approval and the steps under "Production prerequisites".

## Scope

| Commit | Feature | Requirement | ADR |
|---|---|---|---|
| `41ee495` | Arcade pixel-art redesign (paint only) | FR-VO-015 | 057 |
| `930342a` | Avatar nudge (bell, Accept/Ignore, sound, server rules) | FR-VO-016 | 058 |
| `56dbc6c` | HR attendance analytics and office connection intervals (one additive migration) | FR-REP-009 | 059 |
| `5fff5aa`, `1326c6f`, `2b040b3` | Test corrections (hug timing, arcade walk, table stop tolerance) | — | — |
| `9ffe8e0` | Arcade + nudge QA report | — | — |

Since `ae64cda`, nothing changed in authentication, the attendance state machine, attendance
service or gateway, dependencies (`package.json`, lockfile), Docker Compose files, `infra/` or CI.

## Final browser regression (commit `56dbc6c`)

Run 2026-11-15 17:59–18:48 (+05:30), `systemd-inhibit --what=idle:sleep`, LiveKit Egress running,
`LIVEKIT_EGRESS=1`, API built from the commit.

| Result | Count |
|---|---|
| Passed | **137** |
| Failed | 0 |
| Skipped | 0 |
| Did not run | 0 |
| Spec files | 47 / 47 |

No clock jump or network loss was recorded by chronyd during the run. Feature specs included:
22 (meeting recording, 2 tests), 43 (environment and arcade), 44 (campus), 45 (avatar actions),
46 (nudge), 47 (attendance analytics); 21 tests in those files, all passed. Office benchmarks
(headless): 200 avatars 20 fps, 0.57 ms script per frame; 41 avatars 30 fps, 0.17 ms.

No source code was changed for this run.

## Other evidence (same code for the API)

| Check | Result |
|---|---|
| Full API suite (`dist/apps/api/test/*.test.js`) | 1053 / 1053, none skipped |
| Root and web typecheck, root and web lint, production web build | pass |
| `prisma validate`; `prisma migrate diff` against the migrated local database | valid; no drift |
| Migration rehearsal on a scratch copy (up, checks, drift, down, up, checks, drift) | pass |
| Route-permission gate for the new routes | OK (8 pre-existing routes flagged for review, unchanged) |

The API suite ran on the tree that became `56dbc6c`; the only change after it was one web link
label ("your attendance analytics page"), retested by specs 02, 47 and the all-pages sweep, and
now by this full run.

## Feature checks

| Area | Evidence |
|---|---|
| Arcade | Map fingerprints and object ids unchanged; 8 textures; doorways walkable; desktop, phone, reduced motion (spec 43) |
| Nudge | Server rules (reach, DND, away, cooldown, 6/min, one pending, no self, organisation isolation, disconnect) in API tests; two browsers, keyboard, touch, sound, reduced motion (spec 46) |
| Attendance analytics | Three measures kept apart; merged intervals; Colombo midnight and DST; owner/HR/auditor/manager/employee/other-org permissions with 404 rules; audited exports; retention; data export and anonymisation (API tests); HR, manager, employee, empty/error states, phone (spec 47) |
| Existing HR workflows | Specs 01–42 (auth, 2FA, attendance accuracy, leave, timesheets, documents, vault, e-sign, meetings, calls, recording, office, reports) all passed |

Screenshots: `docs/assets/office-arcade/`, `docs/assets/office-nudge/`,
`docs/assets/release-2026-11-15/`, `docs/assets/attendance-analytics/`.

## Production prerequisites (not done)

1. Owner approval for the rollout and for the production database migration.
2. Push the branch and get a green CI run on the exact commit (CI has not run on these commits).
3. Encrypted production backup, verified, before anything else.
4. Apply migration `20261115000000_office_presence_intervals` with the release migrate image
   **before** the new API image starts: the new API writes this table on every office join. Production
   is at 37 migrations; this makes 38.
5. Deploy the API and web images; record rollback tags.
6. Optional: run `scripts/office-map-upgrade.ts` (owner) so the production workspace gets the campus
   map and with it the arcade.
7. Rollback: previous API and web images first, then
   `apps/api/prisma/rollback/20261115000000_office_presence_intervals.down.sql` (loses office
   connection intervals only).

## Known limitations

- The office world, its nudges and its interval writer run on one API instance (ADR 015).
- Office connected time may be short by up to about a minute after a crash; never over-counted.
- Analytics are computed per request (366 days at most); a very large organisation may later want
  a stored daily summary.
- "Department" is the team; employees export their own records through My data.
- The "Arcade" room label is partly behind the first cabinet (pre-existing renderer layout).
- Long browser runs on this laptop must hold a sleep inhibitor; spec 22 needs the optional Egress
  container and `LIVEKIT_EGRESS=1`.
