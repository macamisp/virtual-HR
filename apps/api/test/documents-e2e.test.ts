/**
 * Documents E2E against real S3-compatible storage and a real clamd (FR-DOC-001..004, 007,
 * 009, 012, 013, 015, 019): presigned multipart uploads, content sniffing, virus scanning
 * with quarantine, encryption at rest, versions and restore, ACL (users, roles, teams,
 * folders, expiry), access logging, preview, contracts, expiry reminders and RLS.
 *
 * Needs S3_ENDPOINT (+ keys, S3_CREATE_BUCKET=true) and CLAMAV_HOST/PORT; skipped otherwise.
 */
import 'reflect-metadata';
import { freshCode } from './support/totp.ts';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { formatInTimeZone } from 'date-fns-tz';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { DocumentMaintenanceService } from '../src/documents/document-maintenance.service.ts';
import { addDaysIso } from '../src/planning/planning-rules.ts';
import {
  AccessLogListSchema,
  AclListSchema,
  ContractListSchema,
  ContractSchema,
  DocumentDetailSchema,
  DocumentListSchema,
  FolderListSchema,
  UploadStateSchema,
  UploadTicketSchema,
} from '../../../packages/shared/src/documents/types.ts';
import type { DocumentDetail } from '../../../packages/shared/src/documents/types.ts';

const ORG = 'cdcd0000-0000-4000-8000-000000000001';
const OTHER_ORG = 'cdcd0000-0000-4000-8000-000000000002';
const TEAM = 'cdcd0000-0000-4000-8000-000000000101';
const TEAM2 = 'cdcd0000-0000-4000-8000-000000000102';
const PASSWORD = 'ComplexPassword123!';
const MFA_SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const U = {
  hr: { id: 'cdcd0000-0000-4000-8000-000000000011', role: 'HR', team: null as string | null },
  lead: { id: 'cdcd0000-0000-4000-8000-000000000012', role: 'TEAM_LEAD', team: TEAM as string | null },
  emp: { id: 'cdcd0000-0000-4000-8000-000000000013', role: 'EMPLOYEE', team: TEAM as string | null },
  sub: { id: 'cdcd0000-0000-4000-8000-000000000014', role: 'SUBCONTRACTOR', team: TEAM as string | null },
  sub2: { id: 'cdcd0000-0000-4000-8000-000000000015', role: 'SUBCONTRACTOR', team: TEAM2 as string | null },
  aud: { id: 'cdcd0000-0000-4000-8000-000000000016', role: 'AUDITOR', team: null as string | null },
  emp2: { id: 'cdcd0000-0000-4000-8000-000000000017', role: 'EMPLOYEE', team: TEAM2 as string | null },
} as const;
type Who = keyof typeof U;
const email = (w: Who) => `${w}@docs.test`;

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
// A minimal but real one-page PDF (the view-only renderer refuses anything it cannot stamp).
const pdf = (text: string) => Buffer.from(
  `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n` +
    `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj\n% ${text}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c10000000049454e44ae426082', 'hex');

const enabled = !!process.env.S3_ENDPOINT && !!process.env.CLAMAV_HOST;

describe('Documents API (FR-DOC-001..004, 007, 009, 012, 013, 015, 019)', { concurrency: false, skip: enabled ? false : 'S3_ENDPOINT and CLAMAV_HOST are not set' }, () => {
  let app: INestApplication;
  let base: string;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  let s3: S3Client;
  const tokens = {} as Record<Who, string>;
  const today = formatInTimeZone(new Date(), 'Asia/Colombo', 'yyyy-MM-dd');
  const docs: Record<string, DocumentDetail> = {};
  const bytes: Record<string, Buffer> = {};

  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}`, 'User-Agent': 'docs-e2e/1.0' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  async function ok<T>(res: Response, status: number, schema?: { parse: (v: unknown) => T }): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return schema ? schema.parse(JSON.parse(text)) : (JSON.parse(text || 'null') as T);
  }

  /** The browser's side of an upload: PUT each part to its presigned URL, then complete. */
  async function upload(who: Who, fileName: string, data: Buffer, target: { metadata?: Record<string, unknown>; documentId?: string }, declared = data.length): Promise<DocumentDetail> {
    const ticket = await ok(await api(who, '/documents/uploads', { method: 'POST', body: { fileName, size: declared, ...target } }), 201, UploadTicketSchema);
    const parts = [];
    for (const p of ticket.parts) {
      const chunk = data.subarray((p.partNumber - 1) * ticket.partSize, p.partNumber * ticket.partSize);
      if (chunk.length === 0) continue;
      const put = await fetch(p.url, { method: 'PUT', body: new Uint8Array(chunk) });
      assert.equal(put.status, 200, `part ${p.partNumber}: ${await put.text()}`);
      parts.push({ partNumber: p.partNumber, etag: put.headers.get('etag')! });
    }
    return await ok(await api(who, `/documents/uploads/${ticket.versionId}/complete`, { method: 'POST', body: { parts } }), 200, DocumentDetailSchema);
  }
  const meta = (title: string, extra: Record<string, unknown> = {}) => ({ metadata: { title, category: 'OTHER', ...extra } });
  const objectExists = async (key: string) => {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET || 'hrvo-documents', Key: key }));
      return true;
    } catch {
      return false;
    }
  };
  const notes = async (who: Who, type: string) =>
    (await adminPool.query<{ title: string; body: string; dedupe_key: string | null }>(`SELECT title, body, dedupe_key FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY created_at`, [U[who].id, type])).rows;
  const logs = async (documentId: string) =>
    (await adminPool.query<{ action: string; user_id: string | null; ip: string | null; user_agent: string | null }>(`SELECT action, user_id, ip, user_agent FROM document_access_logs WHERE document_id = $1 ORDER BY id`, [documentId])).rows;

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.S3_CREATE_BUCKET = 'true';
    const pgBase = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev' };
    adminPool = new pg.Pool({ ...pgBase, user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    appPool = new pg.Pool({ ...pgBase, user: process.env.PGUSER || 'hrvo_app', password: process.env.PGPASSWORD || 'hrvo_app_pass' });
    s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION || 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY || '', secretAccessKey: process.env.S3_SECRET_KEY || '' },
    });
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER_ORG]]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Docs Ltd', 'docs-e2e', 'Asia/Colombo'), ($2, 'Other', 'docs-e2e-other', 'Asia/Colombo')`, [ORG, OTHER_ORG]);
    await adminPool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $3, 'Alpha'), ($2, $3, 'Beta')`, [TEAM, TEAM2, ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const [k, u] of Object.entries(U)) {
      await adminPool.query(
        `INSERT INTO users (id, org_id, email, display_name, role, team_id, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`,
        [u.id, ORG, email(k as Who), k, u.role, u.team, hash],
      );
    }
    await adminPool.query(`UPDATE users SET manager_id = $1 WHERE id = ANY($2::uuid[])`, [U.lead.id, [U.emp.id, U.sub.id]]);
    await adminPool.query(`UPDATE users SET mfa_enabled = true, mfa_secret = $1 WHERE id = $2`, [MFA_SECRET, U.hr.id]);

    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(3095);
    base = 'http://localhost:3095';
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email(who), password: PASSWORD, ...(who === 'hr' ? { totpCode: await freshCode(MFA_SECRET) } : {}) }),
      });
      const body = (await res.json()) as { accessToken?: string };
      assert.ok(body.accessToken, `login ${who}`);
      tokens[who] = body.accessToken;
    }
  });

  after(async () => {
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER_ORG]]);
    await adminPool.end();
    await appPool.end();
  });

  describe('Upload, scan, encryption at rest (FR-DOC-001, 007, 013)', { concurrency: false }, () => {
    it('a PDF uploads through presigned URLs, is scanned clean, encrypted at rest and downloads byte-identical', async () => {
      bytes.policy = pdf('Remote work policy v1');
      const d = await upload('emp', 'policy.pdf', bytes.policy, meta('Remote work policy', { category: 'POLICY', tags: ['remote', 'Remote', 'hr'], expiresAt: addDaysIso(today, 45) }));
      docs.policy = d;
      assert.equal(d.latestStatus, 'CLEAN');
      assert.equal(d.currentVersionNo, 1);
      assert.equal(d.mimeType, 'application/pdf');
      assert.deepEqual(d.tags, ['remote', 'Remote', 'hr']);
      assert.equal(d.versions[0]!.fileName, 'policy.pdf');
      assert.equal(d.versions[0]!.sha256, createHash('sha256').update(bytes.policy).digest('hex'));
      assert.deepEqual(d.abilities, { canView: true, canPreview: true, canViewOnly: true, canDownload: true, canEdit: true, canManage: true });

      const res = await api('emp', `/documents/${d.id}/download`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/pdf');
      assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="policy\.pdf"/);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes.policy));

      // At rest: ciphertext under {org}/{doc}/{version}; the staging plaintext is gone.
      const v = d.versions[0]!;
      const stored = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET || 'hrvo-documents', Key: `${ORG}/${d.id}/${v.id}` }));
      const cipher = Buffer.from(await stored.Body!.transformToByteArray());
      assert.equal(cipher.length, bytes.policy.length);
      assert.ok(!cipher.includes(Buffer.from('%PDF')) && !cipher.includes(Buffer.from('Remote work policy')));
      assert.equal(await objectExists(`${ORG}/_staging/${d.id}/${v.id}`), false);
      const row = await adminPool.query(`SELECT dek_wrapped_kms, file_name_enc, kms_key_id FROM document_versions WHERE id = $1`, [v.id]);
      assert.ok(!row.rows[0].file_name_enc.includes(Buffer.from('policy.pdf')), 'file names are stored encrypted');
      assert.equal(row.rows[0].kms_key_id, process.env.DOCUMENT_KMS_PROVIDER === 'aws' ? process.env.DOCUMENT_KMS_KEY_ID : (process.env.DOCUMENT_KMS_LOCAL_KEY_ID || 'local-1'));
    });

    it('large files go in several parts and uploads can resume with fresh part URLs', async () => {
      const big = Buffer.concat([pdf('big'), Buffer.alloc(9 * 1024 * 1024, 0x20)]);
      const ticket = await ok(await api('emp', '/documents/uploads', { method: 'POST', body: { fileName: 'handbook.pdf', size: big.length, ...meta('Handbook') } }), 201, UploadTicketSchema);
      assert.equal(ticket.partCount, 2);
      const first = await fetch(ticket.parts[0]!.url, { method: 'PUT', body: new Uint8Array(big.subarray(0, ticket.partSize)) });
      assert.equal(first.status, 200);
      const state = await ok(await api('emp', `/documents/uploads/${ticket.versionId}`), 200, UploadStateSchema);
      assert.deepEqual(state.uploadedParts.map((p) => p.partNumber), [1]);
      assert.equal((await api('lead', `/documents/uploads/${ticket.versionId}`)).status, 404, 'only the uploader sees an upload');
      const fresh = await ok(await api('emp', `/documents/uploads/${ticket.versionId}/parts`, { method: 'POST', body: { partNumbers: [2] } }), 200, UploadTicketSchema);
      const second = await fetch(fresh.parts[0]!.url, { method: 'PUT', body: new Uint8Array(big.subarray(ticket.partSize)) });
      assert.equal(second.status, 200);
      const done = await ok(await api('emp', `/documents/uploads/${ticket.versionId}/complete`, {
        method: 'POST', body: { parts: [{ partNumber: 1, etag: first.headers.get('etag') }, { partNumber: 2, etag: second.headers.get('etag') }] },
      }), 200, DocumentDetailSchema);
      assert.equal(done.latestStatus, 'CLEAN');
      assert.equal(done.sizeBytes, big.length);
      const back = Buffer.from(await (await api('emp', `/documents/${done.id}/download`)).arrayBuffer());
      assert.equal(createHash('sha256').update(back).digest('hex'), createHash('sha256').update(big).digest('hex'));
    });

    it('the type allow-list and the 100 MB limit are enforced before any upload', async () => {
      assert.equal((await api('emp', '/documents/uploads', { method: 'POST', body: { fileName: 'tool.exe', size: 10, ...meta('Tool') } })).status, 400);
      assert.equal((await api('emp', '/documents/uploads', { method: 'POST', body: { fileName: 'page.html', size: 10, ...meta('Page') } })).status, 400);
      assert.equal((await api('emp', '/documents/uploads', { method: 'POST', body: { fileName: 'huge.pdf', size: 100 * 1024 * 1024 + 1, ...meta('Huge') } })).status, 400);
      assert.equal((await api('emp', '/documents/uploads', { method: 'POST', body: { fileName: '../../etc/passwd.txt', size: 10, ...meta('Path') } })).status, 400);
    });

    it('content sniffing: the bytes decide, not the extension', async () => {
      const fake = await upload('emp', 'invoice.pdf', Buffer.from('MZ\x90\x00 this is really an executable'), meta('Fake invoice'));
      assert.equal(fake.latestStatus, 'REJECTED');
      assert.match(fake.versions[0]!.scanDetail ?? '', /Executables are not allowed/);
      assert.equal(fake.currentVersionNo, null);
      assert.equal((await api('emp', `/documents/${fake.id}/download`)).status, 409);
      const text = await upload('emp', 'notes.pdf', Buffer.from('just some plain text'), meta('Notes'));
      assert.match(text.versions[0]!.scanDetail ?? '', /does not match the \.pdf extension/);
      const svg = await upload('emp', 'logo.txt', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), meta('Logo'));
      assert.equal(svg.latestStatus, 'REJECTED');
      assert.ok((await notes('emp', 'DOCUMENT_REJECTED')).some((n) => n.title === 'Upload refused: Fake invoice'));
      const lying = await upload('emp', 'short.pdf', pdf('short'), meta('Short'), pdf('short').length + 100);
      assert.equal(lying.latestStatus, 'REJECTED');
      assert.match(lying.versions[0]!.scanDetail ?? '', /does not match the announced size/);
    });

    it('an infected file is quarantined, never served, and the uploader is notified', async () => {
      const d = await upload('sub', 'eicar.txt', Buffer.from(EICAR), meta('Suspicious notes'));
      assert.equal(d.latestStatus, 'INFECTED');
      assert.match(d.versions[0]!.scanDetail ?? '', /Malware detected: .*EICAR/i);
      const v = d.versions[0]!;
      assert.equal(await objectExists(`${ORG}/_quarantine/${d.id}/${v.id}`), true);
      assert.equal(await objectExists(`${ORG}/_staging/${d.id}/${v.id}`), false);
      assert.equal((await api('sub', `/documents/${d.id}/download?versionId=${v.id}`)).status, 409);
      assert.equal((await api('hr', `/documents/${d.id}/download?versionId=${v.id}`)).status, 409, 'not even HR');
      const n = await notes('sub', 'DOCUMENT_INFECTED');
      assert.equal(n.length, 1);
      assert.match(n[0]!.body, /quarantined/);
      assert.ok((await logs(d.id)).some((l) => l.action === 'QUARANTINE'));
      const audit = await adminPool.query(`SELECT 1 FROM audit_logs WHERE org_id = $1 AND action = 'DOCUMENT_INFECTED' AND entity_id = $2`, [ORG, d.id]);
      assert.equal(audit.rowCount, 1);
    });
  });

  describe('Versions and restore (FR-DOC-004)', { concurrency: false }, () => {
    it('a new upload adds a version; restoring an old one adds another, nothing is overwritten', async () => {
      bytes.policy2 = pdf('Remote work policy v2');
      let d = await upload('emp', 'policy-v2.pdf', bytes.policy2, { documentId: docs.policy!.id });
      assert.equal(d.currentVersionNo, 2);
      assert.deepEqual(d.versions.map((v) => v.versionNo), [2, 1]);
      const v1 = d.versions.find((v) => v.versionNo === 1)!;
      d = await ok(await api('emp', `/documents/${d.id}/versions/${v1.id}/restore`, { method: 'POST' }), 200, DocumentDetailSchema);
      assert.equal(d.currentVersionNo, 3);
      assert.equal(d.versions[0]!.restoredFromVersionNo, 1);
      assert.equal(d.versions[0]!.fileName, 'policy.pdf');
      assert.ok(Buffer.from(await (await api('emp', `/documents/${d.id}/download`)).arrayBuffer()).equals(bytes.policy));
      const v2 = d.versions.find((v) => v.versionNo === 2)!;
      assert.ok(Buffer.from(await (await api('emp', `/documents/${d.id}/download?versionId=${v2.id}`)).arrayBuffer()).equals(bytes.policy2));
      assert.equal((await api('emp', `/documents/${d.id}/versions/${d.versions[0]!.id}/restore`, { method: 'POST' })).status, 409, 'already current');
      docs.policy = d;
    });
  });

  describe('Access control (FR-DOC-009)', { concurrency: false }, () => {
    it('defaults: owner and HR see it; managers and colleagues do not; subcontractors see only their own', async () => {
      const id = docs.policy!.id;
      assert.equal((await api('hr', `/documents/${id}`)).status, 200);
      assert.equal((await api('lead', `/documents/${id}`)).status, 404, 'no implicit manager access');
      assert.equal((await api('sub', `/documents/${id}`)).status, 404);
      bytes.invoice = pdf('Invoice 42');
      docs.invoice = await upload('sub', 'invoice-42.pdf', bytes.invoice, meta('Invoice 42', { category: 'INVOICE' }));
      assert.equal(docs.invoice.linkedUser?.id, U.sub.id, "a subcontractor's upload is linked to them");
      const subList = await ok(await api('sub', '/documents'), 200, DocumentListSchema);
      assert.ok(subList.items.every((x) => x.owner.id === U.sub.id || x.linkedUser?.id === U.sub.id));
      assert.equal((await api('emp', `/documents/${docs.invoice.id}`)).status, 404);
      const hrList = await ok(await api('hr', '/documents?category=INVOICE'), 200, DocumentListSchema);
      assert.ok(hrList.items.some((x) => x.id === docs.invoice!.id));
    });

    it('only HR links a document to someone else', async () => {
      const res = await api('emp', '/documents/uploads', { method: 'POST', body: { fileName: 'x.pdf', size: 10, ...meta('For lead', { linkedUserId: U.lead.id }) } });
      assert.equal(res.status, 403);
      bytes.contract = pdf('Sub contract');
      docs.contract = await upload('hr', 'contract-sam.pdf', bytes.contract, meta('Contract — sub', { category: 'CONTRACT', linkedUserId: U.sub.id, confidentiality: 'CONFIDENTIAL' }));
      const asSub = await ok(await api('sub', `/documents/${docs.contract.id}`), 200, DocumentDetailSchema);
      assert.deepEqual(asSub.abilities, { canView: true, canPreview: true, canViewOnly: true, canDownload: true, canEdit: false, canManage: false });
      assert.equal((await api('sub', `/documents/${docs.contract.id}`, { method: 'PATCH', body: { version: asSub.version, title: 'Mine now' } })).status, 403);
    });

    it('team grants reach employees of the team but never subcontractors in it', async () => {
      const id = docs.policy!.id;
      const grant = await ok(await api('emp', `/documents/${id}/acl`, { method: 'POST', body: { principalType: 'TEAM', principalId: TEAM, permission: 'VIEW' } }), 201, AclListSchema);
      assert.equal(grant.items.length, 1);
      assert.equal(grant.items[0]!.principalLabel, 'Team: Alpha');
      const lead = await ok(await api('lead', `/documents/${id}`), 200, DocumentDetailSchema);
      // FR-DOC-011: VIEW gets the watermarked rendering, not the original.
      assert.deepEqual(lead.abilities, { canView: true, canPreview: false, canViewOnly: true, canDownload: false, canEdit: false, canManage: false });
      assert.equal((await api('lead', `/documents/${id}/download`)).status, 403);
      const preview = await api('lead', `/documents/${id}/preview`);
      assert.equal(preview.status, 200);
      assert.match(preview.headers.get('content-disposition') ?? '', /^inline;/);
      assert.equal(preview.headers.get('x-view-only'), '1');
      assert.equal(preview.headers.get('content-type'), 'application/pdf');
      assert.match(preview.headers.get('content-security-policy') ?? '', /sandbox/);
      assert.equal((await api('sub', `/documents/${id}`)).status, 404, 'the subcontractor in team Alpha is not included');
      assert.equal((await api('emp', `/documents/${id}/acl`, { method: 'POST', body: { principalType: 'TEAM', principalId: TEAM, permission: 'VIEW' } })).status, 409, 'duplicate grant');
    });

    it('user and role grants, with expiry; levels gate each action', async () => {
      const id = docs.policy!.id;
      await ok(await api('emp', `/documents/${id}/acl`, { method: 'POST', body: { principalType: 'USER', principalId: U.sub.id, permission: 'DOWNLOAD' } }), 201);
      assert.equal((await api('sub', `/documents/${id}/download`)).status, 200);
      assert.equal((await api('sub', `/documents/${id}/acl`)).status, 403, 'download is not manage');
      await adminPool.query(`UPDATE document_acl SET expires_at = now() - interval '1 minute' WHERE document_id = $1 AND principal_id = $2`, [id, U.sub.id]);
      assert.equal((await api('sub', `/documents/${id}`)).status, 404, 'expired grants stop working');
      await ok(await api('emp', `/documents/${id}/acl`, { method: 'POST', body: { principalType: 'ROLE', principalRole: 'SUBCONTRACTOR', permission: 'VIEW', expiresAt: new Date(Date.now() + 86_400_000).toISOString() } }), 201);
      assert.equal((await api('sub2', `/documents/${id}`)).status, 200, 'a grant to the SUBCONTRACTOR role is explicit');
      await ok(await api('emp', `/documents/${id}/acl`, { method: 'POST', body: { principalType: 'USER', principalId: U.emp2.id, permission: 'EDIT' } }), 201);
      const asEditor = await ok(await api('emp2', `/documents/${id}`), 200, DocumentDetailSchema);
      assert.equal(asEditor.abilities.canEdit, true);
      assert.equal(asEditor.abilities.canManage, false);
      await ok(await api('emp2', `/documents/${id}`, { method: 'PATCH', body: { version: asEditor.version, tags: ['remote', 'policy'] } }), 200);
      assert.equal((await api('emp2', `/documents/${id}`, { method: 'PATCH', body: { version: asEditor.version, tags: ['stale'] } })).status, 409);
      assert.equal((await api('emp2', `/documents/${id}`, { method: 'DELETE' })).status, 403);
      assert.equal((await api('emp', `/documents/${id}/acl`, { method: 'POST', body: { principalType: 'USER', principalId: U.emp2.id, permission: 'VIEW', expiresAt: '2020-01-01T00:00:00Z' } })).status, 400);
      const list = await ok(await api('emp', `/documents/${id}/acl`), 200, AclListSchema);
      const revoked = await ok(await api('emp', `/documents/${id}/acl/${list.items.find((g) => g.principalId === U.emp2.id)!.id}`, { method: 'DELETE' }), 200, AclListSchema);
      assert.ok(!revoked.items.some((g) => g.principalId === U.emp2.id));
      assert.equal((await api('emp2', `/documents/${id}`)).status, 404);
    });

    it('folder grants are inherited by sub-folders and their documents', async () => {
      assert.equal((await api('emp', '/documents/folders', { method: 'POST', body: { name: 'Policies' } })).status, 403, 'top-level folders are HR');
      const parent = await ok<{ id: string }>(await api('hr', '/documents/folders', { method: 'POST', body: { name: 'Policies' } }), 201);
      const child = await ok<{ id: string }>(await api('hr', '/documents/folders', { method: 'POST', body: { name: 'IT', parentId: parent.id } }), 201);
      assert.equal((await api('hr', '/documents/folders', { method: 'POST', body: { name: 'policies' } })).status, 409);
      await ok(await api('hr', `/documents/folders/${parent.id}/acl`, { method: 'POST', body: { principalType: 'ROLE', principalRole: 'EMPLOYEE', permission: 'VIEW' } }), 201);
      await ok(await api('hr', `/documents/folders/${child.id}/acl`, { method: 'POST', body: { principalType: 'USER', principalId: U.emp.id, permission: 'EDIT' } }), 201);
      docs.itPolicy = await upload('hr', 'it-policy.png', PNG, meta('IT policy diagram', { folderId: child.id, category: 'POLICY' }));
      const asEmp2 = await ok(await api('emp2', `/documents/${docs.itPolicy.id}`), 200, DocumentDetailSchema);
      assert.equal(asEmp2.folderName, 'IT');
      assert.equal(asEmp2.abilities.canDownload, false);
      const img = await api('emp2', `/documents/${docs.itPolicy.id}/preview`);
      assert.equal(img.headers.get('content-type'), 'application/pdf', 'a VIEW-only user gets the image stamped into a PDF');
      assert.equal(img.headers.get('x-view-only'), '1');
      const emp2Folders = await ok(await api('emp2', '/documents/folders'), 200, FolderListSchema);
      assert.deepEqual(emp2Folders.items.map((f) => f.name).sort(), ['IT', 'Policies']);
      assert.equal((await api('sub', '/documents/folders').then((r) => r.json()) as { items: unknown[] }).items.length, 0);
      // emp may add documents to IT (EDIT) but not create folders or change grants there.
      await upload('emp', 'vpn.pdf', pdf('VPN'), meta('VPN guide', { folderId: child.id }));
      assert.equal((await api('emp', `/documents/folders/${child.id}/acl`)).status, 403);
      assert.equal((await api('emp', '/documents/uploads', { method: 'POST', body: { fileName: 'x.pdf', size: 10, ...meta('No', { folderId: parent.id }) } })).status, 403, 'VIEW on Policies is not EDIT');
      assert.equal((await api('hr', `/documents/folders/${child.id}`, { method: 'DELETE' })).status, 409, 'not empty');
      const docAcl = await ok(await api('hr', `/documents/${docs.itPolicy.id}/acl`), 200, AclListSchema);
      assert.ok(docAcl.items.some((g) => g.target === 'FOLDER' && g.folderName === 'Policies'), 'inherited grants are listed');
    });

    it('text cannot be previewed; only PDFs and images', async () => {
      const t = await upload('emp', 'readme.txt', Buffer.from('Read me first'), meta('Readme'));
      assert.equal(t.previewable, false);
      assert.equal(t.abilities.canPreview, false);
      assert.equal((await api('emp', `/documents/${t.id}/preview`)).status, 400);
      assert.equal((await api('emp', `/documents/${t.id}/download`)).headers.get('content-type'), 'text/plain; charset=utf-8');
    });
  });

  describe('Contracts (SRS 7.4)', { concurrency: false }, () => {
    it('HR records a contract and links its document both ways; the person sees their own', async () => {
      assert.equal((await api('emp', '/contracts', { method: 'POST', body: { userId: U.sub.id, title: 'x', startDate: today } })).status, 403);
      assert.equal((await api('hr', '/contracts', { method: 'POST', body: { userId: U.sub.id, title: 'Bad', startDate: today, endDate: addDaysIso(today, -1) } })).status, 400);
      const c = await ok(await api('hr', '/contracts', { method: 'POST', body: { userId: U.sub.id, title: 'Design services 2026', startDate: today, endDate: addDaysIso(today, 180), status: 'ACTIVE', documentId: docs.contract!.id } }), 201, ContractSchema);
      assert.equal(c.document?.id, docs.contract!.id);
      const d = await ok(await api('hr', `/documents/${docs.contract!.id}`), 200, DocumentDetailSchema);
      assert.equal(d.linkedContract?.title, 'Design services 2026');
      const mine = await ok(await api('sub', '/contracts'), 200, ContractListSchema);
      assert.deepEqual(mine.items.map((x) => x.id), [c.id]);
      assert.equal(mine.canManage, false);
      assert.equal((await ok(await api('emp', '/contracts'), 200, ContractListSchema)).items.length, 0);
      // A second contract cannot reuse the same document.
      assert.equal((await api('hr', '/contracts', { method: 'POST', body: { userId: U.sub.id, title: 'Dup', startDate: today, documentId: docs.contract!.id } })).status, 409);
      // Uploading a new contract document straight onto a contract links it too.
      const c2 = await ok(await api('hr', '/contracts', { method: 'POST', body: { userId: U.emp.id, title: 'Employment', startDate: today } }), 201, ContractSchema);
      const up = await upload('hr', 'employment.pdf', pdf('Employment'), meta('Employment contract', { category: 'CONTRACT', linkedContractId: c2.id }));
      assert.equal(up.linkedUser?.id, U.emp.id, 'the contract person is linked');
      const after = await ok(await api('hr', '/contracts'), 200, ContractListSchema);
      assert.equal(after.items.find((x) => x.id === c2.id)?.document?.id, up.id);
      assert.equal((await api('emp', '/documents/uploads', { method: 'POST', body: { fileName: 'c.pdf', size: 10, ...meta('C', { linkedContractId: c2.id }) } })).status, 403);
    });
  });

  describe('Access log (FR-DOC-012)', { concurrency: false }, () => {
    it('every view, download, upload, ACL change, restore and deletion is logged with who, IP and agent', async () => {
      const rows = await logs(docs.policy!.id);
      const actions = new Set(rows.map((r) => r.action));
      for (const a of ['UPLOAD', 'VIEW', 'DOWNLOAD', 'ACL_CHANGE', 'RESTORE', 'UPDATE']) assert.ok(actions.has(a), `${a} logged`);
      assert.ok(rows.every((r) => r.action === 'QUARANTINE' || (r.user_id && r.ip)));
      assert.ok(rows.some((r) => r.user_agent === 'docs-e2e/1.0'));
      await ok(await api('emp', `/documents/${docs.policy!.id}`, { method: 'DELETE' }), 200);
      assert.equal((await api('emp', `/documents/${docs.policy!.id}`)).status, 404);
      assert.equal((await logs(docs.policy!.id)).at(-1)?.action, 'DELETE');
    });

    it('the app role can only insert and read log rows', async () => {
      await assert.rejects(appPool.query(`UPDATE document_access_logs SET action = 'VIEW'`), /permission denied/);
      await assert.rejects(appPool.query(`DELETE FROM document_access_logs`), /permission denied/);
      await assert.rejects(appPool.query(`TRUNCATE document_access_logs`), /permission denied/);
    });

    it('per document for its managers; organisation-wide for audit readers, exportable as CSV', async () => {
      const own = await ok(await api('sub', `/documents/${docs.invoice!.id}/access-log`), 200, AccessLogListSchema);
      assert.ok(own.items.some((e) => e.action === 'UPLOAD'));
      assert.equal((await api('sub', `/documents/${docs.contract!.id}/access-log`)).status, 403, 'linked, not managing');
      assert.equal((await api('emp', '/documents/access-logs')).status, 403);
      const all = await ok(await api('aud', '/documents/access-logs?action=QUARANTINE'), 200, AccessLogListSchema);
      assert.ok(all.items.length >= 1 && all.items.every((e) => e.action === 'QUARANTINE'));
      const csv = await api('aud', '/documents/access-logs?format=csv');
      assert.match(csv.headers.get('content-type') ?? '', /^text\/csv/);
      assert.match(await csv.text(), /Time \(UTC\),Action,Document,Version,User,IP,User agent,Detail/);
    });
  });

  describe('Expiry reminders (FR-DOC-015) and housekeeping', { concurrency: false }, () => {
    it('60/30/7 days to the owner and HR, the tightest stage reached, once', async () => {
      const soon = await upload('sub', 'visa.pdf', pdf('Visa'), meta('Work visa', { category: 'IDENTITY', expiresAt: addDaysIso(today, 5) }));
      const later = await upload('sub', 'cert.pdf', pdf('Cert'), meta('Safety certificate', { category: 'CERTIFICATE', expiresAt: addDaysIso(today, 45) }));
      const work = app.get(DocumentMaintenanceService);
      await work.run(new Date());
      await work.run(new Date());
      const sub = await notes('sub', 'DOCUMENT_EXPIRING');
      const keysFor = (id: string) => sub.filter((n) => n.dedupe_key?.startsWith(`doc-expiry:${id}`)).map((n) => n.dedupe_key!.split(':').at(-1));
      assert.deepEqual(keysFor(soon.id), ['7'], 'only the 7-day reminder, even though 60 and 30 were never sent');
      assert.deepEqual(keysFor(later.id), ['60']);
      assert.match(sub.find((n) => n.dedupe_key?.startsWith(`doc-expiry:${soon.id}`))!.title, /Expires in 5 days: Work visa/);
      assert.ok((await notes('hr', 'DOCUMENT_EXPIRING')).some((n) => n.dedupe_key === `doc-expiry:${soon.id}:${addDaysIso(today, 5)}:7`));
      assert.equal((await notes('emp', 'DOCUMENT_EXPIRING')).filter((n) => n.dedupe_key?.includes(soon.id)).length, 0);
    });

    it('AC-16: a contract ending within its notice period alerts HR and the manager, once per stage', async () => {
      const soonId = (await adminPool.query(`INSERT INTO contracts (org_id, user_id, title, start_date, end_date, status, renewal_notice_days) VALUES ($1, $2, 'Sid 2026', '2026-01-01', $3, 'ACTIVE', 30) RETURNING id`, [ORG, U.sub.id, addDaysIso(today, 20)])).rows[0].id as string;
      await adminPool.query(`INSERT INTO contracts (org_id, user_id, title, start_date, end_date, status, renewal_notice_days) VALUES ($1, $2, 'Sid later', '2026-01-01', $3, 'ACTIVE', 30)`, [ORG, U.sub.id, addDaysIso(today, 50)]);
      const work = app.get(DocumentMaintenanceService);
      await work.run(new Date());
      await work.run(new Date());
      const lead = (await notes('lead', 'CONTRACT_EXPIRING')).filter((n) => n.dedupe_key?.startsWith(`contract-expiry:${soonId}`));
      assert.equal(lead.length, 1, 'the manager, once');
      assert.match(lead[0]!.title, /Contract ends in 20 days/);
      assert.equal((await notes('hr', 'CONTRACT_EXPIRING')).filter((n) => n.dedupe_key?.startsWith(`contract-expiry:${soonId}`)).length, 1, 'HR, once');
      assert.equal((await notes('sub', 'CONTRACT_EXPIRING')).length, 0, 'not the person themselves');
      assert.equal((await notes('hr', 'CONTRACT_EXPIRING')).filter((n) => n.title.includes('Sid later')).length, 0, 'outside the notice period: nothing yet');
      const emailed = await adminPool.query(`SELECT send_email, emailed_at FROM notifications WHERE user_id = $1 AND type = 'CONTRACT_EXPIRING'`, [U.lead.id]);
      assert.equal(emailed.rows[0]?.send_email, true, 'sent by email too');
    });

    it('abandoned uploads are aborted after 24 h', async () => {
      const ticket = await ok(await api('emp', '/documents/uploads', { method: 'POST', body: { fileName: 'never.pdf', size: 100, ...meta('Never finished') } }), 201, UploadTicketSchema);
      await adminPool.query(`UPDATE document_versions SET uploaded_at = now() - interval '25 hours' WHERE id = $1`, [ticket.versionId]);
      const r = await app.get(DocumentMaintenanceService).housekeeping(ORG, new Date());
      assert.ok(r.abandoned >= 1);
      const v = await adminPool.query(`SELECT scan_status, scan_detail FROM document_versions WHERE id = $1`, [ticket.versionId]);
      assert.deepEqual(v.rows[0], { scan_status: 'REJECTED', scan_detail: 'Upload abandoned' });
    });
  });

  describe('Row-Level Security', { concurrency: false }, () => {
    it('every document table is tenant-isolated', async () => {
      for (const table of ['documents', 'document_versions', 'document_acl', 'document_folders', 'document_access_logs', 'contracts']) {
        const none = await appPool.query(`SELECT count(*)::int AS n FROM ${table}`);
        assert.equal(none.rows[0].n, 0, `${table} without tenant context`);
        const client = await appPool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`SELECT set_config('app.org_id', $1, true)`, [OTHER_ORG]);
          assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, `${table} from another org`);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      }
      await assert.rejects(appPool.query(`DELETE FROM documents`), /permission denied/);
      await assert.rejects(appPool.query(`DELETE FROM document_versions`), /permission denied/);
    });
  });
});
