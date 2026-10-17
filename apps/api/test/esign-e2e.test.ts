/**
 * E-signature E2E (FR-DOC-014, ADR 022) against real S3-compatible storage and clamd: request,
 * re-authenticated draw/type signing, consent version, the signed copy with its audit certificate
 * stored as a new scanned and encrypted version, hash verification, decline, cancel, a changed
 * document refusing signatures, permissions and RLS.
 *
 * Needs S3_ENDPOINT (+ keys) and CLAMAV_HOST/PORT; skipped otherwise.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { PDFDocument } from 'pdf-lib';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { DocumentDetailSchema, UploadTicketSchema } from '../../../packages/shared/src/documents/types.ts';
import type { DocumentDetail } from '../../../packages/shared/src/documents/types.ts';
import { ESIGN_CONSENT, SignatureRequestListSchema, SignatureRequestSchema, SignatureVerificationSchema } from '../../../packages/shared/src/documents/esign.ts';
import type { SignatureRequest } from '../../../packages/shared/src/documents/esign.ts';

const ORG = 'e5e50000-0000-4000-8000-000000000001';
const OTHER_ORG = 'e5e50000-0000-4000-8000-000000000002';
const TEAM = 'e5e50000-0000-4000-8000-000000000101';
const TEAM2 = 'e5e50000-0000-4000-8000-000000000102';
const PASSWORD = 'ComplexPassword123!';
const U = {
  owner: { id: 'e5e50000-0000-4000-8000-000000000011', role: 'EMPLOYEE', team: TEAM },
  lead: { id: 'e5e50000-0000-4000-8000-000000000012', role: 'TEAM_LEAD', team: TEAM },
  signer: { id: 'e5e50000-0000-4000-8000-000000000013', role: 'EMPLOYEE', team: TEAM2 },
  outsider: { id: 'e5e50000-0000-4000-8000-000000000014', role: 'EMPLOYEE', team: TEAM2 },
} as const;
type Who = keyof typeof U;
const email = (w: Who) => `${w}@esign.test`;

const pdf = (text: string) => Buffer.from(
  `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n` +
    `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj\n% ${text}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
);
/** A real RGBA PNG with a diagonal stroke. */
function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const x = Math.floor((y / h) * w);
    raw[y * (w * 4 + 1) + 1 + x * 4 + 3] = 255;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const enabled = !!process.env.S3_ENDPOINT && !!process.env.CLAMAV_HOST;

describe('E-signature (FR-DOC-014)', { concurrency: false, skip: enabled ? false : 'S3_ENDPOINT and CLAMAV_HOST are not set' }, () => {
  let app: INestApplication;
  let base: string;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  const tokens = {} as Record<Who, string>;
  let doc: DocumentDetail;
  const original = pdf('Employment contract for signing');
  let req: SignatureRequest;

  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}`, 'User-Agent': 'esign-e2e/1.0' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  async function ok<T>(res: Response, status: number, schema?: { parse: (v: unknown) => T }): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return schema ? schema.parse(JSON.parse(text)) : (JSON.parse(text || 'null') as T);
  }
  async function upload(who: Who, fileName: string, data: Buffer, target: Record<string, unknown>): Promise<DocumentDetail> {
    const ticket = await ok(await api(who, '/documents/uploads', { method: 'POST', body: { fileName, size: data.length, ...target } }), 201, UploadTicketSchema);
    const parts = [];
    for (const p of ticket.parts) {
      const put = await fetch(p.url, { method: 'PUT', body: new Uint8Array(data.subarray((p.partNumber - 1) * ticket.partSize, p.partNumber * ticket.partSize)) });
      assert.equal(put.status, 200);
      parts.push({ partNumber: p.partNumber, etag: put.headers.get('etag')! });
    }
    return await ok(await api(who, `/documents/uploads/${ticket.versionId}/complete`, { method: 'POST', body: { parts } }), 200, DocumentDetailSchema);
  }
  const meta = (title: string) => ({ metadata: { title, category: 'CONTRACT' } });
  const reauth = async (who: Who) => ok(await api(who, '/vault/reauth', { method: 'POST', body: { password: PASSWORD } }), 200);
  const drawn = { method: 'DRAW', imagePng: `data:image/png;base64,${png(300, 100).toString('base64')}`, consentVersion: ESIGN_CONSENT.version, consent: true };
  const typed = (name: string) => ({ method: 'TYPE', typedName: name, consentVersion: ESIGN_CONSENT.version, consent: true });
  const notes = async (who: Who, type: string) => (await adminPool.query(`SELECT title FROM notifications WHERE user_id = $1 AND type = $2`, [U[who].id, type])).rows;

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.S3_CREATE_BUCKET = 'true';
    const pgBase = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev' };
    adminPool = new pg.Pool({ ...pgBase, user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    appPool = new pg.Pool({ ...pgBase, user: process.env.PGUSER || 'hrvo_app', password: process.env.PGPASSWORD || 'hrvo_app_pass' });
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER_ORG]]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Sign Ltd', 'esign-e2e', 'Asia/Colombo'), ($2, 'Other', 'esign-e2e-other', 'UTC')`, [ORG, OTHER_ORG]);
    await adminPool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $3, 'Alpha'), ($2, $3, 'Beta')`, [TEAM, TEAM2, ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const [k, u] of Object.entries(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, team_id, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`,
        [u.id, ORG, email(k as Who), `${k[0]!.toUpperCase()}${k.slice(1)} Person`, u.role, u.team, hash]);
    }
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(3092);
    base = 'http://localhost:3092';
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email(who), password: PASSWORD }) });
      const body = (await res.json()) as { accessToken?: string };
      assert.ok(body.accessToken, `login ${who}`);
      tokens[who] = body.accessToken;
    }
    doc = await upload('owner', 'contract.pdf', original, meta('Employment contract'));
    assert.equal(doc.versions[0]!.scanStatus, 'CLEAN');
  });

  after(async () => {
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER_ORG]]);
    await adminPool.end();
    await appPool.end();
  });

  it('only a document manager can request signatures, and only on a PDF', async () => {
    assert.equal((await api('outsider', `/documents/${doc.id}/signature-requests`, { method: 'POST', body: { signerIds: [U.outsider.id] } })).status, 404);
    const image = await upload('owner', 'photo.png', png(40, 20), meta('Photo'));
    assert.equal((await api('owner', `/documents/${image.id}/signature-requests`, { method: 'POST', body: { signerIds: [U.signer.id] } })).status, 400);
    assert.equal((await api('owner', `/documents/${doc.id}/signature-requests`, { method: 'POST', body: { signerIds: [] } })).status, 400);
    assert.equal((await api('owner', `/documents/${doc.id}/signature-requests`, { method: 'POST', body: { signerIds: ['e5e50000-0000-4000-8000-000000000099'] } })).status, 404);
  });

  it('a request fingerprints the current version, lets signers read it and notifies them', async () => {
    assert.equal((await api('signer', `/documents/${doc.id}`)).status, 404, 'no access before the request');
    req = await ok(await api('owner', `/documents/${doc.id}/signature-requests`, { method: 'POST', body: { signerIds: [U.signer.id, U.lead.id, U.signer.id], message: 'Please sign by Friday' } }), 201, SignatureRequestSchema);
    assert.equal(req.status, 'OPEN');
    assert.equal(req.sourceSha256, sha(original));
    assert.deepEqual(req.signers.map((s) => s.id), [U.signer.id, U.lead.id], 'duplicates are dropped, order kept');
    assert.equal(req.canCancel, true);
    assert.equal((await api('signer', `/documents/${doc.id}`)).status, 200, 'signers get VIEW');
    assert.equal((await notes('signer', 'SIGNATURE_REQUESTED')).length, 1);
    assert.equal((await api('owner', `/documents/${doc.id}/signature-requests`, { method: 'POST', body: { signerIds: [U.lead.id] } })).status, 409, 'one open request per document');
    const mine = await ok(await api('signer', '/signature-requests?scope=to-sign'), 200, SignatureRequestListSchema);
    assert.equal(mine.items.length, 1);
    assert.equal(mine.items[0]!.canSign, true);
    assert.equal(mine.items[0]!.documentTitle, 'Employment contract');
    assert.equal((await ok(await api('owner', '/signature-requests?scope=sent'), 200, SignatureRequestListSchema)).items.length, 1);
    assert.equal((await api('outsider', `/signature-requests/${req.id}`)).status, 404, 'not a party');
    assert.equal((await ok(await api('outsider', '/signature-requests?scope=to-sign'), 200, SignatureRequestListSchema)).items.length, 0);
  });

  it('signing needs a fresh re-authentication, the current consent and a real PNG', async () => {
    const no = await api('signer', `/signature-requests/${req.id}/sign`, { method: 'POST', body: drawn });
    assert.equal(no.status, 403);
    assert.equal(((await no.json()) as { code?: string }).code, 'REAUTH_REQUIRED');
    await reauth('signer');
    assert.equal((await api('signer', `/signature-requests/${req.id}/sign`, { method: 'POST', body: { ...drawn, consentVersion: 'v0.9' } })).status, 409);
    assert.equal((await api('signer', `/signature-requests/${req.id}/sign`, { method: 'POST', body: { ...drawn, consent: false } })).status, 400);
    assert.equal((await api('signer', `/signature-requests/${req.id}/sign`, { method: 'POST', body: { ...drawn, imagePng: `data:image/png;base64,${Buffer.from('not a png at all, just text').toString('base64')}` } })).status, 400);
    assert.equal((await api('signer', `/signature-requests/${req.id}/sign`, { method: 'POST', body: { ...drawn, imagePng: `data:image/png;base64,${png(1, 1).toString('base64')}` } })).status, 400, 'a 1x1 image is not a signature');
    assert.equal((await api('outsider', `/signature-requests/${req.id}/sign`, { method: 'POST', body: typed('Outsider') })).status, 404);
  });

  it('a drawn signature is stored sealed with its evidence; it cannot be given twice', async () => {
    const r = await ok(await api('signer', `/signature-requests/${req.id}/sign`, { method: 'POST', body: drawn }), 200, SignatureRequestSchema);
    assert.equal(r.status, 'OPEN');
    assert.equal(r.signers[0]!.status, 'SIGNED');
    assert.equal(r.canSign, false);
    const row = (await adminPool.query(`SELECT * FROM signature_signers WHERE request_id = $1 AND user_id = $2`, [req.id, U.signer.id])).rows[0];
    assert.equal(row.method, 'DRAW');
    assert.ok(row.reauth_at && row.signed_at && row.ip);
    assert.equal(row.user_agent, 'esign-e2e/1.0');
    assert.ok(!row.image_sealed.includes(Buffer.from('IHDR')), 'the image is stored encrypted');
    assert.ok(Math.abs(new Date(row.signed_at).getTime() - Date.now()) < 60_000, 'server clock');
    assert.equal((await api('signer', `/signature-requests/${req.id}/sign`, { method: 'POST', body: drawn })).status, 409);
    await assert.rejects(adminPool.query(`UPDATE signature_signers SET typed_name = 'forged' WHERE request_id = $1 AND user_id = $2`, [req.id, U.signer.id]), /cannot be changed/);
    const log = await adminPool.query(`SELECT action FROM document_access_logs WHERE document_id = $1 AND action = 'SIGN'`, [doc.id]);
    assert.equal(log.rowCount, 1);
  });

  it('the last signature produces the signed copy with a certificate as a new, scanned, current version', async () => {
    await reauth('lead');
    const r = await ok(await api('lead', `/signature-requests/${req.id}/sign`, { method: 'POST', body: typed('Lead Person') }), 200, SignatureRequestSchema);
    assert.equal(r.status, 'COMPLETED');
    assert.ok(r.signedVersionId && r.signedSha256 && r.completedAt);
    const d = await ok(await api('owner', `/documents/${doc.id}`), 200, DocumentDetailSchema);
    assert.equal(d.versions.find((v) => v.isCurrent)?.id, r.signedVersionId, 'the signed copy is current');
    assert.equal(d.versions.find((v) => v.id === r.signedVersionId)!.scanStatus, 'CLEAN');
    assert.match(d.versions.find((v) => v.id === r.signedVersionId)!.fileName ?? '', /\(signed\)\.pdf$/);
    await reauth('owner');
    const res = await api('owner', `/documents/${doc.id}/download`);
    assert.equal(res.status, 200, await res.clone().text());
    const signed = Buffer.from(await res.arrayBuffer());
    assert.equal(sha(signed), r.signedSha256, 'the stored fingerprint matches the file');
    const parsed = await PDFDocument.load(signed);
    assert.equal(parsed.getPageCount(), 3, 'original page + signature page + certificate');
    assert.match(parsed.getKeywords() ?? '', new RegExp(`hrvo-esign-source-sha256:${r.sourceSha256}`), 'the signed file names the original fingerprint');
    const v = await ok(await api('signer', `/signature-requests/${req.id}/verify`), 200, SignatureVerificationSchema);
    assert.equal(v.sourceIntact, true);
    assert.equal(v.signedIntact, true);
    assert.deepEqual(v.events.map((e) => e.what.split(' ')[0]), ['Requested', 'Signed', 'Signed', 'Signed']);
    assert.equal((await notes('owner', 'SIGNATURE_COMPLETED')).length, 1);
    assert.equal((await notes('lead', 'SIGNATURE_COMPLETED')).length, 1);
    const audit = (await adminPool.query(`SELECT action FROM audit_logs WHERE org_id = $1 AND entity_id = $2 ORDER BY created_at`, [ORG, req.id])).rows.map((x) => x.action);
    assert.deepEqual(audit, ['SIGNATURE_REQUESTED', 'DOCUMENT_SIGNED', 'DOCUMENT_SIGNED', 'SIGNATURE_COMPLETED']);
    assert.equal((await api('owner', `/signature-requests/${req.id}/cancel`, { method: 'POST' })).status, 409);
  });

  it('a document changed after the request cannot be signed', async () => {
    const r2 = await ok(await api('owner', `/documents/${doc.id}/signature-requests`, { method: 'POST', body: { signerIds: [U.signer.id] } }), 201, SignatureRequestSchema);
    await upload('owner', 'contract-v3.pdf', pdf('Edited after the request'), { documentId: doc.id });
    await reauth('signer');
    assert.equal((await api('signer', `/signature-requests/${r2.id}/sign`, { method: 'POST', body: typed('Signer Person') })).status, 409);
    assert.equal((await api('signer', `/signature-requests/${r2.id}/cancel`, { method: 'POST' })).status, 403, 'a signer cannot cancel');
    const c = await ok(await api('owner', `/signature-requests/${r2.id}/cancel`, { method: 'POST' }), 200, SignatureRequestSchema);
    assert.equal(c.status, 'CANCELLED');
  });

  it('a signer can decline with a reason; the requester is told', async () => {
    const r3 = await ok(await api('owner', `/documents/${doc.id}/signature-requests`, { method: 'POST', body: { signerIds: [U.signer.id, U.lead.id] } }), 201, SignatureRequestSchema);
    assert.equal((await api('signer', `/signature-requests/${r3.id}/decline`, { method: 'POST', body: { reason: '' } })).status, 400);
    const d = await ok(await api('signer', `/signature-requests/${r3.id}/decline`, { method: 'POST', body: { reason: 'Clause 4 is wrong' } }), 200, SignatureRequestSchema);
    assert.equal(d.status, 'DECLINED');
    assert.equal(d.signers[0]!.declineReason, 'Clause 4 is wrong');
    assert.equal((await notes('owner', 'SIGNATURE_DECLINED')).length, 1);
    await reauth('lead');
    assert.equal((await api('lead', `/signature-requests/${r3.id}/sign`, { method: 'POST', body: typed('Lead Person') })).status, 409);
  });

  it('RLS: another organisation sees nothing; the app role cannot delete evidence', async () => {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [OTHER_ORG]);
      assert.equal((await c.query(`SELECT 1 FROM signature_requests WHERE org_id = $1`, [ORG])).rowCount, 0);
      assert.equal((await c.query(`SELECT 1 FROM signature_signers WHERE org_id = $1`, [ORG])).rowCount, 0);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
      assert.ok((await c.query(`SELECT 1 FROM signature_requests`)).rowCount! >= 3);
      await assert.rejects(c.query(`DELETE FROM signature_requests`), /permission denied/);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [OTHER_ORG]);
      await assert.rejects(c.query(`INSERT INTO signature_requests (org_id, document_id, source_version_id, source_sha256, requested_by, message, key_wrapped, key_id) VALUES ($1, $2, $3, repeat('a', 64), $4, '', '\\x00', 'k')`,
        [ORG, doc.id, doc.versions[0]!.id, U.owner.id]), /row-level security/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });
});
