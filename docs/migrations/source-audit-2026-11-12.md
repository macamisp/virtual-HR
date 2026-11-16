# Read-only source audit — 2026-11-12

Requirements: FR-AUTH-010, NFR-SEC-001/003, NFR-REL-001/002. Follows
[follow-up-2026-11-12.md](follow-up-2026-11-12.md) and [supabase-assessment.md](supabase-assessment.md).
Decision: **still BLOCKED for migration/cutover**. The source is now inventoried. The remaining gates are
AWS control-plane evidence, an independent backup and an authorized Supabase test project.

Run at 2026-11-12T00:10Z. Nothing on the host was changed apart from audit inputs and outputs in
`/home/ubuntu`. There was no restart, no DB write, no config change, and no volume or AWS/Cloudflare change.
The raw evidence (mode 700/600) stays on the host at `/home/ubuntu/hrvo-audit-20261112T001012Z`.
Both SQL files were first dry-run against a local e2e PostgreSQL. Both ran with exit 0 and reached `COMMIT`.

## 1. Connection and identity

| Check | Result |
| --- | --- |
| Workstation egress | 203.189.185.163 (allowlist now admits it) |
| SSH `ubuntu@15.134.186.246` | Connected; BatchMode, StrictHostKeyChecking=yes, IdentitiesOnly |
| Host key | Matches stored ED25519 `SHA256:eT3NNtl2T6fgBeDt3IAibin81tts1luwa0dXY1lGpoU` |
| IMDSv2 identity | `i-084a36f551ca3a72c`, `ap-southeast-2b`, public IPv4 15.134.186.246, `m7i-flex.large` |
| IPv6 | None assigned (IMDS `ipv6` returns 404) |
| Instance profile | Present (IMDS `iam/info` 200). Not used: there is no aws CLI and AWS API access is not authorized |
| Checkout | `a9b6714` (landing deploy), 2 untracked files: `docker-compose.staging.https.yml`, `.env.staging.backup` (not opened) |
| Migration files on host | 36, all SHA-256 equal to `source-manifest.json` |

## 2. Database inventory (superuser audit role, so counts are complete)

| Item | Live value |
| --- | --- |
| Engine | PostgreSQL 16.10 (`postgres:16.10-alpine`), UTF8, `en_US.utf8`, TimeZone UTC |
| Size | 18 MB logical; data directory 73 MB on disk |
| Schemas / extensions | `public` only; `plpgsql` only (**no TimescaleDB**) |
| Tables | 84 (83 Prisma models + `_prisma_migrations`), 204 indexes, 4 sequences, 0 views |
| Rows | 7,377 total; 50 tables empty; largest `presence_events` 6,343, `audit_logs` 207, `auth_sessions` 127 |
| RLS | 83 tables ENABLE + FORCE, 83 policies (one per table, role `public`); only `_prisma_migrations` is unforced; no forced table lacks a policy |
| Owner | All 84 tables owned by `hrvo_admin` |
| Functions | 29; 16 SECURITY DEFINER, all owned by `hrvo_admin` with pinned `search_path`; none executable by PUBLIC; 15 executable by `hrvo_app` |
| Triggers | 20 user triggers: 14 `*_same_org` tenant guards, `time_entries_lock_guard`, `trg_attendance_flag_session`, `trg_signature_signer_final`, `organization_default_holidays`, and **NOTIFY triggers** `trg_auth_sessions_notify`, `trg_users_status_notify` |
| Prisma migrations | 36 applied, 0 unfinished, 0 rolled back, latest `20261107000200_overtime_onsite`; **all checksums equal the manifest** |
| Settings | `max_connections` 100, `ssl` on, `password_encryption` scram-sha-256, `wal_level` replica, `archive_mode` off |
| Live connections | 4 idle `hrvo_app` connections |
| API DB path | `PGHOST=postgres`, `PGDATABASE=hrvo_staging`, `PGUSER=hrvo_app`, `PGSSLMODE=verify-full` + `PGSSLROOTCERT`; `DATABASE_URL` unset (Prisma builds it from PG*, `db-config.ts`) |

Roles:

| Role | SUPERUSER | BYPASSRLS | LOGIN | CREATEROLE | Memberships |
| --- | --- | --- | --- | --- | --- |
| `hrvo_admin` (container admin, owner, migrations) | yes | yes | yes | yes | none |
| `hrvo_app` (runtime) | no | no | yes | no | none |
| `hrvo_retention` | no | no | yes | no | none |

`hrvo_app` holds SELECT/INSERT on 83 tables, UPDATE on 75 and DELETE on 47, with no TRUNCATE.
`hrvo_retention` holds SELECT + DELETE on 2 tables only.

## 3. Storage, EBS and backups

- Postgres data is the named volume `hrvo-staging_postgres_data` (created 2026-10-31) at
  `/var/lib/docker/volumes/.../_data`, on `/dev/nvme0n1p1`, ext4, **root volume**.
- The instance has **one EBS volume**: `vol-0755d13e47a5de04f`, 60 GiB, root `/dev/sda1`, 18.4 GiB used.
  The OS, Docker, the DB, SeaweedFS and the on-host backups all share it.
- **Not verified (AWS API only):** DeleteOnTermination, EBS encryption/KMS key, snapshots, DLM/AWS Backup policies.
  A console-launched root volume defaults to DeleteOnTermination=true. If so, terminating the
  instance destroys the database *and* every backup.
- Backups: two manual on-host dumps, `hrvo-20261104T104224Z.dump` (557 KB) and
  `hrvo-20261105T105727Z-pre-v3.dump` (558 KB). Both pass SHA-256 today. The 2026-11-05 dump was
  restore-tested at the V3 deploy. There is no backup cron/timer, no off-host copy and no WAL archiving.
- Effective position: the newest backup is about 7 days old, so the RPO is about 7 days for logical loss.
  There is no protection against volume loss unless EBS snapshots exist. This misses the SRS target (5-min RPO / 2-h RTO).

## 4. Supabase destination requirements (derived from live evidence)

1. **Version.** Restore 16.10 into the same or a newer major. Use the destination-major `pg_dump`/`pg_restore`
   (the local client is 18.6; do not use it against an older target). Only `plpgsql` is needed, so
   the TimescaleDB concern is closed for the current schema.
2. **Owner role (hard gate).** The source owner `hrvo_admin` is SUPERUSER, which Supabase does not offer.
   The 16 definer functions and pre-tenant migrations (`SET row_security = off` in init, timesheets,
   meeting_call_evidence and work_entries) need an owner that has **BYPASSRLS** under FORCE RLS.
   Verify on the test project whether `postgres` has BYPASSRLS, or whether a dedicated NOLOGIN owner with
   BYPASSRLS can be created there. Then run every definer function with no `app.org_id`. If neither is possible: **NO-GO**.
3. **Runtime roles.** Recreate `hrvo_app` and `hrvo_retention` exactly: LOGIN, NOSUPERUSER, NOBYPASSRLS,
   no memberships, and the grant counts above. `provision-db-roles.ts` sets role passwords through the admin
   connection, so the Supabase admin needs CREATEROLE over these roles.
4. **Data API exposure (new finding).** Supabase default privileges grant `anon`, `authenticated` and
   `service_role` access to `public` objects, and `service_role` bypasses RLS. Because all policies
   target `public`, HR tables must have those grants revoked and/or the Data API must not expose `public`
   before any data lands. Verify with a service_role request returning nothing.
5. **Connections.** The API uses PG* plus `verify-full`. It needs the Supabase CA in `PGSSLROOTCERT` and the real
   hostname. EC2 has **no IPv6**, so the direct endpoint (IPv6) is unreachable without the IPv4 add-on.
   Otherwise use the Supavisor **session** pooler (custom-role usernames `hrvo_app.<ref>`). The two NOTIFY
   triggers mean the listener cannot use transaction mode. Budget: the current 4 idle app connections, plus
   attendance/retention/migration pools, fit Micro (60 direct), but load is untested.
6. **Size.** 18 MB fits every plan, including Free (500 MB), for a *synthetic* test. Dump/restore takes seconds,
   so a freeze-dump-restore cutover is viable and CDC is not needed.
7. **Backups.** Pro daily backups (7 days) miss the 5-min RPO. PITR, plus independent encrypted exports for
   the SRS 35-day/12-month retention, is required for production. The SeaweedFS objects and KMS keys
   are outside the DB and stay on AWS.

## 5. Remaining blockers

1. AWS console evidence for `vol-0755d13e47a5de04f`: DeleteOnTermination, encryption, snapshots, DLM/Backup policies.
2. A fresh, verified, encrypted backup with an **off-instance** copy (needs approval and a target location).
3. An explicitly authorized empty Supabase test project (region, plan) with privately injected credentials.
4. Proof of BYPASSRLS owner capability and Data API lockdown on that project (gates 2 and 4 above).
5. Hygiene: `.env.staging.backup` sits untracked in the app checkout. Confirm its mode, or move it beside the
   other root-only config copies (operator decision, not done here).
