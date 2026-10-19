#!/usr/bin/env node
/**
 * npm run verify: one command that checks everything and prints one summary.
 *
 *   npm run verify                     all four steps
 *   npm run verify -- --skip=e2e       leave out a step (lint, typecheck, api, e2e; comma-separated)
 *   npm run verify -- --only=api       run just these
 *   npm run verify -- --preflight      only check that the services answer, then stop
 *   npm run verify -- --no-preflight   do not check the services first (not recommended)
 *
 * What it does:
 *   1. Preflight: the database (migrated, both logins work), Redis, document storage, ClamAV, the
 *      KMS emulator and LiveKit must all answer. Several test suites SKIP THEMSELVES when storage or
 *      ClamAV are missing, which would look like a pass; so a missing service stops the run here.
 *   2. lint, typecheck (API + web), API tests, Playwright (browser) tests.
 *   3. A summary table (pass / fail / skipped per step), every skipped test with its reason, and
 *      the measured accuracy numbers for NFR-ACC-001..004 (SRS 6.5) read from the test output.
 *
 * Exit code: 0 everything passed and nothing was skipped unexpectedly; 1 a failure or an unexpected
 * skip; 2 a service is missing (preflight). Full logs: verify-logs/ (not committed).
 * Only skip allowed: the two real-recording browser tests, unless LIVEKIT_EGRESS=1 (docs/runbooks/uat.md).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const logDir = join(root, 'verify-logs');
const STEPS = ['lint', 'typecheck', 'api', 'e2e'];

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]?.split(',').filter(Boolean);
if (args.includes('--help') || args.includes('-h')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*?\n?/, '').replace(/^ \* ?/gm, '')); process.exit(0); }
const only = flag('only');
const skip = flag('skip') ?? [];
for (const s of [...(only ?? []), ...skip]) if (!STEPS.includes(s)) { console.error(`Unknown step "${s}". Steps: ${STEPS.join(', ')}`); process.exit(2); }
const wanted = STEPS.filter((s) => (only ? only.includes(s) : true) && !skip.includes(s));

// ---------------------------------------------------------------- environment
function readDotenv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}
const dotenv = readDotenv(join(root, '.env'));
// Settings the tests need regardless of a developer's .env (the same ones CI sets).
const TEST_SETTINGS = {
  NODE_ENV: 'test', BREACHED_PASSWORD_CHECK: 'local', MAIL_TRANSPORT: 'memory', JOBS_ENABLED: 'false',
  AUTH_MFA_ENFORCEMENT: '', RATE_LIMIT_VAULT: '500', RATE_LIMIT_SHARE: '500', S3_CREATE_BUCKET: 'true',
  KMS_TEST_ENDPOINT: 'http://127.0.0.1:4566',
};
// Priority: what you exported > the test settings above > .env.
const env = { ...dotenv, ...TEST_SETTINGS, ...process.env };
const get = (k, d = '') => (env[k] !== undefined && env[k] !== '' ? env[k] : d);

// ---------------------------------------------------------------- preflight
const tcp = (host, port, send, expect) => new Promise((resolve) => {
  const s = net.connect({ host, port: Number(port), timeout: 4000 });
  let buf = '';
  const done = (ok, detail) => { s.destroy(); resolve({ ok, detail }); };
  s.on('connect', () => { if (send) s.write(send); else done(true, 'connected'); });
  s.on('data', (d) => { buf += d.toString(); if (!expect || buf.includes(expect)) done(true, expect ? `answered ${expect}` : 'connected'); });
  s.on('timeout', () => done(false, 'no answer in 4 s'));
  s.on('error', (e) => done(false, e.code || e.message));
  s.on('close', () => { if (expect && !buf.includes(expect)) resolve({ ok: false, detail: `unexpected answer "${buf.slice(0, 30)}"` }); });
});
const http = async (url) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(4000) }); return { ok: true, detail: `HTTP ${r.status}` }; } catch (e) { return { ok: false, detail: e.cause?.code || e.message }; } };

async function database() {
  let pg;
  try { pg = (await import('pg')).default; } catch { return { ok: false, detail: 'package "pg" missing (run npm install)' }; }
  const base = { host: get('PGHOST', 'localhost'), port: Number(get('PGPORT', '5433')), database: get('PGDATABASE', 'hrvo_dev'), connectionTimeoutMillis: 4000 };
  const login = async (user, password) => { const c = new pg.Client({ ...base, user, password }); await c.connect(); return c; };
  let admin;
  try { admin = await login(get('PGADMIN_USER', 'postgres'), get('PGADMIN_PASSWORD', 'postgres')); }
  catch (e) { return { ok: false, detail: `cannot sign in as the admin user at ${base.host}:${base.port} (${e.code || e.message})` }; }
  try {
    const applied = Number((await admin.query('SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL')).rows[0].n);
    const onDisk = readdirSync(join(root, 'apps/api/prisma/migrations'), { withFileTypes: true }).filter((d) => d.isDirectory()).length;
    if (applied < onDisk) return { ok: false, detail: `${applied} of ${onDisk} migrations applied`, fix: 'npm run db:migrate' };
  } catch { return { ok: false, detail: 'database is empty (no migrations)', fix: 'npm run db:migrate' }; }
  finally { await admin.end(); }
  try { (await login(get('PGUSER', 'hrvo_app'), get('PGPASSWORD', 'hrvo_app_pass'))).end(); }
  catch { return { ok: false, detail: `the application login "${get('PGUSER', 'hrvo_app')}" cannot sign in`, fix: 'npm run db:provision-roles' }; }
  return { ok: true, detail: 'migrated; admin and application logins work' };
}

async function preflight() {
  const s3 = (() => { try { const u = new URL(get('S3_ENDPOINT')); return { host: u.hostname, port: u.port || 80 }; } catch { return null; } })();
  const lk = (() => { try { return new URL(get('LIVEKIT_HTTP_URL', 'http://localhost:7880')).origin; } catch { return 'http://localhost:7880'; } })();
  const checks = [
    ['PostgreSQL', database(), 'docker compose up -d'],
    ['Redis', tcp(get('REDIS_HOST', 'localhost'), get('REDIS_PORT', '6379'), 'PING\r\n', '+PONG'), 'docker compose up -d'],
    ['Document storage (S3)', s3 ? tcp(s3.host, s3.port) : Promise.resolve({ ok: false, detail: 'S3_ENDPOINT is not set in .env' }), 'docker compose up -d storage; set S3_* in .env'],
    ['ClamAV', tcp(get('CLAMAV_HOST', 'localhost'), get('CLAMAV_PORT', '3310'), 'zPING\0', 'PONG'), 'docker compose up -d clamav (the first start loads virus signatures for a few minutes)'],
    ['KMS emulator', http(get('KMS_TEST_ENDPOINT')), 'docker compose up -d kms'],
    ['LiveKit', http(lk), 'docker compose up -d livekit'],
  ];
  const results = await Promise.all(checks.map(async ([name, p, fix]) => ({ name, fix, ...(await p) })));
  const secrets = ['DOCUMENT_KMS_LOCAL_KEY', 'DOCUMENT_KMS_RECOVERY_KEY'].filter((k) => !get(k));
  results.push({ name: 'Encryption keys in .env', ok: secrets.length === 0, detail: secrets.length ? `missing ${secrets.join(', ')}` : 'present', fix: 'npm run setup' });
  return results;
}

// ---------------------------------------------------------------- running steps
function run(step, command, cmdArgs) {
  return new Promise((resolve) => {
    mkdirSync(logDir, { recursive: true });
    const started = Date.now();
    const chunks = [];
    const child = spawn(command, cmdArgs, { cwd: root, env, shell: process.platform === 'win32' });
    const onData = (d) => { chunks.push(d); process.stderr.write('.'); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      const output = Buffer.concat(chunks).toString('utf8').replace(/\x1b\[[0-9;]*m/g, '');
      writeFileSync(join(logDir, `${step}.log`), output);
      resolve({ code: code ?? 1, output, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}
const stage = async (label, fn) => { process.stderr.write(`\n${label} `); const r = await fn(); process.stderr.write(` ${r.code === 0 ? 'ok' : 'FAILED'} (${r.seconds} s)\n`); return r; };

function parseTap(output) {
  const n = (k) => Number(output.match(new RegExp(`^# ${k} (\\d+)$`, 'm'))?.[1] ?? 0);
  const skipped = [];
  for (const m of output.matchAll(/^\s*(?:not )?ok \d+ - (.+?) # SKIP\S*\s*(.*)$/gm)) skipped.push({ name: m[1], reason: m[2] || 'skipped by the test itself' });
  return { total: n('tests'), pass: n('pass'), fail: n('fail'), cancelled: n('cancelled'), skipped: n('skipped'), skippedList: skipped };
}
function parsePlaywright(output) {
  const n = (word) => Number(output.match(new RegExp(`^\\s+(\\d+) ${word}\\b`, 'm'))?.[1] ?? 0);
  const skippedList = [...output.matchAll(/^\s*-\s+\d+ \[chromium\] › (e2e\/[^\s]+?\.spec\.ts):\d+:\d+ › (.+)$/gm)].map((m) => ({ file: m[1], name: m[2].trim() }));
  return { pass: n('passed'), fail: n('failed') + n('interrupted'), skipped: n('skipped'), flaky: n('flaky'), notRun: n('did not run'), skippedList };
}

// ---------------------------------------------------------------- accuracy numbers (SRS 6.5)
function accuracy(apiOut, e2eOut) {
  const rows = [];
  const all = `${e2eOut}\n${apiOut}`;
  const a1 = all.match(/NFR-ACC-001 clock-in after first activity \(ms\):[^|]*\| p50 (\d+) \| p99 (\d+) \| max (\d+) \| (\d+)\/(\d+) within 5 s/);
  rows.push(['NFR-ACC-001', 'Clock-in within 5 s of the first activity (99 % of runs)', a1 ? `${a1[5]} sign-ins: median ${a1[1]} ms, 99th percentile ${a1[2]} ms, slowest ${a1[3]} ms; ${a1[4]}/${a1[5]} within 5 s` : null, a1 ? Number(a1[4]) / Number(a1[5]) >= 0.99 && Number(a1[3]) <= 5000 : null]);
  const a2 = [...all.matchAll(/NFR-ACC-002 (logout|tab close|network loss): clock_out_at is (-?[\d.]+) s before the last activity \(source (\w+)\); session closed ([\d.]+) s after the event/g)];
  const worst = a2.reduce((m, x) => Math.max(m, Math.abs(Number(x[2]))), 0);
  rows.push(['NFR-ACC-002', 'Clock-out within 30 s of the last activity (logout, tab close, network loss)', a2.length ? a2.map((x) => `${x[1]}: clock-out ${Math.abs(Number(x[2])).toFixed(1)} s off, closed ${x[4]} s after the event`).join('; ') : null, a2.length === 3 ? worst <= 30 : null]);
  const lo = all.match(/NFR-ACC-002 logout: session closed (\d+) ms after the logout request/);
  if (lo) rows.push(['FR-ATT-002', 'Logout closes the session at once (API, measured)', `closed ${lo[1]} ms after the logout request`, Number(lo[1]) < 1000]);
  const a3 = all.match(/NFR-ACC-003 two devices: wall-clock span (\d+) s \| counted net (\d+) s \| raw active counters from both devices (\d+) s/);
  rows.push(['NFR-ACC-003', 'No double counting on two devices', a3 ? `wall clock ${a3[1]} s, counted ${a3[2]} s (the devices' raw counters add up to ${a3[3]} s)` : null, a3 ? Number(a3[2]) <= Number(a3[1]) + 1 : null]);
  const a4 = all.match(/NFR-ACC-004 replay \S+: (\d+) people, (\d+) differences/);
  const a4d = all.match(/NFR-ACC-004 drift: a total altered by (\d+) s was reported \(([^)]*)\)/);
  rows.push(['NFR-ACC-004', 'Nightly replay finds any difference in daily totals', a4 && a4d ? `clean day: ${a4[1]} people, ${a4[2]} differences; a total altered by ${a4d[1]} s was reported (${a4d[2]})` : null, a4 && a4d ? Number(a4[2]) === 0 : null]);
  return rows;
}

// ---------------------------------------------------------------- report
const pad = (v, n) => String(v).padEnd(n);
const lines = [];
const out = (l = '') => { lines.push(l); console.log(l); };

if (args.includes('--preflight')) {
  const checks = await preflight();
  for (const c of checks) out(`  ${c.ok ? 'OK     ' : 'MISSING'}  ${pad(c.name, 26)} ${c.detail}${c.ok ? '' : `\n           fix: ${c.fix}`}`);
  out(checks.every((c) => c.ok) ? '\nAll services answer. You can run: npm run verify' : '\nSomething is missing. See docs/runbooks/web-local.md, section 1 and 7.');
  process.exit(checks.every((c) => c.ok) ? 0 : 2);
}

console.error(`HRVO verify: ${wanted.join(', ')}`);
if (!args.includes('--no-preflight') && wanted.some((s) => s === 'api' || s === 'e2e')) {
  const checks = await preflight();
  const bad = checks.filter((c) => !c.ok);
  if (bad.length) {
    out('Preflight: a required service is missing. Nothing was run, because several tests would skip themselves and look like a pass.\n');
    for (const c of checks) out(`  ${c.ok ? 'OK     ' : 'MISSING'}  ${pad(c.name, 26)} ${c.detail}${c.ok ? '' : `\n           fix: ${c.fix}`}`);
    out('\nSee docs/runbooks/web-local.md, section 1.');
    process.exit(2);
  }
  console.error(`Preflight ok (${checks.map((c) => c.name).join(', ')})`);
}

const result = {};
if (wanted.includes('lint')) result.lint = await stage('lint', () => run('lint', 'npm', ['run', '-s', 'lint']));
if (wanted.includes('typecheck')) {
  result.typecheck = await stage('typecheck', async () => {
    const a = await run('typecheck-api', 'npm', ['run', '-s', 'typecheck']);
    const b = await run('typecheck-web', 'npm', ['run', '-s', 'web:typecheck']);
    return { code: a.code || b.code, output: a.output + b.output, seconds: a.seconds + b.seconds };
  });
}
if (wanted.includes('api') || wanted.includes('e2e')) {
  const build = await stage('build', () => run('build', 'npx', ['tsc']));
  if (build.code !== 0) { result.api = { code: 1, output: build.output, seconds: build.seconds, build: true }; wanted.splice(wanted.indexOf('api'), 1); wanted.splice(wanted.indexOf('e2e'), 1); }
}
if (wanted.includes('api')) {
  const files = readdirSync(join(root, 'dist/apps/api/test')).filter((f) => f.endsWith('.test.js')).sort().map((f) => `dist/apps/api/test/${f}`);
  result.api = await stage(`API tests (${files.length} files)`, () => run('api', 'node', ['--test', '--test-concurrency=4', '--test-reporter=tap', ...files]));
}
if (wanted.includes('e2e')) result.e2e = await stage('Browser tests (Playwright)', () => run('e2e', 'npm', ['run', '-s', 'e2e', '-w', '@hrvo/web', '--', '--reporter=list']));

out('\n=== HRVO verification summary ===\n');
out(`${pad('Step', 28)}${pad('Result', 9)}${pad('Passed', 9)}${pad('Failed', 9)}${pad('Skipped', 9)}Time`);
out('-'.repeat(72));
let failed = false;
const unexpectedSkips = [];
const row = (name, ok, p, f, s, t) => out(`${pad(name, 28)}${pad(ok ? 'PASS' : 'FAIL', 9)}${pad(p, 9)}${pad(f, 9)}${pad(s, 9)}${t} s`);
for (const step of ['lint', 'typecheck']) if (result[step]) { const ok = result[step].code === 0; failed ||= !ok; row(step === 'lint' ? 'Lint (API, shared, web)' : 'Typecheck (API + web)', ok, '-', ok ? 0 : '1+', '-', result[step].seconds); }
let api = null; let e2e = null;
if (result.api) {
  if (result.api.build) { failed = true; row('API tests', false, '-', 'build', '-', result.api.seconds); }
  else {
    api = parseTap(result.api.output);
    const ok = result.api.code === 0 && api.fail === 0 && api.cancelled === 0 && api.total > 0;
    failed ||= !ok;
    row('API tests', ok, api.pass, api.fail + api.cancelled, api.skipped, result.api.seconds);
    for (const s of api.skippedList) unexpectedSkips.push(`API: ${s.name} (${s.reason})`);
    if (api.skipped > 0 && !api.skippedList.length) unexpectedSkips.push(`API: ${api.skipped} test(s) skipped`);
  }
}
if (result.e2e) {
  e2e = parsePlaywright(result.e2e.output);
  const ok = result.e2e.code === 0 && e2e.fail === 0 && e2e.notRun === 0 && e2e.pass > 0;
  failed ||= !ok;
  row('Browser tests (Playwright)', ok, e2e.pass, e2e.fail + e2e.notRun, e2e.skipped, result.e2e.seconds);
  const egress = env.LIVEKIT_EGRESS === '1';
  for (const s of e2e.skippedList) if (egress || !s.file.includes('22-recording')) unexpectedSkips.push(`Browser: ${s.file} › ${s.name}`);
}
out('-'.repeat(72));

if (api || e2e) {
  out('\nMeasured accuracy (SRS 6.5):\n');
  for (const [id, what, value, ok] of accuracy(api ? result.api.output : '', e2e ? result.e2e.output : '')) {
    out(`  ${pad(id, 12)} ${ok === null ? 'NOT MEASURED' : ok ? 'PASS' : 'FAIL'}  ${what}`);
    out(`${' '.repeat(26)}${value ?? '(the step that prints this number was not run, or did not reach it)'}`);
    if (ok === false) failed = true;
  }
}
const allowed = [];
if (e2e && !(env.LIVEKIT_EGRESS === '1')) allowed.push('Browser: the 2 real-recording tests (22-recording) need the LiveKit Egress container; set LIVEKIT_EGRESS=1 after "docker compose --profile recording up -d"');
if (allowed.length || unexpectedSkips.length) {
  out('\nSkipped tests:');
  for (const a of allowed) out(`  allowed     ${a}`);
  for (const u of unexpectedSkips) out(`  UNEXPECTED  ${u}`);
}
if (unexpectedSkips.length) failed = true;
if (e2e?.flaky) out(`\nNote: ${e2e.flaky} browser test(s) passed only on a retry.`);

out(`\nOverall: ${failed ? 'FAIL' : 'PASS'}   (logs in verify-logs/)`);
mkdirSync(logDir, { recursive: true });
writeFileSync(join(logDir, 'summary.txt'), `${lines.join('\n')}\n`);
process.exit(failed ? 1 : 0);
