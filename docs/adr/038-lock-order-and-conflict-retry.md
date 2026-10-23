# ADR 038: One lock order for tenant data; bounded retry of deadlocked transactions

**Status:** accepted (2026-10-23)
**Requirements:** NFR-ACC-001..004 (attendance writes must not be lost), FR-AUD-001 (audit hash
chain), FR-ATT-002 (disconnect grace), FR-ADM-001 (policy changes). Supersedes the note in
`docs/STATUS.md` that called the CI deadlock "existing, load-dependent".

## Context

CI run 39875211625 (2026-10-23) failed with `deadlock detected` (40P01); the re-run passed.
Postgres logged two deadlocks in that run, both with the same pair:

```
00:00:43 Process 240: DELETE FROM organizations WHERE id = $1                (attendance-self-service-e2e teardown)
         Process 252: INSERT INTO presence_events (...)                       (attendance session save)
         CONTEXT: while deleting tuple (0,57) in relation "attendance_sessions"
00:01:38 Process 445: INSERT INTO presence_events (...)                       (attendance session save)
         Process 416: DELETE FROM organizations WHERE id = ANY($1::uuid[])    (another suite's teardown)
         CONTEXT: while locking tuple (0,7) in relation "organizations" ... FOR KEY SHARE
```

Lock order of each transaction:

| Transaction | Order |
| --- | --- |
| Attendance session save (`saveSession`: heartbeat, disconnect, reconciler, break, logout) | 1. session row (upsert; the UPDATE path takes no parent lock) → 2. segment rows → 3. `INSERT presence_events`, whose foreign-key check takes **FOR KEY SHARE on the organisation and the person** |
| Organisation delete (test teardown, cascade) | 1. **organisation row** (exclusive) → 2. cascade into `attendance_sessions` rows |
| Audit append (`appendAuditEntry`, `recordAuditLog`) | 1. **audit advisory lock** (per organisation) → 2. `INSERT audit_logs`, FK check takes **FOR KEY SHARE on the organisation and the actor** |
| Policy, guards, organisation profile (`admin.service`, `ownership.service`) | 1. **organisation row FOR UPDATE** → 2. update → 3. audit advisory lock |
| Anonymisation, status change, role change, leave, calls, Google unlink | 1. **person row FOR UPDATE** → 2. that person's child rows (e.g. `attendance_sessions`) → 3. audit advisory lock |
| Reconciler vs. heartbeat (same person) | serialised before the database by the per-person queue (`withSessionLock`, Redis lock across tasks); never concurrent |
| Daily close | one upsert of `attendance_daily` (single statement) |
| Notifications | `FOR UPDATE SKIP LOCKED` on notification rows only; no parent or attendance lock |

`FOR UPDATE` and the organisation delete conflict with `FOR KEY SHARE`; `FOR NO KEY UPDATE`
does not. So three cycles exist:

1. **Session save vs. a delete or a person/organisation FOR UPDATE** that then touches the same
   person's sessions (CI: the teardown delete; production: anonymisation of a person whose session
   is being saved, `attendance_sessions` updated after `users FOR UPDATE`).
2. **Organisation settings write vs. any audit append in that organisation**: the writer holds the
   organisation row and wants the audit lock; the appender holds the audit lock and wants
   `KEY SHARE` on the organisation. Pure production code, no test involved.
3. Same as 2 with a person row: a status/role change of a person vs. an audit append whose actor
   is that person.

Heartbeats, the reconciler and audit appends do not deadlock with each other: their parent locks
are all `KEY SHARE` (mutually compatible) and per-person work is queued. A third party holding a
strong lock on a parent row is always required, which is why the failure looked "load-dependent".

Why a test teardown met a live attendance write: the attendance repository has its own pools, and
`app.close()` neither waited for the socket disconnect handlers (which save the session) nor
closed those pools. The disconnect write outlived the app and ran into the next statement, the
suite's `DELETE FROM organizations`. In production the same gap loses DISCONNECT inputs on a
rolling deploy.

**Deterministic reproduction.** `apps/api/test/lock-order.test.ts` drives each pair into the exact
interleaving by waiting on `pg_blocking_pids`, not on time. Before this change, against the
same code with the old lock semantics: scenarios 1-4 each `deadlock detected`; scenario 5 (40
rounds of 2 heartbeats + reconciler + attendance audit + settings write + person write + daily
recompute, same person and organisation) **103 deadlocks** in 68 s.

## Decisions

1. **One lock order** (`apps/api/src/common/lock-order.ts`):
   1. parent rows first: the organisation, then people in ascending id, at the strength the
      transaction needs, never upgraded later;
   2. then the audit-chain advisory lock;
   3. then child rows.
2. **Parent rows are never locked FOR UPDATE.** `lockOrgForWrite` and `lockUsersForWrite` use
   `FOR NO KEY UPDATE`, as do the remaining inline person locks (status, profile, role, ownership,
   Google unlink, calls, leave, anonymisation). No code changes a key column of `organizations` or
   `users` (their unique indexes are the primary keys and the organisation slug, never updated), so
   `FOR NO KEY UPDATE` gives the same mutual exclusion between writers while no longer blocking
   foreign-key checks. Test 8 fails if `FOR UPDATE` on either table comes back.
3. **Writers of child rows take their parent `KEY SHARE` locks first** (`lockTenantParents`):
   the session save before the session row; the audit append (both implementations) before the
   advisory lock. If something does hold a strong parent lock (a delete), they wait holding
   nothing.
4. **Bounded retry** (`apps/api/src/common/db-retry.ts`, `withConflictRetry`): only SQLSTATE
   40P01 and 40001, at most 3 attempts, short jittered back-off, and only around whole
   transactions that are idempotent: `attendance.saveSession` (upserts of a precomputed state; the
   session-closed listeners run once, after the commit), `audit.append` (a rolled-back attempt
   leaves no link, the retry chains to the current end), `attendance.saveDaily` (one upsert). Never
   around `PrismaService.runWithTenantContext` in general: its callbacks may send e-mail or call
   other systems. Each retry is counted (`conflictRetryStats()`) and logged as one JSON line
   without parameters: `{"event":"db_conflict_retry","op":"attendance.saveSession","kind":"deadlock","code":"40P01","attempt":1,"maxAttempts":3}`.
   The tests assert the retry count stays at zero, so a lock-order regression cannot hide behind it.
5. **Shutdown drains attendance work.** `AttendanceService.trackWork` registers every per-person
   operation and every socket disconnect handler; `onApplicationShutdown` (after Nest closed the
   socket server) waits for them, at most 5 s (`attendance_drain_timeout` logged otherwise), then
   closes the repository pools, so nothing writes after `app.close()` returns.

## Consequences

- After the change: scenarios 1-4 commit without a deadlock; scenario 5 runs 40 rounds in about
  3 s with zero deadlocks, zero retries, every audit append committed and the hash chain intact;
  repeated 5 times locally. Full API suite 838/838; NFR-ACC-002/004 measurements unchanged.
- A policy or person write no longer stalls every heartbeat and audit append of that organisation
  or person for its duration.
- New code that locks an organisation or person row uses the helpers; new code that writes child
  rows and then audits keeps parent → audit lock → child order.
- No metrics library exists in the API (adding one needs approval); the retry counter is in-process
  and the JSON log line is the operational signal (CloudWatch metric filter on
  `"event":"db_conflict_retry"`).
- The first CI run of this change was cancelled by an unrelated clash: `totp-replay` and
  `vault-e2e` both listened on 3097, and `google-signin-e2e`'s fake Google shared 3085 with
  `attendance-guards-e2e` (both pairs came with ADR 037). They now use 3043 and 3044, and
  `test/test-ports.test.ts` fails whenever two test files bind the same port.
