/**
 * Supabase hardening around `prisma migrate deploy` (ADR 052, FR-AUTH-010, NFR-SEC-001).
 *
 * Supabase's default privileges grant anon, authenticated and service_role ALL on every table,
 * sequence and function that `postgres` creates in `public`. For this app that would expose all
 * HR tables and the SECURITY DEFINER auth lookups (e.g. fn_lookup_user_for_auth) through the Data
 * API, and service_role bypasses RLS. This script removes those grants and verifies the security
 * model; it never grants anything and never touches RLS, policies or data.
 *
 *   pre   revoke the default privileges for objects the migration role creates from now on
 *   post  revoke existing grants, then verify (exit 1 on any violation)
 *   check verify only
 *
 * No-op (exit 0) when the Supabase API roles do not exist (local Docker, AWS EC2).
 * Env: DIRECT_DATABASE_URL (the migration/owner role, TLS verified by the caller's URL).
 */
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const API_ROLES = ['anon', 'authenticated', 'service_role'] as const;
const APP_ROLES = ['hrvo_app', 'hrvo_retention'] as const;
type Phase = 'pre' | 'post' | 'check';

async function apiRolesPresent(client: pg.Client): Promise<string[]> {
  const r = await client.query<{ rolname: string }>('SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])', [
    [...API_ROLES],
  ]);
  return r.rows.map((row) => row.rolname);
}

export async function revokeDefaults(client: pg.Client, roles: string[]): Promise<void> {
  const list = roles.map((r) => client.escapeIdentifier(r)).join(', ');
  for (const kind of ['TABLES', 'SEQUENCES', 'FUNCTIONS']) {
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public REVOKE ALL ON ${kind} FROM ${list}`);
  }
}

export async function revokeExisting(client: pg.Client, roles: string[]): Promise<void> {
  const list = roles.map((r) => client.escapeIdentifier(r)).join(', ');
  for (const kind of ['TABLES', 'SEQUENCES', 'FUNCTIONS']) {
    await client.query(`REVOKE ALL ON ALL ${kind} IN SCHEMA public FROM ${list}`);
  }
  // API roles also inherit PostgreSQL's built-in PUBLIC EXECUTE. Remove it where the app cannot depend
  // on it: trigger functions (EXECUTE is not checked when a trigger fires) and functions the app roles
  // already hold an explicit grant for. Anything else is reported by verify() instead of being broken.
  const fns = await client.query<{ sig: string }>(
    `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind = 'f'
        AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
        AND (p.prorettype = 'trigger'::regtype
             OR EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         JOIN pg_roles r ON r.oid = a.grantee
                        WHERE r.rolname = ANY($1::text[]) AND a.privilege_type = 'EXECUTE'))`,
    [[...APP_ROLES]],
  );
  for (const { sig } of fns.rows) {
    await client.query(`REVOKE EXECUTE ON FUNCTION ${sig} FROM PUBLIC`);
  }
  // The runtime roles never read or write Prisma's migration history.
  await client.query(
    `DO $$ BEGIN IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
       REVOKE ALL ON public._prisma_migrations FROM hrvo_app, hrvo_retention; END IF; END $$`,
  );
}

/** Returns human-readable violations; empty means the security model holds. */
export async function verify(client: pg.Client, roles: string[]): Promise<string[]> {
  const problems: string[] = [];
  const add = async (label: string, sql: string, params: unknown[] = []) => {
    const r = await client.query<{ item: string }>(sql, params);
    for (const row of r.rows) problems.push(`${label}: ${row.item}`);
  };
  await add(
    'migration role lacks BYPASSRLS (definer functions and backfills need it under FORCE RLS)',
    `SELECT rolname AS item FROM pg_roles WHERE rolname = current_user AND NOT rolbypassrls AND NOT rolsuper`,
  );
  await add(
    'SECURITY DEFINER function owner cannot bypass FORCE RLS',
    `SELECT p.oid::regprocedure::text || ' owner=' || r.rolname AS item FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
      WHERE n.nspname = 'public' AND p.prosecdef AND NOT (r.rolbypassrls OR r.rolsuper)`,
  );
  await add(
    'SECURITY DEFINER function without pinned search_path',
    `SELECT p.oid::regprocedure::text AS item FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
        AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')`,
  );
  await add(
    'application role is privileged',
    `SELECT rolname || ' super=' || rolsuper || ' bypassrls=' || rolbypassrls || ' createrole=' || rolcreaterole AS item
       FROM pg_roles WHERE rolname = ANY($1::text[]) AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)`,
    [[...APP_ROLES]],
  );
  await add(
    'application role is a member of another role',
    `SELECT m.member::regrole::text || ' in ' || m.roleid::regrole::text AS item FROM pg_auth_members m
      WHERE m.member::regrole::text = ANY($1::text[])`,
    [[...APP_ROLES]],
  );
  await add(
    'application role missing',
    `SELECT r AS item FROM unnest($1::text[]) r WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)`,
    [[...APP_ROLES]],
  );
  await add(
    'table without FORCE RLS or without a policy',
    `SELECT c.relname || ' force=' || c.relforcerowsecurity || ' policies=' ||
            (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS item
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> '_prisma_migrations'
        AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
             OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))`,
  );
  await add(
    'runtime role can write the migration history',
    `SELECT 'hrvo_app' AS item WHERE to_regclass('public._prisma_migrations') IS NOT NULL
        AND has_table_privilege('hrvo_app', 'public._prisma_migrations', 'INSERT,UPDATE,DELETE,TRUNCATE')`,
  );
  if (roles.length > 0) {
    await add(
      'Supabase API role has table/sequence access in public',
      `SELECT r || ' on ' || c.relname AS item FROM unnest($1::text[]) r
         CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
          AND (CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(r, c.oid, 'USAGE,SELECT,UPDATE')
                    ELSE has_table_privilege(r, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') END)`,
      [roles],
    );
    await add(
      'app relies on PUBLIC EXECUTE (add an explicit GRANT in a migration)',
      `SELECT p.oid::regprocedure::text AS item FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prorettype <> 'trigger'::regtype
          AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')`,
    );
    await add(
      'Supabase API role can execute a public function',
      `SELECT r || ' on ' || p.oid::regprocedure::text AS item FROM unnest($1::text[]) r
         CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p') AND has_function_privilege(r, p.oid, 'EXECUTE')`,
      [roles],
    );
    await add(
      'default privileges still grant to Supabase API roles',
      `SELECT d.defaclobjtype::text || ' ' || a.grantee::regrole::text AS item FROM pg_default_acl d
         CROSS JOIN LATERAL aclexplode(d.defaclacl) a
        WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND d.defaclnamespace = 'public'::regnamespace
          AND a.grantee::regrole::text = ANY($1::text[])`,
      [roles],
    );
  }
  return problems;
}

export async function runLockdown(phase: Phase, url: string): Promise<number> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const roles = await apiRolesPresent(client);
    if (roles.length === 0) {
      console.log('supabase-lockdown: no Supabase API roles in this database; nothing to do');
      return 0;
    }
    if (phase === 'pre') {
      await revokeDefaults(client, roles);
      console.log(`supabase-lockdown pre: default privileges revoked from ${roles.join(', ')}`);
      return 0;
    }
    if (phase === 'post') {
      await revokeDefaults(client, roles);
      await revokeExisting(client, roles);
    }
    const problems = await verify(client, roles);
    for (const p of problems.slice(0, 50)) console.error(`  VIOLATION ${p}`);
    if (problems.length > 0) {
      console.error(`supabase-lockdown ${phase}: ${problems.length} violation(s)`);
      return 1;
    }
    console.log(`supabase-lockdown ${phase}: verified (no API-role access, FORCE RLS + policies, definer owners bypass RLS)`);
    return 0;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const phase = process.argv[2];
  const url = process.env.DIRECT_DATABASE_URL;
  if (phase !== 'pre' && phase !== 'post' && phase !== 'check') {
    console.error('usage: supabase-lockdown.ts pre|post|check');
    process.exit(2);
  }
  if (!url) {
    console.error('DIRECT_DATABASE_URL must be set');
    process.exit(2);
  }
  runLockdown(phase, url).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error('supabase-lockdown failed:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
