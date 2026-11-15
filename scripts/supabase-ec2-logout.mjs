#!/usr/bin/env node
// FR-ATT-002 logout timing and cross-tenant RLS against Supabase (ADR 052), run inside the API image with
// the image's own compiled code and the restricted roles only. Synthetic data (*.sbprobe.test), deleted
// at the end. Mirrors AuthService.logout: tenant transaction (session family, revokeSessionsOf,
// appendAuditEntry), then hasOtherLiveLogin + onExplicitLogout. Prints no secrets.
//
//   node supabase-ec2-logout.mjs <env-file> <ca-file> [dist-root=/app/dist]
import { readFileSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';

const [envFile, caFile, dist = '/app/dist'] = process.argv.slice(2);
const env = {};
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (!m) continue;
  let v = m[2].trim();
  if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
  env[m[1]] = v;
}
if (env.SUPABASE_ADMIN_PASSWORD) { console.error('refusing: admin password present'); process.exit(2); }
const ca = readFileSync(caFile, 'utf8');
const conn = (user, password) => ({
  host: env.SUPABASE_PGHOST, port: 5432, database: 'postgres', user, password,
  ssl: { rejectUnauthorized: true, ca }, max: 2, connectionTimeoutMillis: 15000, application_name: 'hrvo-ec2-logout',
});
const app = conn(env.SUPABASE_APP_USER, env.SUPABASE_APP_PASSWORD);

const { PostgresAttendanceRepository } = await import(`${dist}/apps/api/src/attendance/attendance-repository.js`);
const { AttendanceService } = await import(`${dist}/apps/api/src/attendance/attendance.service.js`);
const { revokeSessionsOf } = await import(`${dist}/apps/api/src/auth/session-revocation.js`);
const { appendAuditEntry } = await import(`${dist}/apps/api/src/common/audit-chain.js`);
const { SystemClock } = await import(`${dist}/packages/shared/src/index.js`);

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); };
const pool = new pg.Pool(app);
const tenant = async (orgId, fn) => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
};

const stamp = Date.now().toString(36);
const orgs = ['a', 'b'].map((k) => ({ k, id: randomUUID(), userId: randomUUID(), sessionId: randomUUID(), familyId: randomUUID() }));
const repo = new PostgresAttendanceRepository({ appPoolConfig: app, adminPoolConfig: app, retentionPoolConfig: conn(env.SUPABASE_RETENTION_USER, env.SUPABASE_RETENTION_PASSWORD) });
const service = new AttendanceService(undefined, new SystemClock(), repo);

try {
  // Seed two synthetic tenants exactly as sign-up would, as hrvo_app inside each tenant context.
  for (const o of orgs) {
    await tenant(o.id, async (c) => {
      await c.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`, [o.id, `SB Probe ${o.k}`, `sbprobe-${o.k}-${stamp}`]);
      await c.query(`INSERT INTO users (id, org_id, email, display_name, role, status) VALUES ($1, $2, $3, $3, 'EMPLOYEE', 'ACTIVE')`, [o.userId, o.id, `worker-${o.k}-${stamp}@sbprobe.test`]);
      await c.query(`INSERT INTO monitoring_consents (org_id, user_id, notice_version, consent_type, granted, accepted_at) VALUES ($1, $2, 'v1.0.0', 'MONITORING', true, now())`, [o.id, o.userId]);
      await c.query(`INSERT INTO auth_sessions (id, org_id, user_id, family_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour')`,
        [o.sessionId, o.id, o.userId, o.familyId, randomBytes(32).toString('hex')]);
    });
  }
  check('two synthetic tenants seeded by hrvo_app under RLS', true, 'orgs, users, consents, auth sessions');

  // Cross-tenant: tenant B's context sees nothing of tenant A; a write into A from B's context is refused.
  const [A, B] = orgs;
  const leak = await tenant(B.id, async (c) => Number((await c.query(
    `SELECT (SELECT count(*) FROM users WHERE org_id = $1) + (SELECT count(*) FROM auth_sessions WHERE org_id = $1) + (SELECT count(*) FROM organizations WHERE id = $1) n`, [A.id])).rows[0].n));
  check('cross-tenant read: tenant B sees none of tenant A', leak === 0, `${leak} rows`);
  const own = await tenant(B.id, async (c) => Number((await c.query(`SELECT count(*) n FROM users`)).rows[0].n));
  check('own-tenant read still works', own === 1, `${own} user`);
  let refused = false;
  try { await tenant(B.id, (c) => c.query(`INSERT INTO users (org_id, email) VALUES ($1, $2)`, [A.id, `x-${stamp}@sbprobe.test`])); } catch { refused = true; }
  check('cross-tenant write refused (RLS WITH CHECK)', refused, refused ? 'rejected' : 'ACCEPTED');

  // Open an attendance session for A with a signed heartbeat (server clock).
  const secret = randomBytes(32).toString('hex');
  await service.registerSessionSecret(A.sessionId, secret, A.id);
  const hb = { orgId: A.id, userId: A.userId, deviceId: `dev-${stamp}`, sessionId: A.sessionId, sequenceNumber: 1, nonce: `n-${stamp}`,
    activeSeconds: 30, idleSeconds: 0, tabVisible: true, windowFocused: true, inCall: false };
  await service.ingestHeartbeat({ ...hb, signature: service.getValidator().signHeartbeat(hb, secret) });
  const open = await service.getSession(A.userId, A.id);
  check('attendance session open after a signed heartbeat', open?.status === 'OPEN', `status=${open?.status}`);

  // Timed logout, the same steps as AuthService.logout + closeAttendanceOnRevocation.
  const runs = [];
  for (let i = 0; i < 3; i++) {
    if (i > 0) { // re-open for repeat measurements
      await tenant(A.id, (c) => c.query(`UPDATE auth_sessions SET is_revoked = false, revoked_reason = NULL WHERE id = $1`, [A.sessionId]));
      await service.registerSessionSecret(A.sessionId, secret, A.id);
      const h = { ...hb, sequenceNumber: 1 + i, nonce: `n-${stamp}-${i}` };
      await service.ingestHeartbeat({ ...h, signature: service.getValidator().signHeartbeat(h, secret) });
    }
    const t0 = performance.now();
    const fam = await tenant(A.id, async (c) => {
      const f = (await c.query(`SELECT family_id FROM auth_sessions WHERE id = $1 AND org_id = $2 AND user_id = $3`, [A.sessionId, A.id, A.userId])).rows[0].family_id;
      await revokeSessionsOf(c, A.id, { familyId: f }, 'LOGOUT');
      await appendAuditEntry(c, { orgId: A.id, actorId: A.userId, action: 'LOGOUT', entityType: 'SESSION', entityId: A.sessionId });
      return f;
    });
    const other = await service.hasOtherLiveLogin(A.id, A.userId, fam);
    const res = other ? null : await service.onExplicitLogout(A.userId, undefined, A.id);
    const ms = performance.now() - t0;
    runs.push(ms);
    const closed = res?.session?.status === 'CLOSED' && (await service.getSession(A.userId, A.id)) === null;
    check(`logout #${i + 1} closes the attendance session within 1 s`, closed && ms < 1000, `${Math.round(ms)} ms, closed=${closed}`);
  }
  console.log(`logout timings ms: ${runs.map((r) => Math.round(r)).join(', ')}`);
} catch (e) {
  check('logout probe completed', false, e instanceof Error ? e.message.replace(/postgres(ql)?:\/\/\S+/g, '<url>').slice(0, 300) : 'error');
} finally {
  // Cleanup: delete only the synthetic tenants (cascades), then confirm.
  let left = -1;
  try {
    for (const o of orgs) await tenant(o.id, (c) => c.query(`DELETE FROM organizations WHERE id = $1 AND slug LIKE 'sbprobe-%'`, [o.id]));
    left = 0;
    for (const o of orgs) left += await tenant(o.id, async (c) => Number((await c.query(`SELECT count(*) n FROM organizations WHERE id = $1`, [o.id])).rows[0].n));
  } catch (e) {
    console.log(`cleanup error: ${e instanceof Error ? e.message.slice(0, 200) : 'error'}`);
  }
  check('synthetic tenants removed', left === 0, left === 0 ? 'deleted' : `NOT removed: slugs sbprobe-a-${stamp}, sbprobe-b-${stamp}`);
  await repo.close().catch(() => {});
  await pool.end().catch(() => {});
}
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `supabase-ec2-logout: ${failed} FAILED` : `supabase-ec2-logout: all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
