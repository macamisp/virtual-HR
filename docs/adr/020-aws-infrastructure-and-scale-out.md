# ADR 020: AWS infrastructure (Terraform) and running on several instances

**Status:** Accepted (not applied to any account)
**Date:** 17 October 2026
**Requirements:** SRS 12.1–12.3 (staging + production, Growth topology, Terraform only), 10.1/10.3 (KMS, least privilege, separate production account), 9 (availability), FR-ATT-002 (session lock).

## 1. Decisions agreed with the product owner

| Topic | Decision |
| --- | --- |
| Accounts and region | **Two AWS accounts** (staging, production), both **ap-southeast-1**. The same module serves both; each root pins its account with `allowed_account_ids`. |
| Media | **LiveKit Cloud.** Terraform only creates the Secrets Manager entries for its key and secret. |
| Socket.IO | **`@socket.io/redis-adapter` 8.3.0** (new dependency, approved, exact pin) on the existing `ioredis`. The Redis lock and the Redis rate-limit store are hand-written. |
| Tooling | Terraform **1.16.5**, used only for `fmt` and `validate` here and in CI. **Nothing is planned or applied without the owner's explicit approval.** |

## 2. Topology (Growth, SRS 12.2)

Cloudflare (proxied DNS, TLS full-strict) sits in front of an ALB. The ALB accepts port 443 **only from Cloudflare's IP ranges**; that is the precondition for `TRUST_PROXY_HEADERS=cloudflare` (ADR 019). The ALB routes:

| Host / path | ECS service | Notes |
| --- | --- | --- |
| `app.<domain>` | **web** (Next.js standalone), N tasks | |
| `api.<domain>/socket.io/*` | **realtime**, 1 task | All Socket.IO traffic. The office world is in-memory (ADR 015), so one process holds it. `JOBS_ENABLED=false`. |
| `api.<domain>` | **api**, N tasks (autoscaled on CPU) | REST and the BullMQ job runner (BullMQ de-duplicates schedules across tasks). |
| internal `clamav.<env>.hrvo.internal` | **clamav**, 1 task | Cloud Map DNS. |
| one-off | **migrate** task | `prisma migrate deploy` and role passwords, run before each release. |

The VPC has 3 AZs with public (ALB, NAT), private (tasks) and isolated (RDS, Redis, with no route to the internet) subnets. Production gets one NAT per AZ; staging one NAT. Rejected-traffic flow logs are kept, and S3 traffic uses a gateway endpoint.

## 3. Data stores

- **RDS PostgreSQL 16:**
  - Multi-AZ in production. gp3 storage with autoscaling, encrypted with the data KMS key.
  - The parameter group forces TLS (`rds.force_ssl`) and logs slow statements without parameter values.
  - Automated backups with point-in-time recovery: 35 days in production, 7 in staging. Performance Insights is on. Deletion protection and a final snapshot are on in production.
  - The master password is **managed by RDS** in Secrets Manager.
  - The app connects as `hrvo_app` with **verified TLS** (`PGSSLMODE=verify-full`, RDS CA bundle in the image; `db-config.ts`). There's a test for "verify-full without a CA bundle is an error", not a silent downgrade.
- **ElastiCache Redis 7:** a replica with automatic failover and Multi-AZ in production. TLS in transit, encrypted at rest, AUTH token, `noeviction` (required by BullMQ).
- **S3 documents bucket:**
  - Versioned, encrypted with the data KMS key (bucket key on), public access blocked, non-TLS requests denied.
  - CORS allows only `https://app.<domain>` (presigned uploads, ADR 009). Old versions expire after 90 days.
- **ALB logs bucket:** SSE-S3 (the only option the ALB supports), with expiry.

## 4. Keys and secrets

- **KMS keys:**
  - `documents` wraps per-file data keys. Its key policy lets only the API task role use it, and only with `org_id` and `document_id` in the encryption context (SRS 10.1). The `KeyProvider` adapter that uses it is item 4; until then **`NODE_ENV=production` refuses the local key provider**, so no environment can run in production mode before item 4 (verified with the image).
  - `data` covers RDS, Redis, S3, Secrets Manager, logs, ECR, the alert topic and backups.
  - Both keys rotate.
- **Secrets Manager:**
  - The JWT secret, DB app and retention passwords and the Redis AUTH token are **ephemeral** values written with **write-only arguments**, so they are never in Terraform state or plans. Rotation is by version number.
  - The LiveKit key and secret and the SMTP password are created empty and filled once by an operator.
  - Tasks receive them through ECS `secrets`. The execution role may read exactly those ARNs.
- **State:** an S3 bucket per account (KMS, versioned, TLS-only, `prevent_destroy`) with S3-native locking (`use_lockfile`). No DynamoDB table is needed (Terraform ≥ 1.10).

## 5. Several API instances (code)

With `COORDINATION=redis`:
- **Socket.IO Redis adapter:** `user:`, `org:` and `family:` rooms span tasks, so a REST task's notification, revocation, chat message or meeting ring reaches a socket on the realtime task.
- **`RedisThrottlerStorage`:** one set of counters for the HTTP buckets and the heartbeat limit. Fixed window and block, atomic Lua.
- **`RedisLock`:** `withSessionLock` is now in-process **and** across tasks. It uses `SET NX PX` with a random token, compare-and-delete release, renewal while held, and a wait timeout.

Supporting changes:
- **`/health`:** the database and Redis, reporting `ok`/`unavailable` only. Public by design and allow-listed.
- **Graceful shutdown:** `enableShutdownHooks` on SIGTERM. Verified: the container stopped in 2 s with exit 0, where it had been killed after 10 s. The gateway no longer publishes presence while shutting down (the adapter's connection is closing; found by the two-instance test). The adapter's Redis connections close after the Socket.IO server.
- **ElastiCache TLS** (`REDIS_TLS`) applies to BullMQ too.

## 6. Monitoring and alerts

- **Alerts:** an SNS topic (KMS) with email subscriptions.
- **Alarms:**
  - ALB 5xx, p95 latency and unhealthy targets per target group;
  - CPU and memory per service, and **no running realtime task**;
  - RDS CPU, free storage, freeable memory and connections;
  - Redis engine CPU and memory;
  - API `ERROR` log lines (metric filter);
  - failed backup, restore or copy jobs (EventBridge).
- **Dashboard** and Container Insights.
- **Logs:** CloudWatch groups encrypted with KMS, 90-day retention.

## 7. Backups and restore drill

- RDS point-in-time recovery, **plus** AWS Backup daily recovery points of the database and the documents bucket. The vault is KMS-encrypted with a governance-mode lock (7–400 days); retention is 35 days in production and 14 in staging.
- **Restore drill** (`infra/scripts/restore-drill.sh`, runbook `docs/runbooks/restore-drill.md`):
  1. Point-in-time restore into a temporary instance.
  2. A read-only verification task (`docker/restore-verify.mjs`): all migrations applied, RLS forced on every `org_id` table, tables populated. Catalog and statistics only; no row content.
  3. RTO and RPO printed, then the copy deleted.
- Operator-run, staging by default, with typed confirmation. The verifier was run locally: 17/17 migrations, 65 tables with forced RLS.

## 8. Containers

- **`docker/api.Dockerfile`:** targets `api` (runtime dependencies only, non-root, read-only root filesystem on ECS, RDS CA bundle) and `migrate`.
- **`docker/web.Dockerfile`:** Next.js standalone (`NEXT_OUTPUT=standalone`; `next start` is unchanged). `NEXT_PUBLIC_*` are build arguments.
- **Local checks:** both images were built and smoke-tested here. The API health check was OK with Redis, running as uid 1000. The web served pages and assets with its CSP. Nothing was pushed. CI builds them too.

## 9. Not done / follow-ups (need approval or later items)

- **Item 4 (KMS `KeyProvider`)** is required before any environment runs with `NODE_ENV=production`.
- **No CI/CD deploy role or pipeline** (GitHub OIDC to AWS, image push, migrate, deploy). Writing it is safe, but using it touches real accounts, so it is left for a separate approval.
- **SMTP authentication:** the mailer has no SMTP auth yet, so SES SMTP cannot be used. The secret slot exists.
- **Cloudflare WAF and rate-limit rules** depend on the plan and were left out; zone TLS settings are managed by the production root only.
- **One realtime task:** scaling sockets beyond one task needs a Redis-backed office world.
- **Rejection/flood counters** for review flags (ADR 019) are still per process.
- **Cross-region backup copies** are not set up (they need a second-region vault).
- **Provider lock files** carry linux_amd64 hashes; run `terraform providers lock -platform=darwin_arm64 …` if operators use macOS.
