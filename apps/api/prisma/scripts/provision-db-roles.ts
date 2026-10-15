/**
 * Sets login passwords for the hrvo_app and hrvo_retention roles created by the
 * init migration. Run after `prisma migrate deploy`.
 *
 * Passwords are deliberately not in versioned migration SQL (AGENTS.md: no secrets
 * in code). This script changes credentials only, never schema; Prisma Migrate stays
 * the single migration tool (ADR 004).
 *
 * Env: DIRECT_DATABASE_URL (schema owner / admin), PGPASSWORD (hrvo_app),
 *      PGRETENTION_PASSWORD (hrvo_retention).
 */
import { pathToFileURL } from 'node:url';
import pg from 'pg';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`${name} must be set`);
  }
  return value;
}

export async function provisionDbRoles(): Promise<void> {
  const client = new pg.Client({ connectionString: requireEnv('DIRECT_DATABASE_URL') });
  const roles: Array<[string, string]> = [
    ['hrvo_app', requireEnv('PGPASSWORD')],
    ['hrvo_retention', requireEnv('PGRETENTION_PASSWORD')],
  ];

  await client.connect();
  try {
    for (const [role, password] of roles) {
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (exists.rowCount === 0) {
        throw new Error(`Role ${role} does not exist; run prisma migrate deploy first`);
      }
      // ALTER ROLE does not accept bind parameters; escapeLiteral quotes safely.
      await client.query(`ALTER ROLE ${client.escapeIdentifier(role)} WITH LOGIN PASSWORD ${client.escapeLiteral(password)}`);
      console.log(`Provisioned login for role ${role}`);
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  provisionDbRoles().catch((err: unknown) => {
    console.error('Role provisioning failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
