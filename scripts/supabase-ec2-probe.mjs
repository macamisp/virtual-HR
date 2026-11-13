#!/usr/bin/env node
// Minimal Supabase checks from the EC2 host (ADR 052), run INSIDE the existing API image as the
// restricted runtime roles only. Read-only apart from NOTIFY on a test channel and rolled-back probes.
// Prints no secrets. Started by scripts/supabase-ec2-probe.sh; the env file is mounted at /run/sb.env.
//
//   1 connectivity  2 verified TLS  4 RLS fail-closed / no bypass  5 logout DB-time budget  6 pool + LISTEN/NOTIFY
import { readFileSync } from 'node:fs';
import pg from 'pg';

const EXPECT_HOST = 'aws-0-ap-southeast-2.pooler.supabase.com';
const EXPECT_REF = 'czagpdusgatugojguwgf';
const LOGOUT_ROUND_TRIPS = 44; // measured sequential DB round trips of the FR-ATT-002 logout path
const LOGOUT_DB_BUDGET_MS = 500; // half of the 1 s requirement, leaving the rest for the app

const env = {};
for (const line of readFileSync(process.argv[2] ?? '/run/sb.env', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (!m) continue;
  let v = m[2].trim();
  if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
  env[m[1]] = v;
}
const ca = readFileSync(process.argv[3] ?? '/run/supabase-tls/ca.crt', 'utf8');
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); };

check('no Supabase admin password on this host', !env.SUPABASE_ADMIN_PASSWORD, env.SUPABASE_ADMIN_PASSWORD ? 'present: remove it' : 'absent');
check('target is the Sydney session pooler', env.SUPABASE_PGHOST === EXPECT_HOST, env.SUPABASE_PGHOST ?? 'unset');
for (const k of ['SUPABASE_APP_USER', 'SUPABASE_RETENTION_USER'])
  check(`${k} belongs to project ${EXPECT_REF}`, (env[k] ?? '').endsWith(`.${EXPECT_REF}`), 'checked by suffix');

const mk = (user, password, app = 'hrvo-ec2-probe') => new pg.Client({
  host: env.SUPABASE_PGHOST, port: 5432, database: 'postgres', user, password,
  ssl: { rejectUnauthorized: true, ca }, // verify-full: chain + hostname
  connectionTimeoutMillis: 15000, application_name: app,
});
const appUser = [env.SUPABASE_APP_USER, env.SUPABASE_APP_PASSWORD];

try {
  // 1 + 2
  for (const [label, u, p] of [['hrvo_app', ...appUser], ['hrvo_retention', env.SUPABASE_RETENTION_USER, env.SUPABASE_RETENTION_PASSWORD]]) {
    const c = mk(u, p);
    const t0 = performance.now();
    await c.connect();
    const ms = Math.round(performance.now() - t0);
    const r = (await c.query(`SELECT current_user u, current_setting('server_version') v,
      (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) ssl,
      (SELECT version FROM pg_stat_ssl WHERE pid = pg_backend_pid()) tls`)).rows[0];
    check(`${label} connects with verified TLS`, r.u === label && r.ssl === true, `user=${r.u} pg=${r.v} ${r.tls} connect=${ms} ms`);
    await c.end();
  }

  const c = mk(...appUser);
  await c.connect();

  // 4 RLS
  const n = async (sql) => Number((await c.query(sql)).rows[0].n);
  check('no tenant context: users invisible', (await n('SELECT count(*) n FROM users')) === 0, 'FORCE RLS fail-closed');
  await c.query('BEGIN');
  await c.query(`SELECT set_config('app.org_id', gen_random_uuid()::text, true)`);
  const other = await n('SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM organizations) + (SELECT count(*) FROM attendance_sessions) n');
  await c.query('ROLLBACK');
  check('foreign tenant context: nothing visible', other === 0, `${other} rows`);
  const denied = async (sql) => { try { await c.query(sql); return false; } catch { return true; } };
  check('hrvo_app cannot read migration history', await denied('SELECT 1 FROM _prisma_migrations LIMIT 1'), 'permission denied');
  check('hrvo_app cannot SET ROLE postgres', await denied('SET ROLE postgres'), 'denied');
  check('row_security=off is refused for hrvo_app', await denied('BEGIN; SET LOCAL row_security = off; SELECT count(*) FROM users; COMMIT'), 'error raised');
  await c.query('ROLLBACK').catch(() => {});
  const attrs = (await c.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0];
  check('hrvo_app is NOSUPERUSER NOBYPASSRLS', !attrs.rolsuper && !attrs.rolbypassrls, JSON.stringify(attrs));

  // 5 logout DB-time budget: the logout path's sequential round trips inside one transaction
  const rtts = [];
  for (let i = 0; i < 30; i++) { const t = performance.now(); await c.query('SELECT 1'); rtts.push(performance.now() - t); }
  rtts.sort((a, b) => a - b);
  const p50 = rtts[15], p95 = rtts[28];
  await c.query('BEGIN');
  const t1 = performance.now();
  for (let i = 0; i < LOGOUT_ROUND_TRIPS; i++) await c.query(`SELECT set_config('app.org_id', gen_random_uuid()::text, true)`);
  const tx = Math.round(performance.now() - t1);
  await c.query('ROLLBACK');
  check(`logout DB time (${LOGOUT_ROUND_TRIPS} sequential round trips) under ${LOGOUT_DB_BUDGET_MS} ms`, tx < LOGOUT_DB_BUDGET_MS,
    `${tx} ms; RTT p50=${p50.toFixed(1)} ms p95=${p95.toFixed(1)} ms`);

  // 6 pool: the API's hrvo_app worst case at L=3, P=2 (L + 3P + 1 = 10, ADR 052)
  const pool = Array.from({ length: 10 }, (_, i) => mk(...appUser, `hrvo-ec2-probe-pool-${i}`));
  const tp = performance.now();
  const opened = await Promise.allSettled(pool.map((p) => p.connect()));
  const okCount = opened.filter((o) => o.status === 'fulfilled').length;
  const seen = await n(`SELECT count(*) n FROM pg_stat_activity WHERE usename = current_user`);
  check('10 concurrent hrvo_app sessions through the session pooler', okCount === 10,
    `${okCount}/10 opened in ${Math.round(performance.now() - tp)} ms; ${seen} hrvo_app backends visible (pool 15)`);
  await Promise.allSettled(pool.map((p) => p.end()));

  const listener = mk(...appUser, 'hrvo-ec2-probe-listen');
  await listener.connect();
  await listener.query('LISTEN hrvo_preflight');
  const token = `ec2-${Date.now()}`;
  const got = new Promise((res) => {
    const timer = setTimeout(() => res(-1), 5000);
    listener.on('notification', (m) => { if (m.payload === token) { clearTimeout(timer); res(performance.now()); } });
  });
  const ts = performance.now();
  await c.query(`SELECT pg_notify('hrvo_preflight', $1)`, [token]);
  const at = await got;
  check('LISTEN/NOTIFY across two pooled sessions', at > 0, at > 0 ? `delivered in ${Math.round(at - ts)} ms` : 'not delivered in 5 s');
  await listener.end();
  await c.end();
} catch (e) {
  check('probe completed', false, e instanceof Error ? e.message.replace(/postgres(ql)?:\/\/\S+/g, '<url>') : 'error');
}

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `supabase-ec2-probe: ${failed} FAILED` : `supabase-ec2-probe: all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
