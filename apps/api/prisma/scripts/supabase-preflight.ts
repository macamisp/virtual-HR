/**
 * Read-only preflight for a Supabase destination (ADR 052). Never prints passwords or URLs.
 *
 *   node --experimental-strip-types apps/api/prisma/scripts/supabase-preflight.ts <target|app> <env-file>
 *
 * target  before initialisation, as the project's postgres login: verified TLS through the session
 *         pooler, server version, role attributes (must have BYPASSRLS + CREATEROLE, must not need
 *         superuser), Supabase API roles present, `public` schema empty, LISTEN/NOTIFY across sessions.
 * app     after the migrate job: the hrvo_app / hrvo_retention logins through the pooler with TLS,
 *         their attributes, no tenant rows visible without app.org_id, 36+ applied migrations, and
 *         NOTIFY delivered to an hrvo_app listener (the API's socket-revocation path).
 *
 * The env file uses the names in .env.staging.supabase.example. Nothing is written to the database
 * except NOTIFY messages on a dedicated test channel.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

type Env = Record<string, string>;
type Check = { name: string; ok: boolean; detail: string };

export function readEnvFile(path: string): Env {
  const out: Env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function need(env: Env, key: string): string {
  const v = env[key];
  if (!v || v === 'CHANGE_ME') throw new Error(`${key} is not set in the env file`);
  return v;
}

function client(env: Env, user: string, password: string): pg.Client {
  return new pg.Client({
    host: need(env, 'SUPABASE_PGHOST'),
    port: 5432,
    database: 'postgres',
    user,
    password,
    // verify-full: chain against Supabase's CA and the pooler hostname (Node's default identity check).
    ssl: { rejectUnauthorized: true, ca: readFileSync(need(env, 'SUPABASE_CA_FILE'), 'utf8') },
    connectionTimeoutMillis: 15000,
    application_name: 'hrvo-supabase-preflight',
  });
}

async function notifyRoundTrip(env: Env, user: string, password: string): Promise<Check> {
  const listener = client(env, user, password);
  const sender = client(env, user, password);
  const channel = 'hrvo_preflight';
  const token = `t${Date.now()}`;
  await listener.connect();
  await sender.connect();
  try {
    const received = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      listener.on('notification', (msg) => {
        if (msg.channel === channel && msg.payload === token) {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
    await listener.query(`LISTEN ${channel}`);
    await sender.query('SELECT pg_notify($1, $2)', [channel, token]);
    const ok = await received;
    return { name: `LISTEN/NOTIFY across two pooled sessions as ${user.split('.')[0]}`, ok, detail: ok ? 'delivered' : 'not delivered within 5 s (transaction-mode pooler?)' };
  } finally {
    await listener.end();
    await sender.end();
  }
}

/** A connection attempt that must FAIL (e.g. no TLS, or a certificate that does not match the host). */
async function mustFail(config: pg.ClientConfig): Promise<{ failed: boolean; detail: string }> {
  const c = new pg.Client({ ...config, connectionTimeoutMillis: 15000 });
  try {
    await c.connect();
    await c.end();
    return { failed: false, detail: 'connection was accepted' };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { failed: true, detail: `refused (${e.code ?? String(e.message ?? '').slice(0, 80)})` };
  }
}

async function target(env: Env): Promise<Check[]> {
  const checks: Check[] = [];
  const admin = need(env, 'SUPABASE_ADMIN_USER');
  const host = need(env, 'SUPABASE_PGHOST');
  const ref = admin.includes('.') ? admin.slice(admin.indexOf('.') + 1) : '';
  const expectRegion = env.SUPABASE_EXPECT_REGION || 'ap-southeast-1';
  checks.push({ name: 'project reference (compare with Dashboard → Project Settings → Project ID)', ok: /^[a-z0-9]{20}$/.test(ref), detail: ref || 'admin user is not postgres.<project-ref>' });
  checks.push({ name: `session pooler host is Supabase's, region ${expectRegion}, port 5432`, ok: host.endsWith('.pooler.supabase.com') && host.includes(expectRegion), detail: host });
  for (const [userKey, role] of [['SUPABASE_APP_USER', 'hrvo_app'], ['SUPABASE_RETENTION_USER', 'hrvo_retention']] as const) {
    const u = need(env, userKey);
    checks.push({ name: `${userKey} is ${role}.<same project ref>`, ok: u === `${role}.${ref}`, detail: u === `${role}.${ref}` ? 'matches' : 'does not match the admin user\'s project ref' });
  }
  const plain = await mustFail({ host, port: 5432, database: 'postgres', user: admin, password: need(env, 'SUPABASE_ADMIN_PASSWORD'), ssl: false });
  checks.push({ name: 'non-TLS connection is refused (Enforce SSL)', ok: plain.failed, detail: plain.detail });
  const { lookup } = await import('node:dns/promises');
  const ip = (await lookup(host, { family: 4 })).address;
  checks.push({ name: 'pooler reachable over IPv4', ok: true, detail: ip });
  const wrongName = await mustFail({ host: ip, port: 5432, database: 'postgres', user: admin, password: need(env, 'SUPABASE_ADMIN_PASSWORD'), ssl: { rejectUnauthorized: true, ca: readFileSync(need(env, 'SUPABASE_CA_FILE'), 'utf8') } });
  checks.push({ name: 'certificate hostname is verified (connecting by IP must be rejected)', ok: wrongName.failed, detail: wrongName.detail });
  const c = client(env, admin, need(env, 'SUPABASE_ADMIN_PASSWORD'));
  await c.connect();
  try {
    const s = await c.query<{ ssl: boolean; version: string; tls: string | null }>(
      `SELECT s.ssl, current_setting('server_version') AS version, s.version AS tls FROM pg_stat_ssl s WHERE s.pid = pg_backend_pid()`,
    );
    const row = s.rows[0];
    checks.push({ name: 'TLS verified (CA + hostname) through the session pooler', ok: true, detail: `server ssl=${row?.ssl ?? 'n/a via pooler'} ${row?.tls ?? ''}`.trim() });
    const major = Number((await c.query<{ v: string }>(`SELECT current_setting('server_version_num') AS v`)).rows[0].v.slice(0, 2));
    checks.push({ name: 'PostgreSQL major 17 (expected 17.11; repository targets >= 16)', ok: major === 17, detail: `server ${row?.version ?? major}` });
    const r = await c.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>(
      `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`,
    );
    const me = r.rows[0];
    checks.push({ name: 'migration role has BYPASSRLS (definer functions + backfills under FORCE RLS)', ok: me.rolbypassrls || me.rolsuper, detail: `${me.rolname} super=${me.rolsuper} bypassrls=${me.rolbypassrls}` });
    checks.push({ name: 'migration role has CREATEROLE (init migration creates hrvo_app/hrvo_retention)', ok: me.rolcreaterole || me.rolsuper, detail: `createrole=${me.rolcreaterole}` });
    const api = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')`);
    checks.push({ name: 'Supabase API roles present (lockdown will strip their grants)', ok: api.rows[0].n === '3', detail: `${api.rows[0].n}/3` });
    const t = await c.query<{ n: string; names: string | null }>(
      `SELECT count(*)::text AS n, string_agg(c.relname, ', ' ORDER BY c.relname) AS names FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S')`,
    );
    checks.push({ name: 'public schema is empty (fresh project, nothing to collide with)', ok: t.rows[0].n === '0', detail: t.rows[0].n === '0' ? 'empty' : `${t.rows[0].n} objects: ${String(t.rows[0].names).slice(0, 200)}` });
    const roles = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_roles WHERE rolname IN ('hrvo_app','hrvo_retention')`);
    checks.push({ name: 'application roles not yet created', ok: roles.rows[0].n === '0', detail: `${roles.rows[0].n} present` });
    const conn = await c.query<{ max: string }>(`SELECT current_setting('max_connections') AS max`);
    checks.push({ name: 'server max_connections (informational)', ok: true, detail: conn.rows[0].max });
  } finally {
    await c.end();
  }
  checks.push(await notifyRoundTrip(env, admin, need(env, 'SUPABASE_ADMIN_PASSWORD')));
  return checks;
}

async function app(env: Env): Promise<Check[]> {
  const checks: Check[] = [];
  for (const [userKey, passKey, role] of [
    ['SUPABASE_APP_USER', 'SUPABASE_APP_PASSWORD', 'hrvo_app'],
    ['SUPABASE_RETENTION_USER', 'SUPABASE_RETENTION_PASSWORD', 'hrvo_retention'],
  ] as const) {
    const c = client(env, need(env, userKey), need(env, passKey));
    await c.connect();
    try {
      const r = await c.query<{ u: string; s: boolean; b: boolean }>(
        `SELECT current_user AS u, rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname = current_user`,
      );
      const me = r.rows[0];
      checks.push({ name: `${role} logs in through the pooler with verified TLS`, ok: me.u === role, detail: `current_user=${me.u}` });
      checks.push({ name: `${role} is NOSUPERUSER NOBYPASSRLS`, ok: !me.s && !me.b, detail: `super=${me.s} bypassrls=${me.b}` });
      if (role === 'hrvo_app') {
        const n = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM users`);
        checks.push({ name: 'hrvo_app without app.org_id sees no users (FORCE RLS fail-closed)', ok: n.rows[0].n === '0', detail: `${n.rows[0].n} visible` });
        const denied = await c.query(`SELECT 1 FROM _prisma_migrations LIMIT 1`).then(() => false, () => true);
        checks.push({ name: 'hrvo_app cannot read the migration history', ok: denied, detail: denied ? 'permission denied' : 'readable' });
      }
    } finally {
      await c.end();
    }
  }
  const a = client(env, need(env, 'SUPABASE_ADMIN_USER'), need(env, 'SUPABASE_ADMIN_PASSWORD'));
  await a.connect();
  try {
    const m = await a.query<{ n: string; open: string }>(
      `SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::text AS n,
              count(*) FILTER (WHERE finished_at IS NULL)::text AS open FROM _prisma_migrations`,
    );
    checks.push({ name: 'Prisma migrations applied (36 in the repository at ADR 052)', ok: Number(m.rows[0].n) >= 36 && m.rows[0].open === '0', detail: `${m.rows[0].n} applied, ${m.rows[0].open} unfinished` });
  } finally {
    await a.end();
  }
  checks.push(await notifyRoundTrip(env, need(env, 'SUPABASE_APP_USER'), need(env, 'SUPABASE_APP_PASSWORD')));
  return checks;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, file] = process.argv.slice(2);
  if ((mode !== 'target' && mode !== 'app') || !file) {
    console.error('usage: supabase-preflight.ts <target|app> <env-file>');
    process.exit(2);
  }
  (mode === 'target' ? target : app)(readEnvFile(file)).then(
    (checks) => {
      for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
      const failed = checks.filter((c) => !c.ok).length;
      console.log(failed === 0 ? `preflight ${mode}: all ${checks.length} checks passed` : `preflight ${mode}: ${failed} check(s) FAILED`);
      process.exit(failed === 0 ? 0 : 1);
    },
    (err: unknown) => {
      // Error messages from pg/tls name hosts and codes, never passwords.
      console.error(`preflight ${mode} could not complete: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
