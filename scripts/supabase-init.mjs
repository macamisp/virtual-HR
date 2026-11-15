#!/usr/bin/env node
// Initialise / update a Supabase database from the workstation (ADR 052) with exactly the code path the
// EC2 migrate job uses (docker/migrate-entrypoint.mjs): lockdown pre → prisma migrate deploy → role
// passwords → lockdown post + verify. Reads SUPABASE_* names from a private env file; prints no secrets.
//
//   node scripts/supabase-init.mjs /path/to/supabase.env
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/supabase-init.mjs <env-file>'); process.exit(2); }
if ((statSync(file).mode & 0o077) !== 0) { console.error(`${file} must not be readable by group/others (chmod 600)`); process.exit(2); }

const env = {};
for (const line of readFileSync(file, 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (!m) continue;
  let v = m[2].trim();
  if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
  env[m[1]] = v;
}
const need = (k) => { const v = env[k]; if (!v || v === 'CHANGE_ME') { console.error(`${k} is not set in ${file}`); process.exit(2); } return v; };

const mapped = {
  PGHOST: need('SUPABASE_PGHOST'),
  PGPORT: '5432',
  PGDATABASE: 'postgres',
  PGADMIN_USER: need('SUPABASE_ADMIN_USER'),
  PGADMIN_PASSWORD: need('SUPABASE_ADMIN_PASSWORD'),
  PGPASSWORD: need('SUPABASE_APP_PASSWORD'),
  PGRETENTION_PASSWORD: need('SUPABASE_RETENTION_PASSWORD'),
  PGSSLROOTCERT: need('SUPABASE_CA_FILE'),
};
// Drop any DB settings inherited from the shell or a local .env so nothing points elsewhere.
const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PG|DATABASE_URL|DIRECT_DATABASE_URL)/.test(k)));
const r = spawnSync('node', ['docker/migrate-entrypoint.mjs'], { stdio: 'inherit', env: { ...base, ...mapped } });
process.exit(r.status ?? 1);
