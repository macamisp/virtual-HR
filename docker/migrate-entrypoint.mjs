// One-off release task (ADR 020): build the admin connection URL from the RDS-managed secret's
// fields (the password is URL-encoded, never printed), then migrate and set the role passwords.
import { spawnSync } from 'node:child_process';

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`${k} must be set`); process.exit(2); } return v; };
const auth = `${encodeURIComponent(need('PGADMIN_USER'))}:${encodeURIComponent(need('PGADMIN_PASSWORD'))}`;
const where = `${need('PGHOST')}:${process.env.PGPORT || '5432'}/${need('PGDATABASE')}`;
const ca = encodeURIComponent(need('PGSSLROOTCERT'));
// TLS verified against the RDS CA bundle, in each tool's own parameter names.
const prismaUrl = `postgresql://${auth}@${where}?schema=public&sslmode=require&sslaccept=strict&sslcert=${ca}`;
const pgUrl = `postgresql://${auth}@${where}?sslmode=verify-full&sslrootcert=${ca}`;
const steps = [
  [['npx', ['prisma', 'migrate', 'deploy', '--schema', 'apps/api/prisma/schema.prisma']], { DIRECT_DATABASE_URL: prismaUrl, DATABASE_URL: prismaUrl }],
  [['node', ['--experimental-strip-types', 'apps/api/prisma/scripts/provision-db-roles.ts']], { DIRECT_DATABASE_URL: pgUrl }],
];
for (const [[cmd, args], extra] of steps) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...extra } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
