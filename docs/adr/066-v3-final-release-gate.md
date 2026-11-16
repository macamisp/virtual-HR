# ADR 066: V3 final release gate and status-request investigation

Date: 2026-11-17. Status: accepted for local validation; production review remains gated.
Related: FR-VO-003, FR-VO-016, FR-VO-017, FR-TS-003, NFR-REL-001; ADR 052, 064, 065.

## Context

V3's previous release report recorded one unexplained status-save stall (D4) and targeted
reruns after browser test fixes, without a subsequent clean complete run. A passing rerun
cannot establish the cause of a historical stall.

## Decision

- Keep the production implementation and its timeouts unchanged unless a defect is reproduced.
- Exercise the real status HTTP endpoint with a deliberately held user-row lock, an exhausted
  two-connection application pool, and a cancelled blocked query. Verify completion after release,
  HTTP error propagation, transaction rollback, returned connections and successful retry.
- In spec 46, await the status mutation's successful response and the enabled submit control
  before testing its effect. Log only the route, response status and elapsed time.
- Retain D4 as unexplained when the original stalled request lacks correlated browser/server/DB
  evidence. Successful controlled tests and subsequent runs are evidence of tested recovery paths,
  not proof that the original cause has been removed.
- Verify checkers restart recovery explicitly in addition to the existing chess restart test.
- Run the complete browser suite with recording enabled and no retries masking failures. Keep
  scratch databases, backup archives and local evidence. Do not push or deploy.

## Midnight regression

The API gate ran shortly after midnight in Asia/Colombo. The timer auto-stop integration test
backdated a timer by an hour, then expected 55 minutes in its original row. The implementation
correctly split that timer at local midnight. The assertion now totals the auto-stopped pieces
within the exact server-recorded start/end interval. It still requires approximately 55 minutes,
an auto-stopped original row and no remaining running timer. Existing fixed-date unit coverage
verifies the precise midnight boundary independently.

## Consequences

### Concurrent local worktrees

Another worktree began using the default browser-test ports after the repeated V3 checks finished.
The gate refused to replace its servers. `HRVO_E2E_WEB_PORT`, `HRVO_E2E_API_PORT` and
`HRVO_E2E_GOOGLE_PORT` now allow distinct local ports, retaining the original defaults. Configured
URLs also reach the Electron agent, direct attendance-review requests, landing tests and mail-link
checks. `HRVO_E2E_ORG_ID` optionally gives the browser fixtures a distinct validated tenant UUID,
isolating deterministic LiveKit room names and object-storage keys as well. Defaults are unchanged.
The final complete gate uses its own ports and tenant; no other worktree or server is stopped.

The additional tests cover contention, rollback and both board-game kinds without changing
attendance or introducing packages, tables, routes, production diagnostics or operational scripts.
Final counts, measured limits, external-configuration gaps and the release decision are recorded
in `docs/releases/v3-release-candidate-2026-11-16.md`.
