/**
 * AWS KMS key provider (SRS 10.1 steps 2 and 5; ADR 021), written before the implementation.
 * Runs against a moto KMS server (KMS_TEST_ENDPOINT, default http://127.0.0.1:4566), which enforces
 * the encryption context and key ids like AWS KMS.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { KMSClient, CreateKeyCommand } from '@aws-sdk/client-kms';
import { LocalKeyProvider, keyProviderFromEnv } from '../src/documents/crypto.ts';
import { KmsKeyProvider, CompositeKeyProvider } from '../src/documents/kms-key-provider.ts';

const endpoint = process.env.KMS_TEST_ENDPOINT || 'http://127.0.0.1:4566';
const creds = { accessKeyId: 'test', secretAccessKey: 'test' }; // moto accepts any; never real credentials
const kms = new KMSClient({ region: 'ap-southeast-1', endpoint, credentials: creds });
const ctx = { orgId: 'org-1', documentId: 'doc-1' };
const LOCAL = { dataKey: randomBytes(32).toString('base64'), recoveryKey: randomBytes(32).toString('base64') };

describe('KmsKeyProvider', () => {
  let dataKeyId = '';
  let recoveryKeyId = '';
  let provider: KmsKeyProvider;

  before(async () => {
    dataKeyId = (await kms.send(new CreateKeyCommand({ Description: 'test data' }))).KeyMetadata!.Arn!;
    recoveryKeyId = (await kms.send(new CreateKeyCommand({ Description: 'test recovery' }))).KeyMetadata!.Arn!;
    provider = new KmsKeyProvider({ client: kms, dataKeyId, recoveryKeyId });
  });

  it('wraps a data key under the data key and unwraps it with the same context', async () => {
    const dek = randomBytes(32);
    const w = await provider.wrap(dek, ctx);
    assert.equal(w.keyId, dataKeyId);
    assert.ok(!w.wrapped.includes(dek), 'the wrapped form does not contain the key');
    assert.ok((await provider.unwrap(w.wrapped, w.keyId, ctx)).equals(dek));
  });

  it('a wrapped key does not open for another organisation, document or purpose', async () => {
    const w = await provider.wrap(randomBytes(32), ctx);
    await assert.rejects(provider.unwrap(w.wrapped, w.keyId, { ...ctx, orgId: 'org-2' }));
    await assert.rejects(provider.unwrap(w.wrapped, w.keyId, { ...ctx, documentId: 'doc-2' }));
    await assert.rejects(provider.unwrap(w.wrapped, w.keyId, { ...ctx, purpose: 'metadata' }));
  });

  it('recovery escrow uses the separate recovery key; the two are not interchangeable', async () => {
    const dek = randomBytes(32);
    const r = await provider.wrap(dek, { ...ctx, purpose: 'recovery' });
    assert.equal(r.keyId, recoveryKeyId);
    assert.ok((await provider.unwrap(r.wrapped, r.keyId, { ...ctx, purpose: 'recovery' })).equals(dek));
    const d = await provider.wrap(dek, ctx);
    // KMS itself refuses a blob presented with the other key (AWS: IncorrectKeyException).
    await assert.rejects(provider.unwrap(d.wrapped, recoveryKeyId, { ...ctx, purpose: 'recovery' }));
    await assert.rejects(provider.unwrap(r.wrapped, dataKeyId, ctx));
    // And the provider refuses a purpose that does not match the key before asking KMS.
    await assert.rejects(provider.unwrap(r.wrapped, recoveryKeyId, ctx), /purpose/);
  });

  it('refuses key ids it was not configured with, without calling KMS', async () => {
    const w = await provider.wrap(randomBytes(32), ctx);
    await assert.rejects(provider.unwrap(w.wrapped, 'arn:aws:kms:ap-southeast-1:000000000000:key/other', ctx), /Unknown key/);
  });
});

describe('CompositeKeyProvider (migration from the local provider)', () => {
  it('new wraps go to KMS; keys wrapped locally before still open', async () => {
    const dataKeyId = (await kms.send(new CreateKeyCommand({}))).KeyMetadata!.Arn!;
    const recoveryKeyId = (await kms.send(new CreateKeyCommand({}))).KeyMetadata!.Arn!;
    const local = new LocalKeyProvider(LOCAL);
    const composite = new CompositeKeyProvider(new KmsKeyProvider({ client: kms, dataKeyId, recoveryKeyId }), local);
    const dek = randomBytes(32);
    const old = await local.wrap(dek, ctx);
    assert.ok((await composite.unwrap(old.wrapped, old.keyId, ctx)).equals(dek));
    const fresh = await composite.wrap(dek, ctx);
    assert.equal(fresh.keyId, dataKeyId);
    assert.ok(composite.isLegacy(old.keyId));
    assert.ok(!composite.isLegacy(fresh.keyId));
  });
});

describe('keyProviderFromEnv', () => {
  const awsEnv = { DOCUMENT_KMS_PROVIDER: 'aws', DOCUMENT_KMS_KEY_ID: 'arn:aws:kms:ap-southeast-1:111111111111:key/a', DOCUMENT_KMS_RECOVERY_KEY_ID: 'arn:aws:kms:ap-southeast-1:111111111111:key/b', AWS_REGION: 'ap-southeast-1' };
  it('production uses AWS KMS; the local provider stays refused there', () => {
    assert.ok(keyProviderFromEnv({ ...awsEnv, NODE_ENV: 'production' }) instanceof KmsKeyProvider);
    assert.throws(() => keyProviderFromEnv({ NODE_ENV: 'production', DOCUMENT_KMS_LOCAL_KEY: LOCAL.dataKey, DOCUMENT_KMS_RECOVERY_KEY: LOCAL.recoveryKey }), /production/);
  });
  it('production never talks to a custom KMS endpoint or keeps the local fallback', () => {
    assert.throws(() => keyProviderFromEnv({ ...awsEnv, NODE_ENV: 'production', DOCUMENT_KMS_ENDPOINT: 'http://localhost:4566' }), /ENDPOINT/);
    assert.throws(() => keyProviderFromEnv({ ...awsEnv, NODE_ENV: 'production', DOCUMENT_KMS_LOCAL_KEY: LOCAL.dataKey, DOCUMENT_KMS_RECOVERY_KEY: LOCAL.recoveryKey }), /local/i);
  });
  it('outside production, local keys next to AWS give the migration provider', () => {
    assert.ok(keyProviderFromEnv({ ...awsEnv, DOCUMENT_KMS_ENDPOINT: endpoint, DOCUMENT_KMS_LOCAL_KEY: LOCAL.dataKey, DOCUMENT_KMS_RECOVERY_KEY: LOCAL.recoveryKey }) instanceof CompositeKeyProvider);
  });
  it('AWS needs both key ids, and they must differ', () => {
    assert.throws(() => keyProviderFromEnv({ ...awsEnv, DOCUMENT_KMS_RECOVERY_KEY_ID: '' }), /RECOVERY/);
    assert.throws(() => keyProviderFromEnv({ ...awsEnv, DOCUMENT_KMS_RECOVERY_KEY_ID: awsEnv.DOCUMENT_KMS_KEY_ID }), /different/);
  });
});
