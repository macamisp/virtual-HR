# Where the API assumes it is the only instance

**As of:** 23 October 2026, checked against the code on `main`.
**Deployment it was checked against:** `infra/terraform/modules/platform/ecs.tf` and `edge.tf`.
- **`realtime`:** exactly 1 task, `JOBS_ENABLED=false`. The load balancer sends only `/socket.io/*` to it.
- **`api`:** N autoscaled tasks, `JOBS_ENABLED=true`. They receive every REST route.
- **Both:** `COORDINATION=redis`, and both run the same application module.

Browsers connect with WebSocket only, so sticky sessions are not needed.

**AWS production has never been deployed.** Nothing below has affected a user. Items 1 to 3 would fail in the planned topology as it stands, not only after scaling out.

## Still wrong with Redis on (most serious first)

| # | Location | What assumes one instance | User-visible symptom | Change needed |
| --- | --- | --- | --- | --- |
| 1 | `media/media.service.ts` `roomToken`, `proximityToken` (`registry.peek`) | REST reads the avatar's room and proximity group from this process's memory. | `POST /media/token` runs on an `api` task, which has no avatars. Room and proximity audio/video answer "Enter the office first". | Serve these tokens over the office socket (realtime task), or keep room and group membership in Redis. |
| 2 | `office/office.service.ts` `reload` after admin changes (map, rooms, room password, invites, desks) | Only the local copy of the office reloads. | The change runs on an `api` task. The live office (realtime) keeps the old rooms, passwords and invites, and earlier password and knock grants, until it restarts. | Publish `office:reload <orgId>` (Redis pub/sub or Postgres NOTIFY, like the auth events), and reload plus withdraw grants on every instance. |
| 3 | `office/office.service.ts` `snapshot`, `people`, `setStatus` | REST reads and writes `world.avatars` locally. | On an `api` task the office page snapshot and the People list show everyone offline with empty rooms. A manual status never reaches the avatar. | Same as 1: ask the world owner, or send the change over Redis pub/sub. |
| 4 | `office/office-registry.ts`, `office/office-world.ts` | The whole office (avatars, grants, knocks, proximity groups) lives in one process. | `realtime` cannot scale past one task. Restarting it drops the office and every attendance socket at once. | Keep world state in Redis (per-organisation hashes, one tick owner chosen by a Redis lock), or keep one owner and route all office access to it. |
| 5 | `attendance/attendance.gateway.ts` `revalidateAll` (`server.fetchSockets()`) | The minute sweep is meant for this process's sockets. | With the Redis adapter, `fetchSockets()` is cluster-wide: each socket is re-checked by every task. One slow task makes the call time out, and nothing handles that rejection, which can stop the Node process. | Use `this.server.local.fetchSockets()` inside try/catch. |
| 6 | `attendance/attendance.service.ts` `policyCache`, `invalidatePolicy` | Cache invalidation is local. | An admin changes attendance thresholds on an `api` task. Heartbeats on realtime keep the old values for up to 30 s. | Publish on the existing `hrvo:access-invalidate` channel (or a sibling) and invalidate in the subscriber. |
| 7 | `office/office.gateway.ts` and `attendance.gateway.ts` `onPresence` listeners | Presence listeners run only in the process that published the change. | A break started over REST (`api` task) shows on the avatar only at the next heartbeat, about 30 s later. | Deliver presence changes to the world owner over Redis pub/sub. |
| 8 | `attendance/attendance-flags.service.ts` `lastSeen`, `rejections` | Last country and rejection counters are per process. | With rejections spread over tasks, FLOOD or INVALID flags may never be raised. Impossible-travel can be missed or wrong. | Counters: Redis `INCR` with a TTL. Country: compare against `users.last_country` with a conditional update. |
| 9 | `attendance/heartbeat-validator.ts` with `attendance-repository.ts` (nonce, device sequence) | "Read, then insert" outside the session lock. | Two copies of one heartbeat arriving together can both be accepted, and a device sequence can move backwards. | `INSERT … ON CONFLICT DO NOTHING RETURNING 1` (reject when nothing comes back), and `UPDATE device_sequences … WHERE last_sequence < $n`. |
| 10 | `common/permission-resolver.ts` cache, `attendance.service.ts` `sessionSecrets` | Logout and session revocation do not clear these caches. | After logout or revocation, REST keeps working for up to 30 s on any instance. A cached heartbeat secret is never cleared, which is mitigated by the live-login check on each heartbeat. | Clear both from the `hrvo_auth_events` NOTIFY handler, which every instance already listens to. |
| 11 | `office/office.gateway.ts` `moveWindow`, `passwordTries`, `lastKnock` | In-memory rate limits. | Room-password guessing is limited to 5 per minute **per task** once realtime scales. | Use the injected `ThrottlerStorage` (Redis-backed). |
| 12 | `notifications/jobs.service.ts` inline `dispatch*` when `JOBS_ENABLED=false` | Realtime runs triggered work inline. | Recording processing started on the realtime task is lost on shutdown. E-mails sent from there have no retry. | Give realtime a producer-only BullMQ queue (enqueue without a worker). |
| 13 | `attendance.gateway.ts` `hrvo_auth_events` listener | Every task acts on every revocation. | Correct result, but duplicate `auth:revoked` events and repeated attendance-close attempts per revocation. | Disconnect with `server.local`. Run the close once, for example behind a Redis `SET NX` on the event id. |
| 14 | `attendance.gateway.ts` `recordDisconnect` (`in(user:).fetchSockets()`) | Cluster-wide lookup with a timeout. | If any task is slow, the disconnect is not recorded. The reconciler closes the session later instead. | Treat a timeout as "no other sockets", or keep a per-user connection count in Redis. |
| 15 | `office/office-registry.ts` 10 Hz tick | One tick loop per process. | Wasted work on every `api` task. Worlds loaded there are never evicted, so memory grows. | Start the tick only on the world owner, and add eviction. |
| 16 | Database pools (`prisma.service.ts`, `attendance-repository.ts`) | Four pools plus one LISTEN connection per process. | Connections grow with the task count against RDS `max_connections`. | Set each pool's `max` from the environment and budget it against the autoscaling maximum, or use RDS Proxy. |

## Already safe with `COORDINATION=redis` / `JOBS_ENABLED=true`

| Location | Why it is safe |
| --- | --- |
| Per-person attendance queue (`withSessionLock`) | `RedisLock` with token, renewal and compare-and-delete release is added when `COORDINATION=redis`. Caveats: an ElastiCache failover can briefly allow two holders, and a failed renewal is not detected. |
| HTTP and heartbeat rate limits | `RedisThrottlerStorage` (atomic Lua script) when `COORDINATION=redis`. |
| Socket.IO rooms and broadcasts | `@socket.io/redis-adapter` when `COORDINATION=redis`. |
| Permission cache (role and permission changes) | Redis pub/sub `hrvo:access-invalidate` clears every instance. A message lost during a reconnect falls back to the 30 s expiry. |
| Scheduled jobs | BullMQ `upsertJobScheduler` dedupes across tasks. Handlers are idempotent (`job_runs`, `SKIP LOCKED`, per-person locks). |
| One-time tokens and replay protection | TOTP replay, agent pairing codes and offline batches are in Postgres with conditional updates. Google and calendar OAuth state are signed cookies. |
| LiveKit and Egress webhooks | Database only, with `ON CONFLICT` and status guards. Any task can take a delivery or a retry. |
| Per-socket timers, agent `last_seen` throttle | A socket lives in one process. At most one extra write per task per minute. |
| Conflict-retry counter (ADR 038) | Observability only, per task. The log line is the cluster-wide signal. |
| File system | No writes. Exports and ZIP files are built in memory. |

## Configuration guards worth adding

- **Inline reconciler:** refuse `ATTENDANCE_RECONCILE_INLINE_MS` when `COORDINATION=redis`. Today every instance would run it: correct because of the lock, but duplicated work.
- **Memory mail transport (resolved by ADR 039):** production now refuses `MAIL_TRANSPORT=memory` as well as development SMTP. Use the configured Resend transport.
- **Missing coordination:** fail at start when more than one instance is expected and `COORDINATION` is not `redis`.
- **In-memory fallbacks:** stop writing `AttendanceService.sessions` and `closedSessions` when a repository is present. Today they grow without limit and are never read.
