/**
 * Deletes the internet demo organisation and everything in it (docs/runbooks/demo-internet.md):
 * users, sessions, attendance, documents rows, notifications. Cascades from organizations.
 * Refuses NODE_ENV=production. Uploaded objects stay in the local bucket until its retention
 * job removes them; the runbook covers wiping the local storage volume.
 *
 * Run via: npm run demo:internet:teardown (also stops the tunnels)
 */
import './support/refuse-in-production.ts'; // must stay the first import
import pg from 'pg';
import { INTERNET_DEMO_ORG_ID, INTERNET_DEMO_SLUG } from './support/internet-demo.ts';

async function main(): Promise<void> {
  const pool = new pg.Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5433),
    database: process.env.PGDATABASE || 'hrvo_dev',
    user: process.env.PGADMIN_USER || 'postgres',
    password: process.env.PGADMIN_PASSWORD || 'postgres',
  });
  try {
    const users = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE org_id = $1`, [INTERNET_DEMO_ORG_ID])).rows[0]!.n;
    const res = await pool.query(`DELETE FROM organizations WHERE id = $1 OR slug = $2`, [INTERNET_DEMO_ORG_ID, INTERNET_DEMO_SLUG]);
    console.log(res.rowCount ? `Deleted the internet demo organisation (${users} users, with their sessions and data).` : 'No internet demo organisation found; nothing to delete.');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('Teardown failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
