/**
 * Seeds the internet demo organisation (docs/runbooks/demo-internet.md). Every run generates a
 * new random password per account and prints it once; only Argon2id hashes are stored. HR and
 * admins must enrol 2FA at their first sign-in (FR-AUTH-004 stays enforced). Re-running resets
 * only this organisation; demo-internet-teardown.ts deletes it.
 *
 * Refuses NODE_ENV=production and development-only settings (AUTH_MFA_ENFORCEMENT=off, the
 * development JWT or LiveKit secret, the local breached-password stub).
 *
 * Run via: npm run seed:demo:internet
 */
import './support/refuse-in-production.ts'; // must stay the first import
import pg from 'pg';
import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { assertInternetDemoSafe, strongPassword } from './support/demo-guard.ts';
import { INTERNET_DEMO_ORG_ID, INTERNET_DEMO_SLUG } from './support/internet-demo.ts';

const TEAM_ID = 'de300000-0000-4000-8000-000000000101';

const USERS = [
  { id: 'de300000-0000-4000-8000-000000000011', email: 'hr@internet.demo', name: 'Hana HR', role: 'HR', team: false },
  { id: 'de300000-0000-4000-8000-000000000012', email: 'lead@internet.demo', name: 'Leo Lead', role: 'TEAM_LEAD', team: true },
  { id: 'de300000-0000-4000-8000-000000000013', email: 'worker@internet.demo', name: 'Wendy Worker', role: 'EMPLOYEE', team: true },
  { id: 'de300000-0000-4000-8000-000000000014', email: 'sam@internet.demo', name: 'Sam Subcontractor', role: 'SUBCONTRACTOR', team: true },
  { id: 'de300000-0000-4000-8000-000000000015', email: 'admin@internet.demo', name: 'Ada Admin', role: 'ADMIN', team: false },
];
const MFA_ROLES = new Set(['HR', 'ADMIN']);

async function main(): Promise<void> {
  assertInternetDemoSafe(process.env);
  const pool = new pg.Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5433),
    database: process.env.PGDATABASE || 'hrvo_dev',
    user: process.env.PGADMIN_USER || 'postgres',
    password: process.env.PGADMIN_PASSWORD || 'postgres',
  });
  const passwords = new Map<string, string>();
  try {
    await pool.query(`DELETE FROM organizations WHERE id = $1 OR slug = $2`, [INTERNET_DEMO_ORG_ID, INTERNET_DEMO_SLUG]);
    await pool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'HRVO Internet Demo', $2, 'Asia/Colombo')`, [INTERNET_DEMO_ORG_ID, INTERNET_DEMO_SLUG]);
    await pool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Support')`, [TEAM_ID, INTERNET_DEMO_ORG_ID]);
    for (const u of USERS) {
      const password = strongPassword(20);
      passwords.set(u.email, password);
      const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
      // mfa_enabled stays false: HR and admins are taken to 2FA enrolment at their first sign-in.
      await pool.query(
        `INSERT INTO users (id, org_id, email, display_name, role, team_id, password_hash, status, mfa_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', false)`,
        [u.id, INTERNET_DEMO_ORG_ID, u.email, u.name, u.role, u.team ? TEAM_ID : null, hash],
      );
    }
    const lead = USERS[1]!.id;
    await pool.query(`UPDATE users SET manager_id = $1 WHERE org_id = $2 AND role IN ('EMPLOYEE', 'SUBCONTRACTOR')`, [lead, INTERNET_DEMO_ORG_ID]);
    await pool.query(`UPDATE teams SET lead_id = $1 WHERE id = $2`, [lead, TEAM_ID]);

    const inviteToken = randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO invitations (org_id, email, role, team_id, token_hash, invited_by, expires_at)
       VALUES ($1, 'newhire@internet.demo', 'EMPLOYEE', $2, $3, $4, now() + interval '1 day')`,
      [INTERNET_DEMO_ORG_ID, TEAM_ID, createHash('sha256').update(inviteToken).digest('hex'), USERS[0]!.id],
    );

    const web = (process.env.APP_WEB_URL || 'http://localhost:3000').replace(/\/$/, '');
    // Printed once, here only. Nothing else stores or logs the passwords: copy them now.
    console.log(`Seeded "HRVO Internet Demo" for ${web}`);
    console.log('Passwords (new on every run; shown only now):');
    for (const u of USERS) console.log(`  ${u.role.padEnd(14)} ${u.email.padEnd(24)} ${passwords.get(u.email)}${MFA_ROLES.has(u.role) ? '   (2FA enrolment at first sign-in)' : ''}`);
    console.log(`Invitation link for newhire@internet.demo (valid 1 day):\n  ${web}/accept-invitation#token=${inviteToken}`);
    console.log('Shut the demo down when it is not in use: npm run demo:internet:teardown');
  } finally {
    passwords.clear();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('Seeding failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
