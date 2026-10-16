# Load and accuracy test (SRS 6.5, NFR-ACC-001..004)

Everything here runs against a **dedicated** API instance and database, never the demo or test ones.

## 1. Prepare

```sh
# Database (same Postgres container as the test suite)
podman exec hrvo-pg-tasks psql -U postgres -c "CREATE DATABASE hrvo_load"
DATABASE_URL=postgresql://postgres:postgres@localhost:5544/hrvo_load DIRECT_DATABASE_URL=$DATABASE_URL npm run db:migrate
PGDATABASE=hrvo_load npm run db:provision-roles            # needs PGPASSWORD / PGRETENTION_PASSWORD
PGDATABASE=hrvo_load node --experimental-strip-types apps/api/test/seed-load.ts 200

# API instance on :3102 with jobs enabled (reconciler every 15 s) and its own Redis db
npx tsc
PORT=3102 PGDATABASE=hrvo_load DATABASE_URL=postgresql://hrvo_app:...@localhost:5544/hrvo_load \
  JOBS_ENABLED=true REDIS_DB=2 RATE_LIMIT_LOGIN=1000 CORS_ORIGINS=http://localhost:3000 \
  node dist/apps/api/src/main.js
```

`RATE_LIMIT_LOGIN` is raised only because all 220 sign-ins come from one IP; the heartbeat limit (10/min per user) stays at its default, so the test runs under production limits.

## 2. Run

```sh
mkdir -p load/out
podman run --rm --network host --user 0 -v ./load:/scripts:Z docker.io/grafana/k6:latest run \
  -e API=http://localhost:3102 -e USERS=200 -e PHONES=20 -e DURATION=15m /scripts/heartbeat.js
```

Each virtual user signs in as its own seeded account, opens a raw WebSocket to the Socket.IO endpoint, authenticates in the CONNECT packet, and sends a signed heartbeat every 30 s. VUs above `USERS` are "phones": a second device for users 1..`PHONES`, which exercises multi-device merging (NFR-ACC-003). The summary lands in `load/out/summary.json`.

Metrics:

| Metric | Meaning |
| --- | --- |
| `heartbeat_ack` | round trip from sending a heartbeat to the server's acknowledgement (p95 threshold 500 ms) |
| `heartbeat_errors` | heartbeats the server rejected or that failed in transport (threshold < 1 %) |
| `clockin_latency` | the first acknowledgement per connection: the server created or resumed the session at that moment (NFR-ACC-001, threshold p99 < 5 s) |
| `heartbeats_unacked_at_close` | acks still in flight when a VU closed its socket (informational) |

## 3. Verify accuracy

Wait until the disconnect grace window (120 s) plus a reconciler tick (15 s) has passed, then:

```sh
PGDATABASE=hrvo_load node --experimental-strip-types load/verify-accuracy.mjs load/out/summary.json
```

It prints PASS/FAIL for NFR-ACC-001 (from the k6 summary), ACC-002 (every session closed at its last heartbeat, within 30 s after grace), ACC-003 (two-device users have one flagged session, nobody's net time exceeds the wall clock, no overlapping sessions) and ACC-004 (daily totals recomputed twice are identical and match the stored row and the session sum).

## 4. Clean up

Stop the API instance and `DROP DATABASE hrvo_load`. Redis db 2 only holds the BullMQ queue state.

## Virtual office (FR-VO-013, NFR-PERF-003)

Same database and API instance as above (the 200 seeded users), then:

```sh
podman run --rm --network host --user 0 -v ./load:/scripts:Z docker.io/grafana/k6:latest run \
  -e API=http://localhost:3102 -e USERS=200 -e DURATION=5m /scripts/office.js
```

Each virtual user joins the office over its own socket (`purpose: 'office'`), walks along the reception–lounge corridor at 10 Hz in bursts, and records `position_latency` (mover's send time echoed by the server → observer receipt; one machine clock). Results: `load/out/office-summary.json`; numbers in ADR 015 §10. The render bench: `OFFICE_BENCH_GPU=1 npx playwright test e2e/16-office.spec.ts -g bench --headed` in `apps/web`.
