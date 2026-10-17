# ADR 028: Await attendance closure after auth revocation

Status: Accepted
Date: 2026-10-17
Requirements: FR-ATT-002, FR-ATT-003, NFR-ACC-002

Logout, password reset, and administrative role changes previously depended exclusively on
Postgres NOTIFY to close attendance. A missed notification left attendance open until the
normal timeout; the regression test reproduces OPEN/ACTIVE after 900 ms.

After committing revocation, these API operations now await the same idempotent attendance
close used by the listener. Clock-out remains the last valid server heartbeat with source
LOGOUT. Notifications continue to disconnect sockets on other API processes. Another valid
login with recent heartbeats preserves attendance; ordinary tab disconnect keeps the grace
window. Auth-session revocation semantics remain subject to the owner's shared-tab clarification.

Demo: run `npm run build`, then `node --test dist/apps/api/test/attendance-logout-e2e.test.js`
with local Docker Compose PostgreSQL configured via PG*. The missed-notification scenario
prints its latency and requires closure within 1 s.

Follow-up regression: with the listener suppressed, an already authenticated socket could
submit a heartbeat using a cached secret after logout and reopen attendance. The gateway now
checks live login status on every heartbeat and binds its session ID to the authenticated
socket. The password reset test uses two live logins and verifies both are refused afterward.

The SRS-listed administrative DELETE /auth/sessions/:id was absent. It now validates the UUID,
requires users.manage, scopes lookup and revocation with RLS, audits SESSION_REVOKED, and
awaits attendance closure after commit. The test checks denial for ordinary workers,
cross-tenant invisibility, the audit row, and the one-second limit with NOTIFY suppressed.
