/**
 * Seeds a demo organisation for clicking through apps/web locally (refuses NODE_ENV=production).
 * Re-running resets only this demo org. It uses one published password, so it refuses to run while
 * any configured address (web, API, storage, CORS, tunnel) is public: use seed-internet-demo.ts.
 *
 * Run via: npm run seed:demo
 */
import './support/refuse-in-production.ts'; // must stay the first import
import pg from 'pg';
import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { assertDefaultPasswordsStayLocal } from './support/demo-guard.ts';

const ORG_ID = '44440000-0000-4000-8000-000000000001';
const ORG_SLUG = 'acme-demo';
const TEAM_ID = '44440000-0000-4000-8000-000000000101';
const PASSWORD = 'DemoPassword123!';

const USERS = [
  { id: '44440000-0000-4000-8000-000000000011', email: 'hr@acme.demo', name: 'Hana HR', role: 'HR', team: false },
  { id: '44440000-0000-4000-8000-000000000012', email: 'lead@acme.demo', name: 'Leo Lead', role: 'TEAM_LEAD', team: true },
  { id: '44440000-0000-4000-8000-000000000013', email: 'worker@acme.demo', name: 'Wendy Worker', role: 'EMPLOYEE', team: true },
  { id: '44440000-0000-4000-8000-000000000014', email: 'sam@acme.demo', name: 'Sam Subcontractor', role: 'SUBCONTRACTOR', team: true },
  { id: '44440000-0000-4000-8000-000000000015', email: 'admin@acme.demo', name: 'Ada Admin', role: 'ADMIN', team: false },
  // ADR 037: the workspace owner (SUPER_ADMIN with is_owner); ownership, sign-in settings and billing.
  { id: '44440000-0000-4000-8000-000000000016', email: 'owner@acme.demo', name: 'Oona Owner', role: 'SUPER_ADMIN', team: false },
];

async function main(): Promise<void> {
  assertDefaultPasswordsStayLocal(process.env);
  const pool = new pg.Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5433),
    database: process.env.PGDATABASE || 'hrvo_dev',
    user: process.env.PGADMIN_USER || 'postgres',
    password: process.env.PGADMIN_PASSWORD || 'postgres',
  });
  try {
    await pool.query(`DELETE FROM organizations WHERE id = $1 OR slug = $2`, [ORG_ID, ORG_SLUG]);
    await pool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Acme Demo', $2, 'Asia/Colombo')`, [ORG_ID, ORG_SLUG]);
    await pool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Support')`, [TEAM_ID, ORG_ID]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of USERS) {
      await pool.query(
        `INSERT INTO users (id, org_id, email, display_name, role, team_id, password_hash, status, is_owner)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8)`,
        [u.id, ORG_ID, u.email, u.name, u.role, u.team ? TEAM_ID : null, hash, u.role === 'SUPER_ADMIN'],
      );
    }
    const lead = USERS[1]!.id;
    await pool.query(`UPDATE users SET manager_id = $1 WHERE org_id = $2 AND role IN ('EMPLOYEE', 'SUBCONTRACTOR')`, [lead, ORG_ID]);
    await pool.query(`UPDATE teams SET lead_id = $1 WHERE id = $2`, [lead, TEAM_ID]);

    // A pending invitation so the accept-invitation screen can be tried (normally emailed by HR).
    const inviteToken = randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO invitations (org_id, email, role, team_id, token_hash, invited_by, expires_at)
       VALUES ($1, 'newhire@acme.demo', 'EMPLOYEE', $2, $3, $4, now() + interval '7 days')`,
      [ORG_ID, TEAM_ID, createHash('sha256').update(inviteToken).digest('hex'), USERS[0]!.id],
    );

    const web = process.env.APP_WEB_URL || 'http://localhost:3000';
    console.log('Seeded demo organisation "Acme Demo". All passwords:', PASSWORD);
    for (const u of USERS) console.log(`  ${u.role.padEnd(14)} ${u.email}`);
    console.log('HR, Admin and the Owner must enrol TOTP on first sign-in (authenticator app needed).');
    console.log(`Invitation link for newhire@acme.demo:\n  ${web}/accept-invitation#token=${inviteToken}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('Seeding failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
