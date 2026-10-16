/**
 * Seeds the load-test organisation: N employees who have accepted the monitoring notice, so
 * the k6 script (load/heartbeat.js) can sign in and heartbeat straight away. Writes to the
 * database named by PGDATABASE (meant to be hrvo_load, never a shared one).
 *
 *   PGDATABASE=hrvo_load node --experimental-strip-types apps/api/test/seed-load.ts 200
 */
import argon2 from 'argon2';
import pg from 'pg';
import './support/refuse-in-production.ts';

export const LOAD_ORG = 'add00000-0000-4000-8000-000000000001';
export const LOAD_PASSWORD = 'LoadTestPassword123!';
export const loadEmail = (i: number): string => `load${String(i).padStart(3, '0')}@load.test`;

async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? 200);
  if (!Number.isInteger(count) || count < 1 || count > 5000) throw new Error('count must be 1..5000');
  const database = process.env.PGDATABASE || 'hrvo_load';
  if (!/load/.test(database)) throw new Error(`Refusing to seed load data into "${database}" (name must contain "load")`);
  const pool = new pg.Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5433),
    database,
    user: process.env.PGADMIN_USER || 'postgres',
    password: process.env.PGADMIN_PASSWORD || 'postgres',
  });
  try {
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [LOAD_ORG]);
    await pool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Load Test Ltd', 'load-test', 'Asia/Colombo')`, [LOAD_ORG]);
    const hash = await argon2.hash(LOAD_PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    const ids: string[] = [];
    const emails: string[] = [];
    const names: string[] = [];
    for (let i = 1; i <= count; i += 1) {
      ids.push(`add00000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      emails.push(loadEmail(i));
      names.push(`Load User ${i}`);
    }
    await pool.query(
      `INSERT INTO users (id, org_id, email, display_name, role, password_hash, status)
       SELECT u.id, $1, u.email, u.name, 'EMPLOYEE', $2, 'ACTIVE' FROM unnest($3::uuid[], $4::text[], $5::text[]) AS u(id, email, name)`,
      [LOAD_ORG, hash, ids, emails, names],
    );
    await pool.query(
      `INSERT INTO monitoring_consents (org_id, user_id, notice_version, accepted_at)
       SELECT $1, id, 'v1.0.0', now() FROM unnest($2::uuid[]) AS t(id)`,
      [LOAD_ORG, ids],
    );
    console.log(`Seeded ${count} load users in ${database}: ${loadEmail(1)} .. ${loadEmail(count)} / ${LOAD_PASSWORD}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('Seeding failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
