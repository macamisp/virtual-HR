/**
 * Subcontractor profiles (FR-ORG-002; ADR 033), against the real API and Postgres. Proves that
 * a subcontractor cannot read another person's profile; that tax ID and bank details are
 * encrypted at the application layer, so a database dump (every row of every table as text)
 * shows neither, in plain, hex or base64 form; that field-level permissions hold (masked for
 * HR, clear only through the audited reveal for the person or subcontractors.sensitive.read);
 * that every read is audited without values; and that nothing is logged in plain text.
 */
import 'reflect-metadata';
import { freshCode } from './support/totp.ts';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { SubcontractorListSchema, SubcontractorProfileSchema, SubcontractorSensitiveSchema } from '../../../packages/shared/src/org/subcontractors.ts';

const ORG = '6f6f0000-0000-4000-8000-000000000001';
const OTHER = '6f6f0000-0000-4000-8000-000000000002';
const PORT = 3113;
const PASSWORD = 'ComplexPassword123!';
const MFA_SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD'; // test-only; HR roles must have 2FA enrolled (FR-AUTH-004)
const U = {
  hr: { id: '6f6f0000-0000-4000-8000-000000000011', email: 'hr@subs.test', role: 'HR', org: ORG },
  hrm: { id: '6f6f0000-0000-4000-8000-000000000012', email: 'hrm@subs.test', role: 'HR_MANAGER', org: ORG },
  sub: { id: '6f6f0000-0000-4000-8000-000000000013', email: 'sub@subs.test', role: 'SUBCONTRACTOR', org: ORG },
  sub2: { id: '6f6f0000-0000-4000-8000-000000000014', email: 'sub2@subs.test', role: 'SUBCONTRACTOR', org: ORG },
  emp: { id: '6f6f0000-0000-4000-8000-000000000015', email: 'emp@subs.test', role: 'EMPLOYEE', org: ORG },
  lead: { id: '6f6f0000-0000-4000-8000-000000000016', email: 'lead@subs.test', role: 'TEAM_LEAD', org: ORG },
  far: { id: '6f6f0000-0000-4000-8000-000000000021', email: 'far@subs.test', role: 'SUBCONTRACTOR', org: OTHER },
} as const;
type Who = Exclude<keyof typeof U, 'far'>;
const MFA = new Set<Who>(['hr', 'hrm']);

// The secrets of this suite. None of them may appear in the database or the logs.
const TAX = 'LK-TIN-918273645';
const TAX2 = 'LK-TIN-555000111';
const BANK = { accountName: 'Sam Contractor', bankName: 'Ceylon Test Bank', branch: 'Colombo 03', accountNumber: '0071-2299-4471', swiftCode: 'CTBKLKLX' };
const SECRETS = [TAX, TAX2, BANK.accountNumber, BANK.accountNumber.replace(/-/g, ''), BANK.swiftCode];

describe('Subcontractor profiles (FR-ORG-002)', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  const tokens = {} as Record<Who, string>;
  const base = `http://localhost:${PORT}`;
  const logged: string[] = [];
  const restore: Array<() => void> = [];
  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  async function ok<T>(res: Response, status: number, schema?: { parse: (v: unknown) => T }): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return schema ? schema.parse(JSON.parse(text)) : (JSON.parse(text || 'null') as T);
  }
  const audits = async (action: string, entityId?: string) =>
    (await adminPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = $2 AND ($3::uuid IS NULL OR entity_id = $3::uuid)`, [ORG, action, entityId ?? null])).rows[0]!.n;

  before(async () => {
    // Capture everything the process writes, to prove no secret is ever logged.
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => { logged.push(String(chunk)); return (write as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof stream.write;
      restore.push(() => { stream.write = write; });
    }
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    const pgBase = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev' };
    adminPool = new pg.Pool({ ...pgBase, user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Subs Ltd', 'subs-e2e', 'Asia/Colombo'), ($2, 'Far', 'subs-e2e-other', 'Asia/Colombo')`, [ORG, OTHER]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const [k, u] of Object.entries(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')`, [u.id, u.org, u.email, k, u.role, hash]);
    }
    await adminPool.query(`UPDATE users SET mfa_enabled = true, mfa_secret = $1 WHERE id = ANY($2::uuid[])`, [MFA_SECRET, [U.hr.id, U.hrm.id]]);
    await adminPool.query(`INSERT INTO subcontractor_details (user_id, org_id, legal_name) VALUES ($1, $2, 'Far Away Pvt Ltd')`, [U.far.id, OTHER]);
    app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
    configureApp(app);
    await app.listen(PORT);
    for (const who of Object.keys(U).filter((k) => k !== 'far') as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD, ...(MFA.has(who) ? { totpCode: await freshCode(MFA_SECRET) } : {}) }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
      assert.ok(tokens[who], `login ${who}`);
    }
  });

  after(async () => {
    for (const r of restore) r();
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.end();
  });

  it('the person fills in their own profile: contact, emergency contact, tax ID and bank details, but not their legal identity', async () => {
    const p = await ok(await api('sub', '/me/subcontractor-profile', { method: 'PUT', body: {
      contactPhone: '+94 77 123 4567', address: '12 Galle Road, Colombo', emergencyContact: { name: 'Rani', relationship: 'Sister', phone: '+94 71 000 0000' }, taxId: TAX, bankDetails: BANK,
    } }), 200, SubcontractorProfileSchema);
    assert.deepEqual(p.taxId, { set: true, last4: '3645' });
    assert.deepEqual(p.bankDetails, { set: true, last4: '4471', bankName: 'Ceylon Test Bank' });
    assert.equal(p.emergencyContact?.name, 'Rani');
    assert.equal(p.rates, null, 'the person sees their own rates (none yet)');
    assert.deepEqual(p.can, { reveal: true, editIdentity: false, editContact: true, editSensitive: true });
    assert.equal((await api('sub', '/me/subcontractor-profile', { method: 'PUT', body: { legalName: 'Someone Else' } })).status, 403, 'identity is HR\'s');
    assert.equal((await api('sub', '/me/subcontractor-profile', { method: 'PUT', body: { taxId: '<script>' } })).status, 400);
    assert.equal((await api('sub', '/me/subcontractor-profile', { method: 'PUT', body: { bankDetails: { ...BANK, accountNumber: '1' } } })).status, 400);
    const mine = await ok(await api('sub', '/me/subcontractor-profile/reveal', { method: 'POST' }), 200, SubcontractorSensitiveSchema);
    assert.deepEqual(mine, { taxId: TAX, bankDetails: BANK });
    assert.equal((await api('emp', '/me/subcontractor-profile')).status, 404, 'only subcontractors have one');
  });

  it('a subcontractor cannot read, reveal, edit or list another person\'s profile (nor can an employee or a lead)', async () => {
    await ok(await api('hr', `/subcontractors/${U.sub2.id}/profile`, { method: 'PUT', body: { legalName: 'Second Contractor', taxId: TAX2 } }), 200);
    for (const who of ['sub', 'emp', 'lead'] as Who[]) {
      const res = await api(who, `/subcontractors/${U.sub2.id}/profile`);
      assert.equal(res.status, 403, `${who} reads`);
      assert.equal((await res.text()).includes(TAX2), false, 'a refusal carries no data');
      assert.equal((await api(who, `/subcontractors/${U.sub2.id}/profile/reveal`, { method: 'POST' })).status, 403, `${who} reveals`);
      assert.equal((await api(who, `/subcontractors/${U.sub2.id}/profile`, { method: 'PUT', body: { contactPhone: '+94 70 000 0000' } })).status, 403, `${who} edits`);
      assert.equal((await api(who, '/subcontractors')).status, 403, `${who} lists`);
    }
    const own = await ok(await api('sub', '/me/subcontractor-profile'), 200, SubcontractorProfileSchema);
    assert.equal(own.user.id, U.sub.id, '/me is always the caller');
    assert.equal(own.legalName, '', 'and never shows the other person');
  });

  it('field-level permissions: HR reads masked values and edits identity, only an HR manager reveals; another tenant is invisible', async () => {
    const list = await ok(await api('hr', '/subcontractors'), 200, SubcontractorListSchema);
    assert.deepEqual(list.items.map((i) => [i.user.id, i.hasTaxId, i.hasBankDetails]).sort(), [[U.sub.id, true, true], [U.sub2.id, true, false]].sort());
    const masked = await ok(await api('hr', `/subcontractors/${U.sub.id}/profile`), 200, SubcontractorProfileSchema);
    assert.deepEqual([masked.taxId.last4, masked.bankDetails.last4], ['3645', '4471']);
    assert.equal(JSON.stringify(masked).includes(TAX), false);
    assert.equal(masked.can.reveal, false);
    assert.equal((await api('hr', `/subcontractors/${U.sub.id}/profile/reveal`, { method: 'POST' })).status, 403, 'plain HR may not reveal');
    await ok(await api('hr', `/subcontractors/${U.sub.id}/profile`, { method: 'PUT', body: { legalName: 'Sam Contractor', companyName: 'Sam Builds (Pvt) Ltd', country: 'lk' } }), 200);
    const clear = await ok(await api('hrm', `/subcontractors/${U.sub.id}/profile/reveal`, { method: 'POST' }), 200, SubcontractorSensitiveSchema);
    assert.deepEqual(clear, { taxId: TAX, bankDetails: BANK });
    const res = await api('hrm', `/subcontractors/${U.sub.id}/profile/reveal`, { method: 'POST' });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await api('hrm', `/subcontractors/${U.far.id}/profile`)).status, 404, 'another tenant (RLS)');
    assert.equal((await api('hrm', `/subcontractors/${U.emp.id}/profile`)).status, 404, 'not a subcontractor');
    const profile = await ok(await api('hrm', `/subcontractors/${U.sub.id}/profile`), 200, SubcontractorProfileSchema);
    assert.deepEqual([profile.legalName, profile.companyName, profile.country], ['Sam Contractor', 'Sam Builds (Pvt) Ltd', 'LK']);
  });

  it('every read is audited, and the audit log holds field names, never values', async () => {
    assert.ok(await audits('SUBCONTRACTOR_LIST_READ') >= 1);
    assert.ok(await audits('SUBCONTRACTOR_PROFILE_READ', U.sub.id) >= 3, 'self and HR reads');
    assert.equal(await audits('SUBCONTRACTOR_SENSITIVE_READ', U.sub.id), 3, 'one self reveal and two HR manager reveals; refused reveals reveal nothing');
    const update = (await adminPool.query<{ after: { changed: string[] } }>(`SELECT after FROM audit_logs WHERE org_id = $1 AND action = 'SUBCONTRACTOR_PROFILE_UPDATED' AND entity_id = $2 ORDER BY created_at LIMIT 1`, [ORG, U.sub.id])).rows[0]!;
    assert.deepEqual(update.after.changed.sort(), ['address', 'bankDetails', 'contactPhone', 'emergencyContact', 'taxId']);
  });

  it('a ciphertext copied into another person\'s row does not open', async () => {
    await adminPool.query(`UPDATE subcontractor_details SET tax_id_enc = (SELECT tax_id_enc FROM subcontractor_details WHERE user_id = $1) WHERE user_id = $2`, [U.sub.id, U.sub2.id]);
    const res = await api('hrm', `/subcontractors/${U.sub2.id}/profile/reveal`, { method: 'POST' });
    assert.equal(res.status, 500);
    assert.equal((await res.text()).includes(TAX), false);
    await ok(await api('hr', `/subcontractors/${U.sub2.id}/profile`, { method: 'PUT', body: { taxId: TAX2 } }), 200, SubcontractorProfileSchema);
  });

  it('a database dump does not reveal tax or bank values: every row of every table, as text, in plain, hex or base64 form', async () => {
    const tables = (await adminPool.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).rows.map((r) => r.table_name);
    assert.ok(tables.includes('subcontractor_details') && tables.includes('audit_logs'));
    const forms = SECRETS.flatMap((s) => [s, Buffer.from(s).toString('hex'), Buffer.from(s).toString('base64')]);
    let rows = 0;
    let control = false;
    for (const t of tables) {
      // The same text form pg_dump writes (bytea as \x hex), for this suite's organisations and any row without one.
      const hasOrg = (await adminPool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'org_id'`, [t])).rowCount;
      const dump = (await adminPool.query<{ row: string }>(`SELECT t::text AS row FROM ${pg.escapeIdentifier(t)} t ${hasOrg ? 'WHERE t.org_id = ANY($1::uuid[])' : ''}`, hasOrg ? [[ORG, OTHER]] : [])).rows;
      rows += dump.length;
      for (const { row } of dump) {
        for (const f of forms) assert.equal(row.toLowerCase().includes(f.toLowerCase()), false, `${t} holds a secret in some form`);
        if (t === 'subcontractor_details' && row.includes('Sam Builds (Pvt) Ltd')) control = true;
      }
    }
    assert.ok(rows > 0);
    assert.ok(control, 'control: the scan does read the profile rows (the company name is stored in plain text by design)');
    const stored = (await adminPool.query<{ tax_id_enc: Buffer; bank_details_enc: Buffer; dek_wrapped: Buffer }>(`SELECT tax_id_enc, bank_details_enc, dek_wrapped FROM subcontractor_details WHERE user_id = $1`, [U.sub.id])).rows[0]!;
    assert.ok(stored.tax_id_enc.length > 16 && stored.bank_details_enc.length > 16 && stored.dek_wrapped.length > 32, 'ciphertext and a wrapped key are stored');
  });

  it('nothing the process wrote during the suite contains a secret', () => {
    const all = logged.join('');
    assert.ok(all.includes('encrypted fields could not be opened'), 'the capture works: the tamper test\'s error line is here');
    for (const s of SECRETS) assert.equal(all.includes(s), false, 'a secret was logged');
  });
});
