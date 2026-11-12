# ADR 052: Fresh Supabase PostgreSQL for new data; EC2 keeps web and API

Date: 2026-11-12. Status: **proposed**. Compatibility is proven on a local emulation of Supabase's role model;
the real project is not created yet, and cutover needs approval.
Requirements: FR-AUTH-010, NFR-SEC-001/003, NFR-REL-001. Supersedes the historical-data migration plan in
[supabase-assessment.md](../migrations/supabase-assessment.md) (no records are copied). Related: ADR 020, 046, 047, 051.

## Context

The user wants all **new** Virtual-HR data in a fresh Supabase database (Free plan). Existing accounts and records
stay in the EC2 PostgreSQL container, which is kept untouched for rollback. Web, API, Redis, storage, LiveKit and
Cloudflare stay on EC2. Tenant isolation (FORCE RLS on 83 tables, `app.org_id`), the 16 SECURITY DEFINER auth
lookups, the NOTIFY-based socket revocation and the non-privileged runtime roles must survive unchanged.

Supabase offers no superuser. Its `postgres` login is documented as CREATEROLE + BYPASSRLS. Its default
privileges grant `anon`, `authenticated` and `service_role` ALL on objects `postgres` creates in `public`,
and `service_role` bypasses RLS. The EC2 host has no IPv6, and the direct endpoint is IPv6 unless the paid IPv4 add-on is used.

## Findings (local emulation, 2026-11-12)

The emulation uses `postgres:16.10`: a separate superuser, a non-superuser `postgres` with CREATEROLE/CREATEDB/BYPASSRLS, and
`anon`/`authenticated`/`service_role` (BYPASSRLS) with Supabase-style default privileges.

1. **All 36 migrations apply without superuser.** The init migration creates `hrvo_app`/`hrvo_retention` itself
   (CREATEROLE). The three `SET row_security = off` backfills and the definer functions work because the owner
   has BYPASSRLS. There are no extensions, no `ALTER SYSTEM` and no event triggers.
2. **Default grants are a critical exposure.** Unmodified, the API roles held privileges on all 84 tables and
   EXECUTE on all 16 SECURITY DEFINER functions (e.g. `fn_lookup_user_for_auth`), so the Data API's anon key
   could call the auth lookups.
3. With the lockdown below, **the full API suite passed** against the emulation as `hrvo_app`
   (96 files, ~1,225 tests; `meetings-e2e` needed the LiveKit test container). The only incompatibility was a
   test fixture using superuser-only `session_replication_role`. It now disables the one NOTIFY trigger
   transactionally, which needs table ownership only.

## Decision

1. **Initialise with the existing migrations**, unchanged, through the existing migrate job
   (`docker/migrate-entrypoint.mjs`), run as the project's `postgres` login. Owner = `postgres` (BYPASSRLS),
   runtime = `hrvo_app` / `hrvo_retention` (NOSUPERUSER, NOBYPASSRLS, no memberships), exactly as on EC2.
2. **`apps/api/prisma/scripts/supabase-lockdown.ts`** runs before and after `migrate deploy`. It is a no-op
   where the Supabase roles do not exist.
   - `pre` revokes the default privileges for the API roles.
   - `post` revokes their existing grants, plus PUBLIC EXECUTE on trigger functions and on explicitly granted
     functions, plus runtime access to `_prisma_migrations`.
   - `post` then **verifies**, failing the release otherwise: zero API-role access in `public`; FORCE RLS and at
     least one policy on every table; definer owners have BYPASSRLS; definer functions pin `search_path`; app
     roles are unprivileged; no function depends on PUBLIC EXECUTE.
   - It never grants anything and never touches RLS or policies. In the dashboard, the Data API is also
     disabled, as defence in depth.
3. **Connection: Supavisor session mode** (pooler host, port 5432, IPv4, users `<role>.<project-ref>`). It carries the
   API's dedicated LISTEN connection and session-level settings; transaction mode (6543) is not used.
   TLS is `verify-full` against Supabase's CA for Prisma, the pg pools, the listener and the migrate job (`PGSSLROOTCERT`).
4. **Connection caps** for session mode: new optional `PRISMA_CONNECTION_LIMIT` and `PG_POOL_MAX` (default
   unchanged when unset). The Supabase override sets 4 + 4, plus retention 4, plus 1 listener, which fits the
   pool size the user reads from the dashboard.
5. **Deployment by override**: `docker-compose.staging.supabase.yml` + `.env.staging.supabase` (SUPABASE_* names, so
   the local postgres service's settings never change). The API is recreated with `--no-deps`. Rollback is the
   same command without the override.
6. `supabase-preflight.ts` gates each step against the real project. `target` runs before init: TLS through
   the pooler, role attributes, empty `public`, LISTEN/NOTIFY. `app` runs after init: runtime logins, fail-closed
   RLS, migrations, NOTIFY as `hrvo_app`.

## Consequences

- Existing EC2 users, workspaces and history do **not** appear in Supabase. People sign up again. The EC2 database
  remains intact and reachable for rollback or a later, separately approved import.
- **Free-plan limits** (confirm on the pricing page at approval): 500 MB database, shared compute, project paused
  after a period of inactivity, and no automated backups. ADR 051's encrypted `pg_dump` procedure can be pointed at
  Supabase later; until then a Free project is not a durable system of record. Upgrading needs approval.
- Supabase's network path adds latency to every query (EC2 Sydney → Supabase, ideally `ap-southeast-2`).
- Future migrations must keep granting EXECUTE explicitly to `hrvo_app`; the lockdown's verify step enforces it.
