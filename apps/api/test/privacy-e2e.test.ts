/**
 * Data-subject export (FR-AUD-002) and anonymisation with legal-retention checks (FR-AUD-003),
 * ADR 014. Real Postgres with RLS; the subject's data is seeded directly.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import pg from 'pg';
import argon2 from 'argon2';
import { generateSync } from 'otplib';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { readZip } from '../src/privacy/zip.ts';
import { AnonymisationCheckSchema, PrivacyRequestListSchema, PrivacyRequestSchema } from '../../../packages/shared/src/privacy/types.ts';

const ORG = 'c0c00000-0000-4000-8000-000000000001';
const OTHER = 'c0c00000-0000-4000-8000-000000000002';
const TEAM = 'c0c00000-0000-4000-8000-000000000101';
const PASSWORD = 'ComplexPassword123!';
const SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const U = {
  hrm: { id: 'c0c00000-0000-4000-8000-000000000011', org: ORG, email: 'hrm@priv.test', name: 'Mira Manager', role: 'HR_MANAGER', mfa: true },
  hr: { id: 'c0c00000-0000-4000-8000-000000000012', org: ORG, email: 'hr@priv.test', name: 'Hal HR', role: 'HR', mfa: true },
  lead: { id: 'c0c00000-0000-4000-8000-000000000013', org: ORG, email: 'lead@priv.test', name: 'Lena Lead', role: 'TEAM_LEAD', mfa: false },
  emp: { id: 'c0c00000-0000-4000-8000-000000000014', org: ORG, email: 'eva@priv.test', name: 'Eva Emp', role: 'EMPLOYEE', mfa: false },
  other: { id: 'c0c00000-0000-4000-8000-000000000021', org: OTHER, email: 'hrm@priv-other.test', name: 'Otto Other', role: 'HR_MANAGER', mfa: true },
} as const;
type Who = keyof typeof U;

describe('Data-subject export and anonymisation (FR-AUD-002, 003)', { concurrency: false }, () => {
  let app: INestApplication;
  let base: string;
  let adminPool: pg.Pool;
  const tokens = {} as Record<Who, string>;
  let docNormal = '';
  let docHeld = '';
  let docLinked = '';
  let requestId = '';

  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  async function ok<T>(res: Response, status: number, schema?: { parse: (v: unknown) => T }): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return schema ? schema.parse(JSON.parse(text)) : (JSON.parse(text || 'null') as T);
  }
  const q = (sql: string, params: unknown[] = []) => adminPool.query(sql, params);
  const auditCount = async (action: string) => (await q(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = $2`, [ORG, action])).rows[0].n as number;

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await q(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await q(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Privacy Ltd', 'priv-e2e'), ($2, 'Other Ltd', 'priv-other-e2e')`, [ORG, OTHER]);
    await q(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Field')`, [TEAM, ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(U)) {
      await q(`INSERT INTO users (id, org_id, email, display_name, role, team_id, password_hash, status, mfa_enabled, mfa_secret, timezone) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8, $9, $10)`,
        [u.id, u.org, u.email, u.name, u.role, u.org === ORG && u.role !== 'HR_MANAGER' && u.role !== 'HR' ? TEAM : null, hash, u.mfa, u.mfa ? SECRET : null, u.id === U.emp.id ? 'Europe/Berlin' : null]);
    }
    await q(`UPDATE users SET manager_id = $1 WHERE id = $2`, [U.lead.id, U.emp.id]);
    await q(`UPDATE teams SET lead_id = $1 WHERE id = $2`, [U.emp.id, TEAM]); // Eva leads the team: must be unlinked on anonymisation
    const e = U.emp.id;
    // Eva's footprint.
    await q(`INSERT INTO monitoring_consents (org_id, user_id, notice_version, accepted_at, ip, user_agent) VALUES ($1, $2, 'v1.0.0', now() - interval '30 days', '10.0.0.5', 'TestBrowser/1.0')`, [ORG, e]);
    await q(`INSERT INTO attendance_sessions (org_id, user_id, device_id, work_date, clock_in_at, clock_out_at, clock_in_source, last_heartbeat_at, ip_in, ip_out, status) VALUES ($1, $2, 'laptop-7', '2026-09-01', '2026-09-01T03:30:00Z', '2026-09-01T12:00:00Z', 'AUTO', '2026-09-01T12:00:00Z', '10.0.0.5', '10.0.0.5', 'CLOSED')`, [ORG, e]);
    await q(`INSERT INTO presence_events (org_id, user_id, server_ts, event_type, state, ip) SELECT $1, $2, '2026-09-01T04:00:00Z'::timestamptz + (g || ' minutes')::interval, 'HEARTBEAT', 'ACTIVE', '10.0.0.5' FROM generate_series(0, 2) g`, [ORG, e]);
    await q(`INSERT INTO attendance_daily (org_id, user_id, work_date, net_seconds, expected_seconds, day_status) VALUES ($1, $2, '2026-09-01', 30000, 28800, 'PRESENT')`, [ORG, e]);
    await q(`INSERT INTO attendance_corrections (org_id, user_id, requested_in, requested_out, reason, status) VALUES ($1, $2, '2026-09-02T03:00:00Z', '2026-09-02T11:00:00Z', 'Doctor appointment, forgot to clock in', 'PENDING')`, [ORG, e]);
    const sheet = (await q(`INSERT INTO timesheets (org_id, user_id, period_start, period_end, status, notes, amount, currency) VALUES ($1, $2, '2026-09-07', '2026-09-13', 'DRAFT', 'Worked from my sister''s place', 300.00, 'EUR') RETURNING id`, [ORG, e])).rows[0].id;
    await q(`INSERT INTO time_entries (org_id, user_id, timesheet_id, work_date, started_at, ended_at, minutes, source, note, manual_reason) VALUES ($1, $2, $3, '2026-09-08', '2026-09-08T08:00:00Z', '2026-09-08T10:00:00Z', 120, 'MANUAL', 'Call with client X', 'Forgot the timer')`, [ORG, e, sheet]);
    await q(`UPDATE timesheets SET status = 'SUBMITTED', submitted_at = now() WHERE id = $1`, [sheet]);
    await q(`INSERT INTO contracts (org_id, user_id, title, start_date, end_date, status) VALUES ($1, $2, 'Eva contract', '2026-01-01', NULL, 'ACTIVE')`, [ORG, e]);
    const task = (await q(`INSERT INTO tasks (org_id, title, status, assignee_id, reporter_id) VALUES ($1, 'Write the report', 'TODO', $2, $3) RETURNING id`, [ORG, e, U.lead.id])).rows[0].id;
    await q(`INSERT INTO task_comments (org_id, task_id, author_id, body) VALUES ($1, $2, $3, 'I will be late, my kid is ill')`, [ORG, task, e]);
    await q(`INSERT INTO notifications (org_id, user_id, type, title) VALUES ($1, $2, 'TASK_ASSIGNED', 'Write the report'), ($1, $2, 'TASK_STATUS', 'Status changed')`, [ORG, e]);
    await q(`INSERT INTO notification_preferences (org_id, user_id, type, in_app, email) VALUES ($1, $2, 'TASK_STATUS', true, false)`, [ORG, e]);
    docNormal = (await q(`INSERT INTO documents (org_id, title, category, owner_id) VALUES ($1, 'Eva personal notes', 'OTHER', $2) RETURNING id`, [ORG, e])).rows[0].id;
    docHeld = (await q(`INSERT INTO documents (org_id, title, category, owner_id, linked_user_id, legal_hold, legal_hold_reason, legal_hold_by, legal_hold_at) VALUES ($1, 'Dispute evidence', 'OTHER', $2, $2, true, 'Case 42', $3, now()) RETURNING id`, [ORG, e, U.hrm.id])).rows[0].id;
    docLinked = (await q(`INSERT INTO documents (org_id, title, category, owner_id, linked_user_id) VALUES ($1, 'Eva employment contract', 'CONTRACT', $2, $3) RETURNING id`, [ORG, U.hrm.id, e])).rows[0].id;
    await q(`INSERT INTO document_acl (org_id, document_id, principal_type, principal_id, permission, granted_by) VALUES ($1, $2, 'USER', $3, 'VIEW', $4)`, [ORG, docLinked, e, U.hrm.id]);

    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(3094);
    base = 'http://localhost:3094';
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD, ...(U[who].mfa ? { totpCode: generateSync({ secret: SECRET }) } : {}) }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
      assert.ok(tokens[who], `login ${who}`);
    }
  });

  after(async () => {
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.end();
  });

  describe('Export (FR-AUD-002)', { concurrency: false }, () => {
    it('only privacy.manage reaches the HR routes; everyone can download their own data as a ZIP', async () => {
      for (const who of ['hr', 'lead', 'emp'] as Who[]) {
        assert.equal((await api(who, `/privacy/subjects/${U.emp.id}/export`)).status, 403, who);
        assert.equal((await api(who, '/privacy/requests')).status, 403, who);
      }
      const res = await api('emp', '/me/export');
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/zip');
      assert.match(res.headers.get('content-disposition') ?? '', /personal-data-eva_priv_test-.*\.zip/);
      const entries = readZip(Buffer.from(await res.arrayBuffer()));
      const names = entries.map((x) => x.name);
      assert.ok(names.includes('README.txt') && names.includes('manifest.json') && names.includes('profile.json') && names.includes('attendance.json') && names.includes('audit.json'));
      const manifest = JSON.parse(entries.find((x) => x.name === 'manifest.json')!.data.toString()) as { subject: string; files: Array<{ name: string; sha256: string }> };
      assert.equal(manifest.subject, U.emp.email);
      for (const f of manifest.files) {
        const entry = entries.find((x) => x.name === f.name)!;
        assert.equal(createHash('sha256').update(entry.data).digest('hex'), f.sha256, `${f.name} hash`);
      }
      const profile = JSON.parse(entries.find((x) => x.name === 'profile.json')!.data.toString()) as { email: string; timezone: string; contracts: unknown[]; manager_email: string };
      assert.equal(profile.email, U.emp.email);
      assert.equal(profile.timezone, 'Europe/Berlin');
      assert.equal(profile.manager_email, U.lead.email);
      assert.equal(profile.contracts.length, 1);
      const attendance = JSON.parse(entries.find((x) => x.name === 'attendance.json')!.data.toString()) as { sessions: Array<{ ip_in: string }>; presenceEvents: unknown[]; corrections: Array<{ reason: string }> };
      assert.equal(attendance.sessions[0]!.ip_in, '10.0.0.5');
      assert.equal(attendance.presenceEvents.length, 3);
      assert.match(attendance.corrections[0]!.reason, /Doctor/);
      assert.equal(await auditCount('DATA_SUBJECT_EXPORTED'), 1);
      const reqs = await q(`SELECT type, status, reason FROM privacy_requests WHERE org_id = $1`, [ORG]);
      assert.deepEqual(reqs.rows, [{ type: 'EXPORT', status: 'COMPLETED', reason: 'Self-service export' }]);
    });

    it('HR exports as JSON; other people\'s confidential titles stay hidden; other organisations get 404', async () => {
      const res = await api('hrm', `/privacy/subjects/${U.emp.id}/export?format=json`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      const data = JSON.parse(await res.text()) as { profile: { email: string }; documents: { owned: Array<{ title: string }>; linkedToMe: Array<{ title: string }> }; tasks: { comments: Array<{ body: string }> }; timesheets: { timeEntries: Array<{ note: string }> }; consents: Array<{ ip: string }> };
      assert.equal(data.profile.email, U.emp.email);
      assert.deepEqual(data.documents.owned.map((d) => d.title).sort(), ['Dispute evidence', 'Eva personal notes']);
      assert.deepEqual(data.documents.linkedToMe.map((d) => d.title), ['Eva employment contract']);
      assert.match(data.tasks.comments[0]!.body, /kid is ill/);
      assert.equal(data.timesheets.timeEntries[0]!.note, 'Call with client X');
      assert.equal(data.consents[0]!.ip, '10.0.0.5');
      assert.equal((await api('other', `/privacy/subjects/${U.emp.id}/export`)).status, 404);
      assert.equal((await api('hrm', `/privacy/subjects/${U.other.id}/export`)).status, 404);
    });
  });

  describe('Anonymisation workflow (FR-AUD-003)', { concurrency: false }, () => {
    it('the check lists every blocker, what is retained on a legal basis, and what will go', async () => {
      const c = await ok(await api('hrm', `/privacy/subjects/${U.emp.id}/anonymisation-check`), 200, AnonymisationCheckSchema);
      assert.equal(c.canProceed, false);
      assert.deepEqual(c.blockers.map((b) => b.kind).sort(), ['ACTIVE_CONTRACT', 'LEGAL_HOLD', 'PENDING_CORRECTION', 'SUBMITTED_TIMESHEET']);
      const retained = Object.fromEntries(c.retained.map((r) => [r.kind, r.count]));
      assert.equal(retained.RETAINED_DOCUMENTS, 1, 'the contract filed by HR stays');
      assert.equal(retained.CONSENT_RECORDS, 1);
      assert.ok(retained.AUDIT_LOG! >= 1, 'login entries');
      const shred = c.willRemove.find((w) => w.action === 'SHRED')!;
      assert.equal(shred.count, 1, 'only the personal notes; the held document is a blocker');
      assert.equal(c.willRemove.find((w) => w.dataset === 'Raw presence events')!.count, 3);
      assert.equal((await api('hrm', `/privacy/subjects/${U.hrm.id}/anonymisation-check`)).status, 403, 'never yourself');
      assert.equal((await api('other', `/privacy/subjects/${U.emp.id}/anonymisation-check`)).status, 404);
    });

    it('a request is recorded as BLOCKED with its reason; executing is refused while blockers remain; one open request per person', async () => {
      assert.equal((await api('hrm', '/privacy/requests', { method: 'POST', body: { userId: U.emp.id, reason: 'x' } })).status, 400, 'reason too short');
      const r = await ok(await api('hrm', '/privacy/requests', { method: 'POST', body: { userId: U.emp.id, reason: 'Left the company on 30 September; erasure requested by email.' } }), 201, PrivacyRequestSchema);
      requestId = r.id;
      assert.equal(r.status, 'BLOCKED');
      assert.equal(r.blockers.length, 4);
      assert.equal(r.subject.email, U.emp.email);
      assert.equal((await api('hrm', '/privacy/requests', { method: 'POST', body: { userId: U.emp.id, reason: 'Second request for the same person' } })).status, 409);
      const exec = await api('hrm', `/privacy/requests/${requestId}/execute`, { method: 'POST', body: { confirmEmail: U.emp.email } });
      assert.equal(exec.status, 409);
      assert.match(await exec.text(), /contract is still active/);
      assert.equal(await auditCount('ANONYMISATION_REQUESTED'), 1);
      const list = await ok(await api('hrm', '/privacy/requests'), 200, PrivacyRequestListSchema);
      assert.deepEqual(list.items.map((i) => `${i.type}:${i.status}`), ['ANONYMISE:BLOCKED', 'EXPORT:COMPLETED', 'EXPORT:COMPLETED']);
      assert.equal((await api('other', '/privacy/requests')).status, 200);
      assert.deepEqual((await ok(await api('other', '/privacy/requests'), 200, PrivacyRequestListSchema)).items, [], 'RLS');
    });

    it('cancelling closes the request; a new one can be opened', async () => {
      const c = await ok(await api('hrm', `/privacy/requests/${requestId}/cancel`, { method: 'POST' }), 200, PrivacyRequestSchema);
      assert.equal(c.status, 'CANCELLED');
      assert.equal((await api('hrm', `/privacy/requests/${requestId}/cancel`, { method: 'POST' })).status, 404);
      const r = await ok(await api('hrm', '/privacy/requests', { method: 'POST', body: { userId: U.emp.id, reason: 'Leaver process, HR ticket 1187.' } }), 201, PrivacyRequestSchema);
      requestId = r.id;
      assert.equal(r.status, 'BLOCKED');
    });

    it('once the obligations are settled the data is removed or replaced, and the person can never sign in again', async () => {
      await q(`UPDATE attendance_corrections SET status = 'REJECTED', reviewer_id = $2, reviewed_at = now(), review_note = 'No evidence' WHERE user_id = $1`, [U.emp.id, U.lead.id]);
      await q(`UPDATE timesheets SET status = 'PAID' WHERE user_id = $1`, [U.emp.id]);
      await q(`UPDATE contracts SET status = 'TERMINATED', end_date = '2026-09-30' WHERE user_id = $1`, [U.emp.id]);
      await q(`UPDATE documents SET legal_hold = false, legal_hold_reason = NULL WHERE id = $1`, [docHeld]);
      const c = await ok(await api('hrm', `/privacy/subjects/${U.emp.id}/anonymisation-check`), 200, AnonymisationCheckSchema);
      assert.equal(c.canProceed, true);
      assert.equal(c.willRemove.find((w) => w.action === 'SHRED')!.count, 2, 'the released document is now shreddable too');

      const wrong = await api('hrm', `/privacy/requests/${requestId}/execute`, { method: 'POST', body: { confirmEmail: 'someone.else@priv.test' } });
      assert.equal(wrong.status, 400);
      const done = await ok(await api('hrm', `/privacy/requests/${requestId}/execute`, { method: 'POST', body: { confirmEmail: U.emp.email.toUpperCase() } }), 200, PrivacyRequestSchema);
      assert.equal(done.status, 'COMPLETED');
      assert.ok(done.completedAt);
      assert.equal(done.result!.presenceEvents, 3);
      assert.equal(done.result!.notifications, 2);
      assert.equal(done.result!.documentsShredded, 2);
      assert.equal(done.result!.taskComments, 1);
      assert.equal(done.subject.displayName, 'Anonymised user', 'the request now shows the pseudonym');

      const u = (await q(`SELECT email, display_name, status, password_hash, mfa_enabled, team_id, manager_id, timezone, anonymised_at FROM users WHERE id = $1`, [U.emp.id])).rows[0];
      assert.match(u.email, /^anonymised-[0-9a-f]{8}@anonymised\.invalid$/);
      assert.equal(u.display_name, 'Anonymised user');
      assert.equal(u.status, 'ANONYMISED');
      assert.equal(u.password_hash, null);
      assert.equal(u.mfa_enabled, false);
      assert.equal(u.team_id, null);
      assert.equal(u.timezone, null);
      assert.ok(u.anonymised_at);
      assert.equal((await api('emp', '/me/access')).status, 401, 'old token dead');
      const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U.emp.email, password: PASSWORD }) });
      assert.equal(login.status, 401);
      assert.equal((await q(`SELECT count(*)::int AS n FROM presence_events WHERE user_id = $1`, [U.emp.id])).rows[0].n, 0);
      assert.equal((await q(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1`, [U.emp.id])).rows[0].n, 0);
      assert.equal((await q(`SELECT count(*)::int AS n FROM notification_preferences WHERE user_id = $1`, [U.emp.id])).rows[0].n, 0);
      assert.deepEqual((await q(`SELECT ip_in, ip_out, device_id, net_seconds FROM attendance_sessions WHERE user_id = $1`, [U.emp.id])).rows, [{ ip_in: '0.0.0.0', ip_out: null, device_id: 'anonymised', net_seconds: 0 }]);
      assert.equal((await q(`SELECT reason FROM attendance_corrections WHERE user_id = $1`, [U.emp.id])).rows[0].reason, '[removed: person anonymised]');
      assert.deepEqual((await q(`SELECT note, manual_reason FROM time_entries WHERE user_id = $1`, [U.emp.id])).rows, [{ note: '', manual_reason: '[removed]' }]);
      assert.equal((await q(`SELECT body FROM task_comments WHERE author_id = $1`, [U.emp.id])).rows[0].body, '[comment removed: author anonymised]');
      assert.equal((await q(`SELECT lead_id FROM teams WHERE id = $1`, [TEAM])).rows[0].lead_id, null);
      assert.equal((await q(`SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1 AND NOT is_revoked`, [U.emp.id])).rows[0].n, 0);
      assert.equal((await q(`SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1 AND (ip IS NOT NULL OR user_agent IS NOT NULL)`, [U.emp.id])).rows[0].n, 0);
      // Kept on a legal basis, under the pseudonymous id.
      const docs = await q(`SELECT id, shredded_at IS NOT NULL AS shredded FROM documents WHERE id = ANY($1::uuid[]) ORDER BY id`, [[docNormal, docHeld, docLinked]]);
      assert.equal(docs.rows.find((d) => d.id === docNormal)!.shredded, true);
      assert.equal(docs.rows.find((d) => d.id === docHeld)!.shredded, true);
      assert.equal(docs.rows.find((d) => d.id === docLinked)!.shredded, false, 'filed by HR, linked to the person: retained');
      assert.equal((await q(`SELECT count(*)::int AS n FROM document_acl WHERE principal_id = $1`, [U.emp.id])).rows[0].n, 0);
      assert.deepEqual((await q(`SELECT status, amount::text, notes FROM timesheets WHERE user_id = $1`, [U.emp.id])).rows, [{ status: 'PAID', amount: '300.00', notes: '' }]);
      assert.equal((await q(`SELECT count(*)::int AS n FROM monitoring_consents WHERE user_id = $1`, [U.emp.id])).rows[0].n, 1);
      assert.equal(await auditCount('USER_ANONYMISED'), 1);
      const verify = await ok<{ valid: boolean }>(await api('hrm', '/audit-logs/verify'), 200);
      assert.equal(verify.valid, true, 'the audit chain is untouched');
      assert.equal((await api('hrm', `/privacy/subjects/${U.emp.id}/anonymisation-check`)).status, 409, 'already anonymised');
      // The export of a pseudonymous record still works and no longer carries personal data.
      const after = JSON.parse(await (await api('hrm', `/privacy/subjects/${U.emp.id}/export?format=json`)).text()) as { profile: { email: string }; tasks: { comments: Array<{ body: string }> } };
      assert.match(after.profile.email, /anonymised/);
      assert.doesNotMatch(JSON.stringify(after), /kid is ill|Doctor|sister|Call with client|laptop-7|Europe\/Berlin|eva@priv\.test/);
      // Kept on purpose: the consent record (append-only evidence of the lawful basis) still holds the IP it was given from.
      const consents = (after as unknown as { consents: Array<{ ip: string }> }).consents;
      assert.equal(consents[0]!.ip, '10.0.0.5');
    });
  });
});
