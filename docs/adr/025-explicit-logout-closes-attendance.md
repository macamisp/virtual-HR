# ADR 025: Explicit logout closes the attendance session at once

**Status:** Accepted
**Date:** 17 October 2026
**Requirements:** FR-ATT-002 (auto clock-out on explicit logout), FR-ATT-003 (server clock), SRS 6.2 row 14, NFR-ACC-002.

## Problem

`AttendanceService.onExplicitLogout` existed, but nothing called it. `POST /auth/logout` only revoked the login; the attendance session then went through the socket-disconnect path and closed 120 seconds later with source DISCONNECT. The same happened after a password reset or an administrative revocation.

## Decision

**Where.** Every revocation of a login already reaches every API task as a Postgres `NOTIFY` on `hrvo_auth_events` (ADR 004, 005): logout, password reset, family-reuse detection, a role change that needs a fresh sign-in, deactivation. The attendance gateway handles that notification, so the attendance close is wired there, in `closeAttendanceOnRevocation`. No module coupling between auth and attendance is needed, and a logout from any client, with or without an open socket, has the same effect.

**When it closes.** The session closes unless another still-valid login of the same person keeps an attendance socket open: a second device, or the desktop agent (ADR 018). Tabs of the revoked login cannot keep it open, because their login is gone and their session secret is deleted with it. Office-purpose sockets (ADR 015) do not count. The check uses the socket server's user room, which is cluster-wide under the Redis adapter (ADR 020).

**Clock-out time.** The session closes at the **last valid heartbeat** with source `LOGOUT`, like rows 12 and 13 of the state machine. Nothing after the last heartbeat is credited, because nothing after it was observed. Row 14 of SRS 6.2 says "close session immediately"; this is read as the latency, not the timestamp. The owner should confirm that reading and update the SRS wording.

**Tab close** is unchanged: a socket disconnect without a revocation starts the grace window as before.

## Measured (test/attendance-logout-e2e.test.ts)

| Event | Session closed after |
| --- | --- |
| `POST /auth/logout` | 56 ms |
| Password reset | 101 ms |
| Administrative revoke (role change) | 35 ms |

Before the change, each of these left the session `OPEN / DISCONNECTED` and it closed 120 s later.

## Consequences

- Each API task that hears the notification tries the close; the session lock and the "already closed" check make the second attempt a no-op.
- If the `LISTEN` connection of a task is down at that moment, that task does nothing and the session still closes through the grace window or the reconciler, as before.
- A desktop agent that stays connected after a browser logout keeps the person clocked in, which is right: the agent still observes them working.
