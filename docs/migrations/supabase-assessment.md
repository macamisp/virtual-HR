# AWS PostgreSQL to Supabase assessment

Assessment date: 2026-11-11 (Asia/Colombo). Recommendation: **BLOCKED**.
Follow-up: [2026-11-12 access verification and local test diagnostics](follow-up-2026-11-12.md).
Scope: read-only production audit and an explicitly authorized isolated test migration.
Production cutover requires separate approval. No production commands, backups, restores,
resource creation, connection changes or infrastructure changes were performed in this assessment.

Requirements: FR-AUTH-010, FR-AUD-001, FR-DOC-007/008, NFR-SEC-001/003,
NFR-REL-001/002, NFR-PERF-001/003, NFR-PRIV-002; SRS sections 3.4, 7.5, 9 and 10.1.
This is a feasibility review, not a decision to replace ADR 020 or ADR 046.

## 1. Existing inventory and evidence

Repository baseline: `88a15b0`. The accompanying `source-manifest.json` records all
36 local migration file SHA-256 checksums and 83 Prisma model/table mappings.
These are repository facts, not a live database inventory or proof that migrations are deployed.
The Prisma bookkeeping table and any unmodeled objects must be inventoried separately.

| Item | Repository evidence | Live verification |
| --- | --- | --- |
| Database engine | Compose pins `postgres:16.10-alpine` | Not performed |
| Database name | Compose configures `hrvo_staging` | Not performed |
| Storage | `postgres_data:/var/lib/postgresql/data` | Actual volume, mount and EBS mapping unknown |
| Application roles | `hrvo_app`, `hrvo_retention`: LOGIN, NOSUPERUSER, NOBYPASSRLS | Actual attributes, memberships and grants unknown |
| Migration connection | Prisma `DIRECT_DATABASE_URL` | Actual owner and privileges unknown |
| RLS | ENABLE + FORCE; policies read transaction-local `app.org_id` | Actual policies, owners and table coverage unknown |
| Authentication | NestJS; restricted SECURITY DEFINER pre-tenant lookups | Actual definer owners unknown |
| Extensions | No CREATE EXTENSION found in versioned Prisma migrations | Installed extensions unknown; SRS specifies TimescaleDB |
| Notifications | PostgreSQL LISTEN/NOTIFY for socket revocation | Delivery and listener connection not tested |
| Backups | Existing runbook describes pg_dump and EBS snapshots | Schedule, encryption, retention and restore evidence unknown |

The user identifies instance `i-084a36f551ca3a72c`, region `ap-southeast-2`,
directory `/opt/virtual-hr/app`, Compose project `hrvo-staging` as production.
The repository calls this topology staging; use the user's classification for safety.
This workstation has a staging SSH key but no configured SSH host, AWS CLI/profile,
or Supabase environment variable names. Local development env files were not treated as
production credentials. SSH agent inspection was denied by the local sandbox.
No key contents or env values were printed.

## 2. Compatibility assessment

Keeping NestJS authentication is feasible in principle: Supabase can serve as PostgreSQL
alone. Redis, SeaweedFS, LiveKit and AWS KMS stay in place. No Supabase Auth adoption is needed.
Actual compatibility remains unproven until the security gates below pass.

1. **Definer ownership is a hard gate.** Authentication lookups and organization provisioning
   functions operate before tenant context exists. FORCE RLS also applies to ordinary table
   owners. Restoring these functions under a non-bypass owner can break login, refresh,
   invitations, workspace lookup and signup. Supabase does not provide true superuser access.
   Inspect the target's actual role attributes and allowed ownership/grant operations;
   do not assume its `postgres` role is equivalent to Docker's `postgres`.
   If supported, use a reviewed, narrowly privileged function-owner role with only necessary
   table privileges and no runtime membership path to it. Test every definer function with
   missing tenant context. If this cannot preserve the existing isolation model, report NO-GO.
   Never grant BYPASSRLS to `hrvo_app` or `hrvo_retention`, or disable FORCE RLS.
   [Supabase role restrictions](https://supabase.com/docs/guides/database/postgres/roles-superuser).
2. **Migrations depend on privileged data access.** Historical timesheet, meeting-call evidence
   and work-entry migrations use `SET row_security = off` around backfills. This setting does
   not grant bypass privileges; PostgreSQL errors when enforcement would filter the operation.
   Audit the executing role and validate future migration capability on the test project.
   Preserve historical SQL and checksums; do not edit or replay applied migrations over restored data.
3. **Several connection paths exist.** Prisma reads `DATABASE_URL`, whereas `poolConfig()` in
   `apps/api/src/common/db-config.ts` builds native `pg` connections from `PG*` variables.
   Attendance additionally builds app/admin/retention pools. Match all paths to the isolated
   destination, with distinct role credentials, verified CA and hostname validation.
   The image bundles an RDS CA: it is not automatically the right Supabase CA.
   Test Prisma strict certificate validation and native `pg` TLS independently, including
   wrong-host/untrusted-CA rejection. Never use `rejectUnauthorized: false`.
4. **Use direct or session connections for this app.** A long-running listener needs session
   affinity; transaction pooling cannot support its LISTEN state. Prefer direct connections
   if EC2 IPv6 works, otherwise validate Supavisor session mode over IPv4, including custom-role
   username routing, auth events, transactions, prepared queries and migration locking.
   `DIRECT_DATABASE_URL` means the migration connection; an approved session endpoint may be
   needed for IPv4. Do not place the listener or migrations behind transaction mode.
   [Connection modes and network support](https://supabase.com/docs/guides/database/connecting-to-postgres).
5. **Allowlist application objects.** Inventory all source schemas and extension dependencies;
   restore only reviewed application objects. Preserve managed `auth`, `storage`, `extensions`,
   `realtime`, vault and internal schemas/roles. Existing `public` is shared namespace territory:
   inspect collisions and select individual archive entries rather than dropping that schema.
   Audit Supabase default grants and Data API exposure. Neither anon, authenticated nor
   service_role should gain unintended access to HR tables or definer functions. Revoke unwanted
   defaults in the test project's application objects before making them usable.
6. **Versions/extensions need actual inspection.** Record both server majors, collation, encoding,
   timezone, available extensions and versions. Do not restore into an older major. Select a
   pg_dump client compatible with both source and destination, preferably the destination major
   when upgrading. Installed local pg_dump is 18.6; that alone does not establish compatibility.
   If TimescaleDB is actually used and unsupported on the selected target, stop and ask before
   changing this SRS dependency or redesigning storage.

## 3. Free versus paid plan and expected costs

Official pricing checked on the assessment date; figures are USD estimates, before taxes,
AWS network charges, independent backup storage and usage overages. No plan selected or purchased.

| Option | Published allowance / estimate | Suitability |
| --- | --- | --- |
| Free | $0; 500 MB DB, shared CPU/500 MB RAM, 5 GB egress, inactivity pausing | Synthetic evaluation only; no production recommendation |
| Pro + one Micro | About $25/month after $10 compute credit; 8 GB disk, 250 GB egress; 7 days daily backups | Candidate only after capacity tests; daily backups alone miss 5-minute RPO |
| Pro + Small + 7-day PITR | About $130/month: $25 + $15 compute - $10 credit + about $100 PITR | Recovery candidate; measure capacity and restore duration |

Micro publishes 60 direct / 200 pooler connections; Small 90 / 400. Pooler clients do not
equate to independent PostgreSQL execution slots. Budget the sum of Prisma, native application,
attendance, retention, workers, listeners, migration and managed-service backend connections
across all processes, with recovery/admin headroom. Count instantiated pools and their actual
maxima before selecting compute. The 500-concurrent-user SRS target needs a measured load test.

Sources: [pricing and compute limits](https://supabase.com/pricing),
[PITR billing example](https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery),
[backup capabilities](https://supabase.com/docs/guides/platform/backups).
The SRS also requires 35 daily days, 12 months weekly and cross-region copies. Provider defaults
do not meet that retention policy; price independent encrypted exports and recovery drills.
Additional test projects consume compute credits/billable compute separately.

Choose a region only after the user confirms residency requirements. Same-region Sydney
deployment is a latency candidate, not a measured result or automatic residency decision.
Verify EC2 route/address-family reachability and benchmark from the actual API network.
Recurring estimate = plan + compute - organization credit + PITR + optional IPv4
+ disk/egress overages + AWS transfer + independently retained encrypted backups.
Database response traffic and export downloads consume Supabase egress; EC2 sends writes and
queries outbound. Actual traffic and current AWS tariffs are unmeasured, so no precise total
or latency promise is justified. Existing EC2, Redis, storage, media and KMS costs continue.

## 4. Verified source backup status and procedure

**Not performed:** no source connection is available. No checksum, test restore or recovery
claim can be made. The existing runbook's dump command alone is not verification.

After source access is established, first verify free disk space and the encrypted destination
for confidential artifacts. Use `umask 077`, a mode-700 private directory, mode-600 files,
no shell tracing and no secrets in command arguments or logs. Require encrypted-at-rest storage
before writing a dump; encrypt any transferred archive with existing approved tooling and
keep decryption material separate. Do not install a package or change KMS/IAM to achieve this.

Create a consistent custom-format pg_dump using an existing privileged source role, with a
bounded lock wait and conservative resource usage. Preserve the full source archive with
owners/ACLs; separately record safe role definitions without password hashes. Capture schema,
data, sequence state, large objects if present, functions, constraints, triggers and Prisma history.
Use a shared exported snapshot for the dump and exact-count baseline, or derive the baseline
from its local restore. Counts taken at a later live snapshot are not a valid comparison.
Sequences are nontransactional: capture their state and validate safe next values after restore.

Hash the completed archive (SHA-256), verify after every transfer, list its archive contents,
and restore it with fail-on-error into a fresh local PostgreSQL instance using Docker Compose,
no public database port, isolated credentials and encrypted access-restricted storage. A valid
archive list or checksum is not a restore test. Keep roles and extension dependencies sufficient
for independent recovery. Compare table data and counts at the same snapshot, constraints,
indexes, triggers, functions, owners/ACLs, RLS policies and flags, and migration checksums.
Validate sequence next values without consuming sequences on production. Preserve original
source backup and security metadata independently of any Supabase-portable derivative.

Proposed retention: encrypted production-copy test artifacts for no longer than 7 days after
validation, access restricted to migration operators; user must approve production-data copying
and retention before any transfer to a test project. Keep the independent recovery backup under
the approved backup retention policy, separate from temporary test copies. Cleanup is a later,
explicitly approved operation with evidence; do not delete volumes or resources automatically.

## 5. Isolated Supabase migration status and gates

**Not performed:** no explicitly authorized new empty test project or private connection setup
is available. Do not discover a random project or infer authorization from existing credentials.
Use synthetic data first. Production-data transfer additionally requires explicit copy approval.

Record the authorized project reference, region, database and endpoint outside secrets; verify
server identity and compare the managed-object baseline. Require no application objects/data,
detect table and function collisions, and confirm no live application uses this project.
Privately configure libpq service/password files (0600) or equivalent secret injection;
never put URLs, passwords or keys in chat, the repository, shell history or process arguments.

Follow [official PostgreSQL migration guidance](https://supabase.com/kb/guides/migrate-from-postgres)
using manual dump/restore with a reviewed application-object allowlist. Build the portable
restore selection from the verified backup, omit original ownership/ACL replay where it would
conflict, and explicitly recreate approved roles, ownership, privileges and defaults. Never replay
cluster-wide globals or blanket grants. Review archive entries offline before execution.
Keep target runtime roles disconnected until RLS, FORCE RLS, function owners and ACLs are
verified. Fail on restore errors; do not ignore errors or disable triggers/constraints/RLS.
Restore tables/data/sequence state and `_prisma_migrations` without applying already recorded
migrations. Compare every migration name/checksum to `source-manifest.json`, the deployed
source checkout and the source database; flag unfinished/rolled-back/unknown records explicitly.
Prisma status alone does not establish checksum or object equivalence.

Build a separate API/test environment with unique secrets, Redis namespace and isolated storage.
Do not allow copied jobs, outbound mail, OAuth credentials, webhooks, LiveKit calls or KMS-backed
document operations to affect real users/resources. Prefer synthetic credentials and fixtures;
obtain explicit approval before a test needs actual AWS KMS or production storage access.
Use production-equivalent TLS and auth checks rather than turning off startup safeguards.

## 6. Prisma and RLS verification matrix

All destination checks below are **NOT RUN**. Run using the actual runtime login, not only an
admin executing SET ROLE. Use two synthetic tenants and new records in the isolated target.

| Check | Required evidence |
| --- | --- |
| Runtime identity | Non-owner, NOSUPERUSER, NOBYPASSRLS; cannot assume privileged/managed roles |
| No context / empty context | Reads return no tenant rows; writes denied; invalid UUID fails closed |
| Tenant A context | A reads/writes succeed; B reads invisible; B insert/update/delete denied |
| Reused/concurrent connections | Tenant context never leaks after commit, rollback or pool reuse |
| Parent/child tenant integrity | Foreign-tenant relation creation rejected; no indirect data disclosure |
| Definer entry points | Login/refresh/reset/signup/workspace operations work without general table bypass |
| Definer ACLs | PUBLIC/anon/authenticated/service_role lack unintended EXECUTE; trusted search_path |
| Append-only tables | UPDATE/DELETE/TRUNCATE denied to runtime role; retention scope stays restricted |
| Managed schemas | Original managed object/grant baseline preserved; HR data unavailable via Data API |
| Migrations | Names/checksums/history match; future privileged backfill capability established safely |
| TLS and listener | Invalid CA/hostname rejected; reconnect restores notifications; revocation disconnects sockets |

## 7. Functional and performance results

All target functional/performance checks are **NOT RUN**. Required synthetic UAT:
signup and email verification; password/MFA/Google login and refresh; workspace selection;
Office and socket revocation; attendance transitions/reconnect/server UTC and no duplicate time;
tasks; timesheets; overtime; onsite requests; meetings; document upload/download/ACL/vault;
reports; cross-tenant denial and unauthorized writes. Test loading, empty and error responses
through a separate web/API deployment. Preserve AWS KMS context and SeaweedFS object keys.

Measure source versus target on equivalent synthetic workload: connection establishment,
pool wait, disconnections/retries, transaction errors, query p50/p95/p99, CPU/RAM/IOPS,
throughput and heartbeat durability under network interruption. Use EXPLAIN ANALYZE only on
safe test queries; never run write benchmarks on production. Targets include API standard-read
p95 <300 ms / p99 <800 ms at 500 users, and presence p95 <200 ms in-region. Record sample
sizes, warm/cold cache, region, compute, connection limits and load duration; a health check
does not establish production performance or recovery readiness.

## 8. Remaining blockers

- Source access: SSH hostname/user or an existing authorized AWS/SSM access method; no secrets in chat.
- Read-only AWS control-plane evidence tying the named instance to its volumes, encryption,
  snapshots, backup policies and DeleteOnTermination flags. A hostname alone cannot prove instance ID.
- Live database inventory, safe counts, migrations/checksums and actual SECURITY DEFINER owners.
- Verified encrypted backup and independently successful isolated restore.
- Explicitly authorized new empty Supabase test project, region/plan decision and private credentials.
- Explicit production-data copy/retention approval if synthetic data is insufficient.
- Target role/privilege proof, extension compatibility, full UAT/security/load/recovery results.

## 9. Proposed cutover and rollback (approval required; not executable authorization)

1. Complete all preceding gates; approve exact project, region, cost, timings, owners and rollback
   criteria. Rehearse on synthetic data and record restore duration below the 2-hour RTO.
2. Take and independently verify a fresh encrypted backup. Schedule a short maintenance window
   based on measured dump/restore and validation duration. Keep EC2 and the original DB running.
3. Freeze **all** writers: API writes, workers, schedulers, queue consumers, webhooks, agents and
   integrations. Drain open transactions; handle attendance offline/replay and queued events
   explicitly so no accepted event is lost. Do not acknowledge undurable attendance writes.
4. Produce final consistent source copy after the freeze. The safest initial synchronization is
   a complete final dump/restore into an approved application-empty destination, with managed
   schemas preserved. Any target cleanup requires a separately reviewed, approved procedure.
   Do not restore blindly over the earlier test copy. If measured duration is too long, stop:
   design and rehearse CDC/logical replication separately; never silently change WAL/IAM settings.
5. Compare every application table/count and deterministic content digest using the frozen source
   snapshot, plus identities, FKs/checks, indexes, functions/triggers, sequences, RLS/ACLs and
   migration records. Keep digests and comparisons confidential. Reconcile pending jobs and
   external storage references. Any mismatch blocks cutover.
6. Stage a complete privately stored connection configuration: Prisma runtime/migration and all
   PG* app/retention settings plus trust bundle. Publish it atomically to the approved deployment
   configuration, then restart only API/DB-consuming processes under the write fence. Keep
   privileged migration credentials out of runtime. Drain old pools and listeners to avoid split writes.
7. Run read/write smoke tests with approved synthetic accounts, cross-tenant denial and socket
   revocation. Record a baseline/watermark for all writes. Unfreeze only after explicit go decision.
8. Monitor errors, tenant denials, connections, listener delivery, query latency, heartbeat durability
   and jobs. Enable approved independent scheduled encrypted backups with the required retention,
   then prove recovery and RPO rather than relying on backup configuration alone.

Rollback before any target business writes: keep the write fence, atomically restore the saved
AWS connection configuration, restart consumers and verify. After any target writes, **never
simply point back at the stale AWS database**. Freeze and drain target writers; take a verified
target backup; reconcile every post-cutover insert/update/delete, sequence change and job/event
against the preserved source (including deletes and externally emitted effects), using a rehearsed
reverse transfer into an approved recovery destination. Validate full equality before switching.
If reverse synchronization has not been proven, remain in maintenance or fix forward: do not
promise zero-loss rollback. RTO/RPO must include this path. Preserve the original AWS database,
volumes and backups until user sign-off; no automatic cleanup, stop, termination or reset.

## 10. Recommendation and review walkthrough

**BLOCKED** pending access and verification. Supabase is a candidate; no GO decision is justified.
Free is unsuitable for the stated production availability/recovery requirements. Paid service may
fit if the existing RLS/definer model is preserved, all connection paths and session listeners pass,
and independent backups close the retention gap. Report NO-GO if isolation cannot be preserved.

Review walkthrough: inspect `source-manifest.json`; review `production-audit.sql`; arrange a
private source access method; collect the read-only evidence described in `source-audit-runbook.md`;
compare live inventory against this report. No schema/API/UI change is part of this slice.

Local validation: `npm run lint` and `npm run typecheck` passed; all 36 manifest hashes
were recomputed successfully. `npm test` produced file-level failures and then stopped making
progress; it was interrupted rather than reported as passing. A separate loopback PostgreSQL
port probe returned EPERM. Podman could not initialize because its runtime directory was
read-only, so Compose-backed SQL execution and database tests were unavailable. The audit SQL
has been reviewed but not executed against PostgreSQL; it must be validated in an isolated
Compose database before production use. No production or Supabase test result is implied by
the local checks.
