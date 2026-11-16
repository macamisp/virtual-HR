/** FR-AUTH-010, FR-REP-009: adversarial checks for the presence migration. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { resetOrgs } from './support/reset-orgs.ts';

describe('Office presence database security', () => {
  const org = randomUUID();
  const other = randomUUID();
  const person = randomUUID();
  let pool: pg.Pool;
  before(async () => {
    pool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Security', $1::text), ($2::uuid, 'Other', $2::text)`, [org, other]);
    await pool.query(`INSERT INTO users (id, org_id, email, role) VALUES ($1, $2, 'presence-security@example.test', 'EMPLOYEE')`, [person, org]);
  });
  after(async () => { await resetOrgs(pool, [org, other]); await pool.end(); });

  async function asApp(check: (db: pg.PoolClient) => Promise<void>) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SET LOCAL ROLE hrvo_app');
      await db.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
      await check(db);
    } finally { await db.query('ROLLBACK'); db.release(); }
  }

  it('rejects an interval linked to a person in another tenant even for the schema owner', async () => {
    await assert.rejects(pool.query(`INSERT INTO office_presence_intervals (org_id, user_id, started_at, last_seen_at) VALUES ($1, $2, now(), now())`, [other, person]), { code: '23503' });
  });

  it('cannot shadow the definer target through a temporary table', async () => {
    await asApp(async (db) => {
      await db.query(`CREATE TEMP TABLE office_presence_intervals (ended_at timestamptz, last_seen_at timestamptz, end_reason text)`);
      await db.query(`INSERT INTO pg_temp.office_presence_intervals VALUES (NULL, now() - interval '1 hour', NULL)`);
      await db.query(`SELECT public.fn_close_stale_office_presence(now())`);
      const r = await db.query(`SELECT ended_at FROM pg_temp.office_presence_intervals`);
      assert.equal(r.rows[0].ended_at, null, 'the definer must never resolve the caller temporary table');
    });
  });

  it('a future cutoff cannot close fresh intervals across tenants', async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO office_presence_intervals (id, org_id, user_id, started_at, last_seen_at) VALUES ($1, $2, $3, now(), now())`, [id, org, person]);
    try {
      await asApp(async (db) => {
        await db.query(`SELECT public.fn_close_stale_office_presence('infinity'::timestamptz)`);
        const r = await db.query(`SELECT ended_at FROM public.office_presence_intervals WHERE id = $1`, [id]);
        assert.equal(r.rows[0].ended_at, null, 'database enforces the minimum stale age');
      });
    } finally { await pool.query(`DELETE FROM office_presence_intervals WHERE id = $1`, [id]); }
  });

  it('restricts deletion, truncation, function execution and duplicate open intervals', async () => {
    const r = await pool.query(`SELECT has_table_privilege('hrvo_app', 'office_presence_intervals', 'DELETE') AS app_delete,
      has_table_privilege('hrvo_app', 'office_presence_intervals', 'TRUNCATE') AS app_truncate,
      has_table_privilege('hrvo_retention', 'office_presence_intervals', 'DELETE') AS retention_delete,
      has_function_privilege('hrvo_retention', 'fn_close_stale_office_presence(timestamptz)', 'EXECUTE') AS retention_execute`);
    assert.deepEqual(r.rows[0], { app_delete: false, app_truncate: false, retention_delete: true, retention_execute: false });
    await asApp(async (db) => {
      await db.query(`INSERT INTO office_presence_intervals (org_id, user_id, started_at, last_seen_at) VALUES ($1, $2, now(), now())`, [org, person]);
      await assert.rejects(db.query(`INSERT INTO office_presence_intervals (org_id, user_id, started_at, last_seen_at) VALUES ($1, $2, now(), now())`, [org, person]), { code: '23505' });
    });
  });
});
