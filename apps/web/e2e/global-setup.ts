import argon2 from 'argon2';
import { ADMIN_GUARD } from './guard';
import { ADMIN_USER, ORG_ID, ORG_SLUG, PASSWORD, TEAM_ID, USERS, adminPool } from './fixtures';

/** Re-seeds the dedicated e2e organisation. Never touches other tenants. */
export default async function globalSetup(): Promise<void> {
  ADMIN_GUARD();
  const pool = adminPool();
  try {
    await pool.query(`DELETE FROM organizations WHERE id = $1 OR slug = $2`, [ORG_ID, ORG_SLUG]);
    // Workspaces created by the signup flow (spec 31).
    await pool.query(`DELETE FROM organizations WHERE slug LIKE 'e2e-signup-co%'`);
    // The shortest grace and silence windows SRS 6.4 allows, so the accuracy spec (23) can watch a
    // tab close and a network loss end a session within the test's time budget.
    await pool.query(`INSERT INTO organizations (id, name, slug, timezone, att_disconnect_grace_seconds, att_missed_heartbeat_seconds) VALUES ($1, 'Web E2E Ltd', $2, 'Asia/Colombo', 30, 60)`, [ORG_ID, ORG_SLUG]);
    await pool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Support')`, [TEAM_ID, ORG_ID]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(USERS)) {
      await pool.query(
        `INSERT INTO users (id, org_id, email, display_name, role, team_id, password_hash, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`,
        [u.id, ORG_ID, u.email, u.name, u.role, u.role === 'HR' ? null : TEAM_ID, hash],
      );
    }
    await pool.query(
      `INSERT INTO users (id, org_id, email, display_name, role, password_hash, status, mfa_enabled, mfa_secret)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', true, $7)`,
      [ADMIN_USER.id, ORG_ID, ADMIN_USER.email, ADMIN_USER.name, ADMIN_USER.role, hash, ADMIN_USER.totp],
    );
    await pool.query(`UPDATE users SET manager_id = $1 WHERE id = ANY($2::uuid[])`, [USERS.lead.id, [USERS.worker.id, USERS.sub.id]]);
    await pool.query(`UPDATE teams SET lead_id = $1 WHERE id = $2`, [USERS.lead.id, TEAM_ID]);
  } finally {
    await pool.end();
  }
}
