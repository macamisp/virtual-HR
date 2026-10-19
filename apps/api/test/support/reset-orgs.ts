import type pg from 'pg';

/**
 * Deletes test organisations before a suite runs. Under the parallel test run another suite may be
 * inserting into the same tables (presence_events), and Postgres can abort one side of the
 * resulting deadlock (40P01); the delete is then simply retried.
 */
export async function resetOrgs(pool: pg.Pool, ids: string[], attempts = 5): Promise<void> {
  for (let i = 1; ; i += 1) {
    try {
      await pool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [ids]);
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== '40P01' || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 100 * i));
    }
  }
}
