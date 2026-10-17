/**
 * Re-wrapping document keys from the local provider to AWS KMS (ADR 021), written before the
 * implementation. Every wrapped key (data, password, recovery escrow, metadata) of a version moves
 * in one transaction; the data keys themselves never change, so content needs no re-encryption.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { KMSClient, CreateKeyCommand } from '@aws-sdk/client-kms';
import { LocalKeyProvider } from '../src/documents/crypto.ts';
import { CompositeKeyProvider, KmsKeyProvider } from '../src/documents/kms-key-provider.ts';
import { rewrapDocumentKeys } from '../src/documents/rewrap-keys.ts';
import { PrismaService } from '../src/common/prisma.service.ts';

const ORG = 'a9a90000-0000-4000-8000-000000000001';
const USER = 'a9a90000-0000-4000-8000-000000000011';
const kms = new KMSClient({ region: 'ap-southeast-1', endpoint: process.env.KMS_TEST_ENDPOINT || 'http://127.0.0.1:4566', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });

describe('rewrapDocumentKeys (local -> KMS)', { concurrency: false }, () => {
  let admin: pg.Pool;
  let prisma: PrismaService;
  let local: LocalKeyProvider;
  let composite: CompositeKeyProvider;
  let kmsProvider: KmsKeyProvider;
  const doc = randomUUID();
  const ver = randomUUID();
  const dek = randomBytes(32);
  const sealed = randomBytes(60); // the password-sealed DEK (opaque here)
  const metaKey = randomBytes(32);

  before(async () => {
    admin = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await admin.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await admin.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Rewrap Ltd', 'rewrap-test')`, [ORG]);
    await admin.query(`INSERT INTO users (id, org_id, email, role, password_hash, status) VALUES ($1, $2, 'r@rewrap.test', 'HR', 'x', 'ACTIVE')`, [USER, ORG]);
    local = new LocalKeyProvider({ dataKey: process.env.DOCUMENT_KMS_LOCAL_KEY!, recoveryKey: process.env.DOCUMENT_KMS_RECOVERY_KEY! });
    const dataKeyId = (await kms.send(new CreateKeyCommand({}))).KeyMetadata!.Arn!;
    const recoveryKeyId = (await kms.send(new CreateKeyCommand({}))).KeyMetadata!.Arn!;
    kmsProvider = new KmsKeyProvider({ client: kms, dataKeyId, recoveryKeyId });
    composite = new CompositeKeyProvider(kmsProvider, local);
    const ctx = { orgId: ORG, documentId: doc };
    const meta = await local.wrap(metaKey, { ...ctx, purpose: 'metadata' });
    const data = await local.wrap(dek, ctx);
    const pw = await local.wrap(sealed, { ...ctx, purpose: 'password' });
    const rec = await local.wrap(dek, { ...ctx, purpose: 'recovery' });
    await admin.query(`INSERT INTO documents (id, org_id, title_enc, meta_key_wrapped, meta_key_id, category, confidentiality, owner_id) VALUES ($1, $2, $3, $4, $5, 'CONTRACT', 'CONFIDENTIAL', $6)`,
      [doc, ORG, Buffer.from('x'), meta.wrapped, meta.keyId, USER]);
    await admin.query(`INSERT INTO document_versions (id, org_id, document_id, version_no, declared_size, size_bytes, mime_type, kms_key_id, dek_wrapped_kms, dek_wrapped_pw, dek_wrapped_recovery, recovery_key_id, uploaded_by, scan_status, storage_key, iv, auth_tag, sha256)
      VALUES ($1, $2, $3, 1, 10, 10, 'application/pdf', $4, $5, $6, $7, $8, $9, 'CLEAN', 'k', decode('00','hex'), decode('00','hex'), repeat('0', 64))`,
      [ver, ORG, doc, data.keyId, data.wrapped, pw.wrapped, rec.wrapped, rec.keyId, USER]);
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });

  after(async () => {
    await prisma?.onModuleDestroy();
    await admin.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await admin.end();
  });

  it('moves every wrapped key of the version and the document to KMS; the keys inside are unchanged', async () => {
    const r = await rewrapDocumentKeys(prisma, composite, { orgIds: [ORG] });
    assert.deepEqual(r, { versions: 1, documents: 1, failed: 0 });
    const v = (await admin.query(`SELECT * FROM document_versions WHERE id = $1`, [ver])).rows[0];
    const d = (await admin.query(`SELECT meta_key_wrapped, meta_key_id FROM documents WHERE id = $1`, [doc])).rows[0];
    assert.equal(v.kms_key_id, kmsProvider.dataKeyId);
    assert.equal(v.recovery_key_id, kmsProvider.recoveryKeyId);
    assert.equal(d.meta_key_id, kmsProvider.dataKeyId);
    const ctx = { orgId: ORG, documentId: doc };
    assert.ok((await kmsProvider.unwrap(v.dek_wrapped_kms, v.kms_key_id, ctx)).equals(dek));
    assert.ok((await kmsProvider.unwrap(v.dek_wrapped_pw, v.kms_key_id, { ...ctx, purpose: 'password' })).equals(sealed));
    assert.ok((await kmsProvider.unwrap(v.dek_wrapped_recovery, v.recovery_key_id, { ...ctx, purpose: 'recovery' })).equals(dek));
    assert.ok((await kmsProvider.unwrap(d.meta_key_wrapped, d.meta_key_id, { ...ctx, purpose: 'metadata' })).equals(metaKey));
    const audit = (await admin.query(`SELECT 1 FROM audit_logs WHERE org_id = $1 AND action = 'DOCUMENT_KEYS_REWRAPPED'`, [ORG])).rowCount;
    assert.equal(audit, 1);
  });

  it('is idempotent: a second run finds nothing to move', async () => {
    assert.deepEqual(await rewrapDocumentKeys(prisma, composite, { orgIds: [ORG] }), { versions: 0, documents: 0, failed: 0 });
  });
});
