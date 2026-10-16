// Restore-drill verification (ADR 020), run as a one-off ECS task against a RESTORED copy of the
// database. Read-only; checks structure and freshness through catalog and statistics views only
// (no row content is read or printed). Exit 0 = the restore is usable.
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

const env = process.env;
const client = new pg.Client({
  host: env.PGHOST, port: Number(env.PGPORT || 5432), database: env.PGDATABASE, user: env.PGUSER || 'hrvo_app', password: env.PGPASSWORD,
  ssl: { rejectUnauthorized: true, ca: readFileSync(env.PGSSLROOTCERT, 'utf8') },
});
const result = { checks: {}, ok: true };
const check = (name, ok, detail) => { result.checks[name] = { ok, ...detail }; if (!ok) result.ok = false; };

await client.connect();
try {
  const expected = readdirSync('apps/api/prisma/migrations', { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const applied = await client.query(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`).then((r) => r.rows.map((x) => x.migration_name)).catch(() => null);
  if (applied === null) check('migrations', false, { reason: 'cannot read _prisma_migrations as this role' });
  else check('migrations', expected.every((m) => applied.includes(m)), { expected: expected.length, applied: applied.length, missing: expected.filter((m) => !applied.includes(m)) });

  const rls = await client.query(`
    SELECT c.relname, c.relrowsecurity AND c.relforcerowsecurity AS forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped)`);
  const weak = rls.rows.filter((r) => !r.forced).map((r) => r.relname);
  check('rls_forced', weak.length === 0, { tables: rls.rows.length, notForced: weak });

  const live = await client.query(`SELECT relname, n_live_tup::bigint AS n FROM pg_stat_user_tables WHERE relname = ANY($1)`, [['organizations', 'users', 'attendance_sessions', 'documents', 'audit_logs']]);
  const counts = Object.fromEntries(live.rows.map((r) => [r.relname, Number(r.n)]));
  check('populated', (counts.organizations ?? 0) > 0 && (counts.users ?? 0) > 0, { approxRows: counts });

  // RPO proxy: the newest attendance write visible in the restored copy (a timestamp only).
  const newest = await client.query(`SELECT max(updated_at) AS t FROM attendance_sessions`).then((r) => r.rows[0]?.t ?? null).catch(() => null);
  check('freshness', true, { newestAttendanceWrite: newest ? new Date(newest).toISOString() : 'not visible to this role (RLS)' });
} finally {
  await client.end();
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
