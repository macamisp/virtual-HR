# ADR 029: Prove daily totals against raw attendance inputs

Status: Accepted
Date: 2026-10-17
Requirements: NFR-ACC-001, NFR-ACC-002, NFR-ACC-003, NFR-ACC-004; FR-ATT-002

The previous replay summed materialised session counters. Corrupting both a session and its
daily total by seven seconds passed replay. The new regression reproduces this failure.

Persist accepted heartbeat counters and each break, meeting, disconnect, reconnect, challenge,
clock-out, midnight, correction and offline action as append-only ATTENDANCE_INPUT events in
presence_events. Each event carries the attendance policy used at ingestion and server time;
no auth token, HMAC secret, signature, nonce, or document content is recorded. Session,
segments and input are committed in one RLS transaction. The existing raw-event UI keeps its
human-readable heartbeat/action list without showing internal replay inputs twice.

Replay reads the full input stream in database insertion order (not timestamp order: logout
is backdated to the last heartbeat), follows midnight parent sessions, and runs the pure state
machine. It compares daily aggregates field by field without changing saved data. Missing or
incomplete historical input is reported as a coverage mismatch, never certified from session
counters. The existing nightly BullMQ job alerts HR and audits these mismatches too. Users
created after the target day are excluded unless they already have attendance data that day.
Historical sessions cannot acquire missing raw history retroactively.

The browser proof now measures 100 clock-ins, enforces the 99% sample target, enforces the
30-second clock-out timestamp bound without the previous extra second, and requires net time
to equal the segment interval union on two devices. Closure detection and timestamp error are
printed separately: the 120-second production disconnect grace remains valid. CI preserves
API and Playwright measurement logs on both passing and failing runs.

Demo with local Compose services and PG* configured:

1. `npm run test:attendance` prints API latencies, raw replay equality and injected drift.
2. `npm run e2e:attendance` prints every clock-in sample, chaos timing and device-union totals.
3. The nightly replay regression injects drift and checks the HR notification and audit entry.

The offline replay uses the original server-anchored intervals and the covered spans used
when validating that batch. Segment wall time is not a substitute for its active/idle counters:
a regression with 12 active and 48 idle seconds proves both counters replay exactly.
