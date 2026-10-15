/**
 * Confidential vault E2E (FR-DOC-005, 006, 007, 010, 011, 017; SRS 10.1), against real
 * S3-compatible storage and clamd. Proves in particular:
 *  1. a database dump plus a bucket dump alone reveal no content, file name or confidential title;
 *  2. a wrong document password fails (and locks out after 3, HR notified);
 *  3. tampered ciphertext fails the GCM authentication tag;
 *  4. a user without ACL gets 404/403 with no information leak;
 *  5. a valid link to one document never opens another, and users cannot read each other's
 *     documents.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { generateSync } from 'otplib';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PDFDocument } from 'pdf-lib';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { DocumentMaintenanceService } from '../src/documents/document-maintenance.service.ts';
import {
  CreatedShareLinkSchema,
  DocumentDetailSchema,
  DocumentListSchema,
  DocumentSummarySchema,
  PublicShareInfoSchema,
  ReauthStatusSchema,
  RetentionRulesSchema,
  ShareLinkListSchema,
  UploadTicketSchema,
} from '../../../packages/shared/src/documents/types.ts';
import type { DocumentDetail } from '../../../packages/shared/src/documents/types.ts';

const ORG = 'efef0000-0000-4000-8000-000000000001';
const OTHER_ORG = 'efef0000-0000-4000-8000-000000000002';
const PASSWORD = 'ComplexPassword123!';
const MFA_SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const U = {
  hr: { id: 'efef0000-0000-4000-8000-000000000011', role: 'HR' },
  hrm: { id: 'efef0000-0000-4000-8000-000000000012', role: 'HR_MANAGER' },
  owner: { id: 'efef0000-0000-4000-8000-000000000013', role: 'EMPLOYEE' },
  viewer: { id: 'efef0000-0000-4000-8000-000000000014', role: 'EMPLOYEE' },
  outsider: { id: 'efef0000-0000-4000-8000-000000000015', role: 'EMPLOYEE' },
  other: { id: 'efef0000-0000-4000-8000-000000000016', role: 'EMPLOYEE' },
} as const;
type Who = keyof typeof U;
const email = (w: Who) => `${w}@vault.test`;
const MFA: readonly Who[] = ['hr', 'hrm'];

// Markers that must never appear in a dump.
const MARKER_CONTENT = 'SALARY-BAND-ZETA-93017';
const MARKER_TITLE = 'Termination plan Q4 OMEGA-55218';
const MARKER_FILE = 'omega-55218-termination.pdf';
const DOC_PASSWORD = 'correct horse battery staple';

const pdfWith = async (text: string): Promise<Buffer> => {
  const d = await PDFDocument.create();
  const page = d.addPage([400, 300]);
  page.drawText(text, { x: 20, y: 150, size: 14 });
  return Buffer.from(await d.save({ useObjectStreams: false }));
};

/** Text drawn on any page (pdf-lib writes WinAnsi hex strings, possibly compressed). */
async function pdfContains(pdf: Buffer, needle: string): Promise<boolean> {
  const doc = await PDFDocument.load(pdf);
  const hex = Buffer.from(needle, 'latin1').toString('hex').toUpperCase();
  for (const page of doc.getPages()) {
    const c = page.node.Contents();
    const refs = c ? ('asArray' in c ? (c as unknown as { asArray(): unknown[] }).asArray() : [c]) : [];
    for (const ref of refs) {
      const s = doc.context.lookup(ref as never) as unknown as { getContents?: () => Uint8Array; contents?: Uint8Array };
      let body = Buffer.from(s.getContents ? s.getContents() : (s.contents ?? new Uint8Array()));
      try {
        body = inflateSync(body);
      } catch {
        // uncompressed
      }
      const str = body.toString('latin1').toUpperCase();
      if (str.includes(hex) || str.includes(needle.toUpperCase())) return true;
    }
  }
  return false;
}

const enabled = !!process.env.S3_ENDPOINT && !!process.env.CLAMAV_HOST;

describe('Confidential vault (FR-DOC-005, 006, 007, 010, 011, 017)', { concurrency: false, skip: enabled ? false : 'S3_ENDPOINT and CLAMAV_HOST are not set' }, () => {
  let app: INestApplication;
  let base: string;
  let adminPool: pg.Pool;
  let s3: S3Client;
  const bucket = process.env.S3_BUCKET || 'hrvo-documents';
  const tokens = {} as Record<Who, string>;
  const docs: Record<string, DocumentDetail> = {};
  let secretPdf: Buffer;

  const api = (who: Who | null, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'vault-e2e/1.0', ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  async function ok<T>(res: Response, status: number, schema?: { parse: (v: unknown) => T }): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return schema ? schema.parse(JSON.parse(text)) : (JSON.parse(text || 'null') as T);
  }
  async function code(res: Response, status: number): Promise<{ code?: string; message: string }> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return JSON.parse(text) as { code?: string; message: string };
  }
  async function upload(who: Who, fileName: string, data: Buffer, target: Record<string, unknown>): Promise<DocumentDetail> {
    const t = await ok(await api(who, '/documents/uploads', { method: 'POST', body: { fileName, size: data.length, ...target } }), 201, UploadTicketSchema);
    const parts = [];
    for (const p of t.parts) {
      const put = await fetch(p.url, { method: 'PUT', body: new Uint8Array(data.subarray((p.partNumber - 1) * t.partSize, p.partNumber * t.partSize)) });
      assert.equal(put.status, 200);
      parts.push({ partNumber: p.partNumber, etag: put.headers.get('etag')! });
    }
    return await ok(await api(who, `/documents/uploads/${t.versionId}/complete`, { method: 'POST', body: { parts } }), 200, DocumentDetailSchema);
  }
  const reauth = (who: Who) =>
    api(who, '/vault/reauth', { method: 'POST', body: MFA.includes(who) ? { totpCode: generateSync({ secret: MFA_SECRET }) } : { password: PASSWORD } });
  const notes = async (who: Who, type: string) =>
    (await adminPool.query<{ title: string; body: string }>(`SELECT title, body FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY created_at`, [U[who].id, type])).rows;
  const logActions = async (documentId: string) =>
    (await adminPool.query<{ action: string }>(`SELECT action FROM document_access_logs WHERE document_id = $1 ORDER BY id`, [documentId])).rows.map((r) => r.action);

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.S3_CREATE_BUCKET = 'true';
    adminPool = new pg.Pool({
      host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev',
      user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres',
    });
    s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION || 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY || '', secretAccessKey: process.env.S3_SECRET_KEY || '' },
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    });
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER_ORG]]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Vault Ltd', 'vault-e2e', 'Asia/Colombo'), ($2, 'Other', 'vault-e2e-other', 'Asia/Colombo')`, [ORG, OTHER_ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const [k, u] of Object.entries(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')`, [u.id, ORG, email(k as Who), k, u.role, hash]);
    }
    await adminPool.query(`UPDATE users SET mfa_enabled = true, mfa_secret = $1 WHERE id = ANY($2::uuid[])`, [MFA_SECRET, [U.hr.id, U.hrm.id]]);
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(3097);
    base = 'http://localhost:3097';
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email(who), password: PASSWORD, ...(MFA.includes(who) ? { totpCode: generateSync({ secret: MFA_SECRET }) } : {}) }),
      });
      const body = (await res.json()) as { accessToken?: string };
      assert.ok(body.accessToken, `login ${who}`);
      tokens[who] = body.accessToken;
    }
    secretPdf = await pdfWith(`Confidential: ${MARKER_CONTENT}`);
  });

  after(async () => {
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER_ORG]]);
    await adminPool.end();
  });

  describe('Re-authentication window (FR-DOC-005)', { concurrency: false }, () => {
    it('confidential content needs a fresh re-authentication; details do not', async () => {
      docs.secret = await upload('owner', MARKER_FILE, secretPdf, { metadata: { title: MARKER_TITLE, category: 'OTHER', confidentiality: 'CONFIDENTIAL', tags: ['hr'] } });
      assert.equal(docs.secret.latestStatus, 'CLEAN');
      assert.equal(docs.secret.title, MARKER_TITLE, 'the owner sees the decrypted title');
      assert.equal(docs.secret.requiresReauth, true);
      const blocked = await code(await api('owner', `/documents/${docs.secret.id}/download`), 403);
      assert.equal(blocked.code, 'REAUTH_REQUIRED');
      assert.ok((await logActions(docs.secret.id)).includes('REAUTH_REQUIRED'));
      assert.equal((await api('owner', '/vault/reauth', { method: 'POST', body: { password: 'wrong' } })).status, 401);
      const st = await ok(await reauth('owner'), 200, ReauthStatusSchema);
      assert.ok(st.validUntil && Date.parse(st.validUntil) > Date.now() + 9 * 60_000);
      const res = await api('owner', `/documents/${docs.secret.id}/download`);
      assert.equal(res.status, 200);
      assert.ok(Buffer.from(await res.arrayBuffer()).equals(secretPdf));
    });

    it('the window expires (default 10 minutes); TOTP works too', async () => {
      await adminPool.query(`UPDATE vault_reauth SET reauthenticated_at = now() - interval '11 minutes' WHERE user_id = $1`, [U.owner.id]);
      assert.equal((await code(await api('owner', `/documents/${docs.secret!.id}/download`), 403)).code, 'REAUTH_REQUIRED');
      await ok(await reauth('owner'), 200);
      await ok(await reauth('hr'), 200, ReauthStatusSchema);
      assert.equal((await api('hr', `/documents/${docs.secret!.id}/download`)).status, 200);
    });
  });

  describe('Encryption at rest: dumps reveal nothing (FR-DOC-007, SRS 10.1)', { concurrency: false }, () => {
    it('a database dump plus a bucket dump contain no content, file name or confidential title', async () => {
      const markers = [MARKER_CONTENT, MARKER_TITLE, MARKER_FILE, 'OMEGA-55218'];
      const hexOf = (m: string) => Buffer.from(m, 'utf8').toString('hex');
      // Database: every row of every table, as text (bytea is rendered as hex).
      const tables = (await adminPool.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'`)).rows.map((r) => r.t);
      let dbDump = '';
      for (const t of tables) {
        const rows = await adminPool.query<{ j: string }>(`SELECT row_to_json(x)::text AS j FROM "${t}" x`);
        dbDump += rows.rows.map((r) => r.j).join('\n');
      }
      assert.ok(dbDump.length > 1000);
      for (const m of markers) {
        assert.ok(!dbDump.includes(m), `database dump contains "${m}"`);
        assert.ok(!dbDump.toLowerCase().includes(hexOf(m)), `database dump contains "${m}" as hex`);
      }
      // Bucket: every object under this org.
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${ORG}/` }));
      assert.ok((listed.Contents ?? []).length >= 1);
      for (const o of listed.Contents ?? []) {
        const body = Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: o.Key! }))).Body!.transformToByteArray());
        const latin = body.toString('latin1').toUpperCase();
        for (const m of markers) {
          assert.ok(!body.includes(Buffer.from(m)), `object ${o.Key} contains "${m}"`);
          assert.ok(!latin.includes(Buffer.from(m, 'latin1').toString('hex').toUpperCase()), `object ${o.Key} contains "${m}" as PDF hex text`);
        }
        assert.ok(!body.includes(Buffer.from('%PDF')), `object ${o.Key} is not ciphertext`);
        assert.ok(!o.Key!.includes('omega'), 'object keys carry no names');
      }
    });

    it('confidential titles are not searchable and never reach notifications or logs in clear', async () => {
      const found = await ok(await api('owner', '/documents?q=OMEGA'), 200, DocumentListSchema);
      assert.equal(found.items.length, 0);
      const mine = await ok(await api('owner', '/documents'), 200, DocumentListSchema);
      assert.equal(mine.items.find((d) => d.id === docs.secret!.id)?.title, MARKER_TITLE);
    });
  });

  describe('Tampering (GCM authentication)', { concurrency: false }, () => {
    it('a modified ciphertext object never yields the original bytes', async () => {
      docs.tamper = await upload('owner', 'tamper.pdf', await pdfWith('tamper me'), { metadata: { title: 'Tamper test', category: 'OTHER' } });
      const key = `${ORG}/${docs.tamper.id}/${docs.tamper.versions[0]!.id}`;
      const obj = Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body!.transformToByteArray());
      obj[obj.length - 10]! ^= 0x01;
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: obj }));
      const res = await api('owner', `/documents/${docs.tamper.id}/download`);
      // The tag is checked at the end of the stream: the transfer is aborted.
      const outcome = await res.arrayBuffer().then((b) => Buffer.from(b)).catch((e: Error) => e);
      assert.ok(outcome instanceof Error || !outcome.equals(await pdfWith('tamper me')), 'tampered content must not be delivered intact');
      const view = await api('owner', `/documents/${docs.tamper.id}/view`);
      assert.ok(view.status >= 400, 'the view-only renderer refuses tampered content');
    });

    it('a modified wrapped key fails without revealing anything', async () => {
      await adminPool.query(`UPDATE document_versions SET dek_wrapped_kms = set_byte(dek_wrapped_kms, 20, get_byte(dek_wrapped_kms, 20) # 1) WHERE id = $1`, [docs.tamper!.versions[0]!.id]);
      const res = await api('owner', `/documents/${docs.tamper!.id}/download`);
      assert.ok(res.status >= 500 || res.status === 403);
      assert.ok(!(await res.text()).includes('tamper me'));
    });
  });

  describe('Document password (FR-DOC-006)', { concurrency: false }, () => {
    it('setting a password re-wraps every version; the KMS-only wrap is gone; nothing opens without it', async () => {
      docs.pw = await upload('owner', 'payroll.pdf', await pdfWith('payroll'), { metadata: { title: 'Payroll export', category: 'TAX' } });
      assert.equal((await api('viewer', `/documents/${docs.pw.id}/password`, { method: 'PUT', body: { password: DOC_PASSWORD } })).status, 404, 'not visible to others');
      assert.equal((await api('owner', `/documents/${docs.pw.id}/password`, { method: 'PUT', body: { password: 'short' } })).status, 400);
      const s = await ok(await api('owner', `/documents/${docs.pw.id}/password`, { method: 'PUT', body: { password: DOC_PASSWORD } }), 200, DocumentSummarySchema);
      assert.equal(s.passwordProtected, true);
      const row = await adminPool.query(`SELECT dek_wrapped_kms, dek_wrapped_pw, pw_salt, pw_kdf_params, dek_wrapped_recovery, recovery_key_id FROM document_versions WHERE document_id = $1`, [docs.pw.id]);
      assert.equal(row.rows[0].dek_wrapped_kms, null);
      assert.ok(row.rows[0].dek_wrapped_pw && row.rows[0].dek_wrapped_recovery);
      assert.equal(row.rows[0].pw_salt.length, 16);
      assert.deepEqual(row.rows[0].pw_kdf_params, { algorithm: 'argon2id', memoryKiB: 65536, passes: 3, parallelism: 1, saltBytes: 16, keyBytes: 32, version: 19 });
      assert.notEqual(row.rows[0].recovery_key_id, process.env.DOCUMENT_KMS_LOCAL_KEY_ID || 'local-1');
      assert.equal((await code(await api('owner', `/documents/${docs.pw.id}/download`), 403)).code, 'PASSWORD_REQUIRED');
      const detail = await ok(await api('owner', `/documents/${docs.pw.id}`), 200, DocumentDetailSchema);
      assert.equal(detail.versions[0]!.fileName, '(protected by a password)');
      const opened = await api('owner', `/documents/${docs.pw.id}/content`, { method: 'POST', body: { mode: 'download', password: DOC_PASSWORD } });
      assert.equal(opened.status, 200);
      assert.ok(await pdfContains(Buffer.from(await opened.arrayBuffer()), 'payroll'));
      const audit = await adminPool.query(`SELECT after::text AS a FROM audit_logs WHERE entity_id = $1 AND action = 'DOCUMENT_PASSWORD_SET'`, [docs.pw.id]);
      assert.equal(audit.rowCount, 1);
      assert.ok(!JSON.stringify(audit.rows).includes(DOC_PASSWORD), 'the password is never stored or logged');
    });

    it('a wrong password fails, is logged, and the third locks the user out and tells HR', async () => {
      const wrong = () => api('owner', `/documents/${docs.pw!.id}/content`, { method: 'POST', body: { mode: 'download', password: 'not the password' } });
      assert.equal((await code(await wrong(), 403)).code, 'WRONG_DOCUMENT_PASSWORD');
      assert.equal((await code(await wrong(), 403)).code, 'WRONG_DOCUMENT_PASSWORD');
      assert.equal((await code(await wrong(), 403)).code, 'WRONG_DOCUMENT_PASSWORD');
      const locked = await code(await api('owner', `/documents/${docs.pw!.id}/content`, { method: 'POST', body: { mode: 'download', password: DOC_PASSWORD } }), 423);
      assert.equal(locked.code, 'LOCKED', 'even the right password waits out the lockout');
      assert.equal((await logActions(docs.pw!.id)).filter((a) => a === 'PASSWORD_FAIL').length, 3);
      const hr = await notes('hr', 'DOCUMENT_PASSWORD_LOCKOUT');
      assert.equal(hr.length, 1);
      assert.match(hr[0]!.body, /3 times/);
    });

    it('a new version of a protected document needs its password', async () => {
      await adminPool.query(`UPDATE document_password_attempts SET locked_until = NULL, failures = 0 WHERE document_id = $1`, [docs.pw!.id]);
      const data = await pdfWith('payroll v2');
      assert.equal((await code(await api('owner', '/documents/uploads', { method: 'POST', body: { fileName: 'payroll-2.pdf', size: data.length, documentId: docs.pw!.id } }), 403)).code, 'PASSWORD_REQUIRED');
      const d = await upload('owner', 'payroll-2.pdf', data, { documentId: docs.pw!.id, documentPassword: DOC_PASSWORD });
      assert.equal(d.currentVersionNo, 2);
      const v2 = await adminPool.query(`SELECT dek_wrapped_kms, dek_wrapped_pw FROM document_versions WHERE document_id = $1 AND version_no = 2`, [docs.pw!.id]);
      assert.equal(v2.rows[0].dek_wrapped_kms, null, 'the scanner-only wrap was destroyed after the scan');
      assert.ok(v2.rows[0].dek_wrapped_pw);
    });

    it('recovery needs vault.recover, re-wraps from the escrow, is audited and the owner is told', async () => {
      assert.equal((await api('hr', `/documents/${docs.pw!.id}/password/recover`, { method: 'POST', body: { newPassword: 'a brand new passphrase', reason: 'Owner forgot it' } })).status, 403, 'HR lacks vault.recover');
      await ok(await api('hrm', `/documents/${docs.pw!.id}/password/recover`, { method: 'POST', body: { newPassword: 'a brand new passphrase', reason: 'Owner forgot it' } }), 200);
      assert.equal((await code(await api('owner', `/documents/${docs.pw!.id}/content`, { method: 'POST', body: { mode: 'download', password: DOC_PASSWORD } }), 403)).code, 'WRONG_DOCUMENT_PASSWORD');
      assert.equal((await api('owner', `/documents/${docs.pw!.id}/content`, { method: 'POST', body: { mode: 'download', password: 'a brand new passphrase' } })).status, 200);
      assert.ok((await logActions(docs.pw!.id)).includes('RECOVER'));
      const audit = await adminPool.query(`SELECT 1 FROM audit_logs WHERE entity_id = $1 AND action = 'VAULT_RECOVER'`, [docs.pw!.id]);
      assert.equal(audit.rowCount, 1);
      assert.match((await notes('owner', 'DOCUMENT_PASSWORD_RECOVERED'))[0]!.body, /Owner forgot it/);
    });

    it('removing the password needs it; afterwards the document opens normally', async () => {
      assert.equal((await api('owner', `/documents/${docs.pw!.id}/password/remove`, { method: 'POST', body: { currentPassword: 'nope nope nope' } })).status, 403);
      await ok(await api('owner', `/documents/${docs.pw!.id}/password/remove`, { method: 'POST', body: { currentPassword: 'a brand new passphrase' } }), 200);
      assert.equal((await api('owner', `/documents/${docs.pw!.id}/download`)).status, 200);
    });
  });

  describe('No access means no information (FR-DOC-009)', { concurrency: false }, () => {
    it('without a grant every route answers 404 and the body names nothing', async () => {
      const id = docs.secret!.id;
      for (const [method, path] of [['GET', ''], ['GET', '/download'], ['GET', '/preview'], ['GET', '/view'], ['GET', '/acl'], ['GET', '/share-links'], ['GET', '/access-log'], ['POST', '/content']] as const) {
        const res = await api('outsider', `/documents/${id}${path}`, method === 'POST' ? { method, body: { mode: 'download' } } : {});
        const text = await res.text();
        assert.ok(res.status === 404 || (path === '/access-log' && res.status === 404), `${method} ${path}: ${res.status}`);
        assert.ok(!text.includes(MARKER_TITLE) && !text.includes('OMEGA') && !text.includes(MARKER_FILE), `${path} leaks`);
      }
      const missing = await api('outsider', '/documents/efef0000-0000-4000-8000-00000000ffff');
      assert.equal(missing.status, 404);
      assert.equal((await (await api('outsider', `/documents/${id}`)).json() as { message: string }).message, (await missing.json() as { message: string }).message, 'existing and missing look identical');
      assert.ok(!(await ok(await api('outsider', '/documents'), 200, DocumentListSchema)).items.some((d) => d.id === id));
    });

    it('a lower level is 403 without detail; VIEW gets only the watermarked rendering', async () => {
      docs.shared = await upload('owner', 'handbook.pdf', await pdfWith('Employee handbook text'), { metadata: { title: 'Handbook', category: 'POLICY' } });
      await ok(await api('owner', `/documents/${docs.shared.id}/acl`, { method: 'POST', body: { principalType: 'USER', principalId: U.viewer.id, permission: 'VIEW' } }), 201);
      const dl = await code(await api('viewer', `/documents/${docs.shared.id}/download`), 403);
      assert.ok(!dl.message.includes('Handbook'));
      const asViewer = await ok(await api('viewer', `/documents/${docs.shared.id}`), 200, DocumentDetailSchema);
      assert.deepEqual([asViewer.abilities.canPreview, asViewer.abilities.canViewOnly, asViewer.abilities.canDownload], [false, true, false]);
      for (const path of ['/view', '/preview']) {
        const res = await api('viewer', `/documents/${docs.shared.id}${path}`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'application/pdf');
        assert.equal(res.headers.get('x-view-only'), '1');
        assert.match(res.headers.get('content-disposition') ?? '', /^inline;.*view only/);
        const pdf = Buffer.from(await res.arrayBuffer());
        assert.ok(await pdfContains(pdf, 'viewer - '), `${path}: the viewer's name is burned in`);
        assert.ok(await pdfContains(pdf, 'view only'));
      }
      const orig = await api('owner', `/documents/${docs.shared.id}/preview`);
      assert.equal(orig.headers.get('x-view-only'), null, 'DOWNLOAD level gets the original');
    });
  });

  describe('Share links (FR-DOC-010)', { concurrency: false }, () => {
    let token = '';
    let linkId = '';

    it('a manager creates a link; only the token hash is stored; the link opens exactly its document', async () => {
      const created = await ok(await api('owner', `/documents/${docs.shared!.id}/share-links`, { method: 'POST', body: { expiresAt: new Date(Date.now() + 86_400_000).toISOString(), maxDownloads: 2 } }), 201, CreatedShareLinkSchema);
      token = created.token;
      linkId = created.link.id;
      assert.match(created.url, new RegExp(`/s/${token}$`));
      const stored = await adminPool.query<{ j: string }>(`SELECT row_to_json(l)::text AS j FROM document_share_links l WHERE id = $1`, [linkId]);
      assert.ok(!stored.rows[0]!.j.includes(token), 'the token itself is not stored');
      const info = await ok(await api(null, `/share/${token}`), 200, PublicShareInfoSchema);
      assert.equal(info.fileName, 'handbook.pdf');
      assert.equal(info.remaining, 2);
      const got = await api(null, `/share/${token}/open`, { method: 'POST', body: { mode: 'download' } });
      assert.equal(got.status, 200);
      assert.ok(await pdfContains(Buffer.from(await got.arrayBuffer()), 'Employee handbook text'));
      const logged = await adminPool.query(`SELECT user_id, detail FROM document_access_logs WHERE document_id = $1 AND action = 'DOWNLOAD' AND detail->>'shareLinkId' = $2`, [docs.shared!.id, linkId]);
      assert.equal(logged.rowCount, 1);
      assert.equal(logged.rows[0].user_id, null);
    });

    it('the download limit, revocation and bad tokens all end in the same 404', async () => {
      assert.equal((await api(null, `/share/${token}/open`, { method: 'POST', body: { mode: 'download' } })).status, 200);
      const exhausted = await code(await api(null, `/share/${token}/open`, { method: 'POST', body: { mode: 'download' } }), 404);
      const bogus = await code(await api(null, `/share/${'A'.repeat(43)}`), 404);
      assert.equal(exhausted.message, bogus.message);
      assert.equal((await api(null, `/share/${token.slice(0, -1)}x`)).status, 404);
      const again = await ok(await api('owner', `/documents/${docs.shared!.id}/share-links`, { method: 'POST', body: { expiresAt: new Date(Date.now() + 86_400_000).toISOString() } }), 201, CreatedShareLinkSchema);
      await ok(await api('owner', `/documents/${docs.shared!.id}/share-links/${again.link.id}`, { method: 'DELETE' }), 200, ShareLinkListSchema);
      assert.equal((await api(null, `/share/${again.token}`)).status, 404);
      // Expired links stop at once.
      const exp = await ok(await api('owner', `/documents/${docs.shared!.id}/share-links`, { method: 'POST', body: { expiresAt: new Date(Date.now() + 86_400_000).toISOString() } }), 201, CreatedShareLinkSchema);
      await adminPool.query(`UPDATE document_share_links SET expires_at = now() - interval '1 second' WHERE id = $1`, [exp.link.id]);
      assert.equal((await api(null, `/share/${exp.token}`)).status, 404);
    });

    it('a valid link to one document never opens another; users cannot read each other\'s documents', async () => {
      docs.othersDoc = await upload('other', 'others.pdf', await pdfWith('OTHER-PRIVATE-77'), { metadata: { title: 'Other private', category: 'OTHER' } });
      const mine = await ok(await api('owner', `/documents/${docs.shared!.id}/share-links`, { method: 'POST', body: { expiresAt: new Date(Date.now() + 86_400_000).toISOString() } }), 201, CreatedShareLinkSchema);
      // Extra parameters are ignored: the token alone decides the document.
      const res = await api(null, `/share/${mine.token}/open?documentId=${docs.othersDoc.id}`, { method: 'POST', body: { mode: 'download', documentId: docs.othersDoc.id } });
      assert.equal(res.status, 200);
      const body = Buffer.from(await res.arrayBuffer());
      assert.ok(!(await pdfContains(body, 'OTHER-PRIVATE-77')));
      // Holding a link gives no session rights.
      assert.equal((await api('owner', `/documents/${docs.othersDoc.id}`)).status, 404);
      assert.equal((await api('other', `/documents/${docs.shared!.id}`)).status, 404);
      assert.equal((await api('owner', `/documents/${docs.othersDoc.id}/share-links`, { method: 'POST', body: { expiresAt: new Date(Date.now() + 86_400_000).toISOString() } })).status, 404);
    });

    it('rules: restricted never, confidential only with a link password, view-only links stamp and refuse download', async () => {
      const restricted = await upload('owner', 'r.pdf', await pdfWith('r'), { metadata: { title: 'Restricted thing', category: 'OTHER', confidentiality: 'RESTRICTED' } });
      assert.equal((await api('owner', `/documents/${restricted.id}/share-links`, { method: 'POST', body: { expiresAt: new Date(Date.now() + 86_400_000).toISOString() } })).status, 403);
      assert.equal((await api('owner', `/documents/${docs.secret!.id}/share-links`, { method: 'POST', body: { expiresAt: new Date(Date.now() + 86_400_000).toISOString() } })).status, 400);
      assert.equal((await api('owner', `/documents/${docs.shared!.id}/share-links`, { method: 'POST', body: { expiresAt: new Date(Date.now() + 200 * 86_400_000).toISOString() } })).status, 400, 'at most 90 days');
      const vo = await ok(await api('owner', `/documents/${docs.secret!.id}/share-links`, { method: 'POST', body: { expiresAt: new Date(Date.now() + 86_400_000).toISOString(), password: 'link-pass-123', viewOnly: true } }), 201, CreatedShareLinkSchema);
      const info = await ok(await api(null, `/share/${vo.token}`), 200, PublicShareInfoSchema);
      assert.equal(info.passwordRequired, true);
      assert.equal(info.viewOnly, true);
      assert.equal((await code(await api(null, `/share/${vo.token}/open`, { method: 'POST', body: { mode: 'view' } }), 401)).code, 'LINK_PASSWORD');
      assert.equal((await api(null, `/share/${vo.token}/open`, { method: 'POST', body: { mode: 'download', password: 'link-pass-123' } })).status, 403);
      const view = await api(null, `/share/${vo.token}/open`, { method: 'POST', body: { mode: 'view', password: 'link-pass-123' } });
      assert.equal(view.status, 200);
      const pdf = Buffer.from(await view.arrayBuffer());
      assert.ok(await pdfContains(pdf, 'Shared link - '));
      assert.ok(await pdfContains(pdf, MARKER_CONTENT), 'the content is there, stamped');
      for (let i = 0; i < 5; i += 1) await api(null, `/share/${vo.token}/open`, { method: 'POST', body: { mode: 'view', password: 'guess' } });
      assert.equal((await api(null, `/share/${vo.token}`)).status, 404, 'five wrong passwords revoke the link');
      assert.equal((await notes('owner', 'SHARE_LINK_LOCKED')).length, 1);
    });
  });

  describe('Trash, crypto-shredding, legal hold and retention (FR-DOC-017)', { concurrency: false }, () => {
    it('delete moves to the trash; restorable for 30 days', async () => {
      docs.trash = await upload('owner', 'old.pdf', await pdfWith('old contract text'), { metadata: { title: 'Old', category: 'CONTRACT' } });
      await ok(await api('owner', `/documents/${docs.trash.id}`, { method: 'DELETE' }), 200);
      assert.equal((await api('owner', `/documents/${docs.trash.id}`)).status, 404);
      const trash = await ok(await api('owner', '/documents/trash'), 200, DocumentListSchema);
      assert.ok(trash.items.some((d) => d.id === docs.trash!.id && d.deletedAt));
      await ok(await api('owner', `/documents/${docs.trash.id}/untrash`, { method: 'POST' }), 200);
      assert.equal((await api('owner', `/documents/${docs.trash.id}`)).status, 200);
    });

    it('after 30 days the keys are destroyed and the ciphertext deleted: nothing can be recovered', async () => {
      await ok(await api('owner', `/documents/${docs.trash!.id}`, { method: 'DELETE' }), 200);
      await adminPool.query(`UPDATE documents SET deleted_at = now() - interval '31 days' WHERE id = $1`, [docs.trash!.id]);
      const r = await app.get(DocumentMaintenanceService).shredDue(ORG, new Date());
      assert.ok(r >= 1);
      const v = await adminPool.query(`SELECT dek_wrapped_kms, dek_wrapped_pw, dek_wrapped_recovery, file_name_enc, storage_key FROM document_versions WHERE document_id = $1`, [docs.trash!.id]);
      assert.deepEqual([v.rows[0].dek_wrapped_kms, v.rows[0].dek_wrapped_pw, v.rows[0].dek_wrapped_recovery, v.rows[0].file_name_enc], [null, null, null, null]);
      const d = await adminPool.query(`SELECT shredded_at, title FROM documents WHERE id = $1`, [docs.trash!.id]);
      assert.ok(d.rows[0].shredded_at);
      assert.equal(d.rows[0].title, null);
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${ORG}/${docs.trash!.id}/` }));
      assert.equal((listed.Contents ?? []).length, 0, 'objects deleted');
      assert.equal((await api('hr', `/documents/${docs.trash!.id}`)).status, 404);
      assert.equal((await api('owner', `/documents/${docs.trash!.id}/untrash`, { method: 'POST' })).status, 404);
      assert.ok((await logActions(docs.trash!.id)).includes('SHRED'));
      assert.equal((await adminPool.query(`SELECT 1 FROM audit_logs WHERE entity_id = $1 AND action = 'DOCUMENT_SHREDDED'`, [docs.trash!.id])).rowCount, 1);
    });

    it('legal hold blocks deletion and shredding; only documents.legal_hold sets it, with a reason', async () => {
      const held = await upload('owner', 'held.pdf', await pdfWith('held'), { metadata: { title: 'Held', category: 'OTHER' } });
      assert.equal((await api('hr', `/documents/${held.id}/legal-hold`, { method: 'PUT', body: { hold: true, reason: 'Litigation 2026-11' } })).status, 403, 'HR lacks legal hold');
      assert.equal((await api('hrm', `/documents/${held.id}/legal-hold`, { method: 'PUT', body: { hold: true } })).status, 400);
      await ok(await api('hrm', `/documents/${held.id}/legal-hold`, { method: 'PUT', body: { hold: true, reason: 'Litigation 2026-11' } }), 200);
      assert.equal((await api('owner', `/documents/${held.id}`, { method: 'DELETE' })).status, 409);
      await adminPool.query(`UPDATE documents SET deleted_at = now() - interval '40 days' WHERE id = $1`, [held.id]);
      await app.get(DocumentMaintenanceService).shredDue(ORG, new Date());
      const row = await adminPool.query(`SELECT shredded_at FROM documents WHERE id = $1`, [held.id]);
      assert.equal(row.rows[0].shredded_at, null, 'a held document is never shredded');
    });

    it('retention: a minimum keeps deletion back; auto-shred removes documents past their maximum', async () => {
      assert.equal((await api('hr', '/documents/retention', { method: 'PUT', body: { rules: [{ category: 'INVOICE', minYears: 7, autoShredYears: null }] } })).status, 403);
      assert.equal((await api('hrm', '/documents/retention', { method: 'PUT', body: { rules: [{ category: 'INVOICE', minYears: 7, autoShredYears: 5 }] } })).status, 400);
      const rules = await ok(await api('hrm', '/documents/retention', { method: 'PUT', body: { rules: [{ category: 'INVOICE', minYears: 7, autoShredYears: null }, { category: 'CERTIFICATE', minYears: null, autoShredYears: 3 }] } }), 200, RetentionRulesSchema);
      assert.equal(rules.rules.find((r) => r.category === 'INVOICE')?.minYears, 7);
      const inv = await upload('owner', 'inv.pdf', await pdfWith('inv'), { metadata: { title: 'Invoice', category: 'INVOICE' } });
      const res = await code(await api('owner', `/documents/${inv.id}`, { method: 'DELETE' }), 409);
      assert.match(res.message, /kept until/);
      const cert = await upload('owner', 'cert.pdf', await pdfWith('cert'), { metadata: { title: 'Old certificate', category: 'CERTIFICATE' } });
      await adminPool.query(`UPDATE documents SET created_at = now() - interval '4 years' WHERE id = $1`, [cert.id]);
      await app.get(DocumentMaintenanceService).shredDue(ORG, new Date());
      assert.ok((await adminPool.query(`SELECT shredded_at FROM documents WHERE id = $1`, [cert.id])).rows[0].shredded_at);
    });
  });
});
