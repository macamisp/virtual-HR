/**
 * Field encryption for subcontractor profiles (FR-ORG-002; ADR 033), written before the code:
 * AES-256-GCM under a per-profile data key wrapped by the KeyProvider. A sealed value opens
 * only with the same key, organisation, person and field; any changed byte fails; the plaintext
 * never appears in the stored bytes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { LocalKeyProvider } from '../src/documents/crypto.ts';
import { openField, sealField, wrapProfileKey, unwrapProfileKey } from '../src/org/profile-crypto.ts';

const ORG = '6e6e0000-0000-4000-8000-000000000001';
const ALICE = '6e6e0000-0000-4000-8000-000000000011';
const BOB = '6e6e0000-0000-4000-8000-000000000012';
const TAX = 'LK-TIN-123456789';
const keys = new LocalKeyProvider({ dataKey: randomBytes(32).toString('base64'), recoveryKey: randomBytes(32).toString('base64') });
const ctx = (field: 'taxId' | 'bankDetails', userId = ALICE, orgId = ORG) => ({ orgId, userId, field });

describe('Subcontractor profile field encryption (FR-ORG-002)', () => {
  it('round-trips a value, with a fresh IV every time and no plaintext in the stored bytes', () => {
    const dek = randomBytes(32);
    const a = sealField(dek, TAX, ctx('taxId'));
    const b = sealField(dek, TAX, ctx('taxId'));
    assert.equal(openField(dek, a, ctx('taxId')), TAX);
    assert.notDeepEqual(a, b, 'random IV');
    for (const form of [Buffer.from(TAX), Buffer.from(TAX).toString('hex'), Buffer.from(TAX).toString('base64')]) {
      assert.equal(a.includes(typeof form === 'string' ? Buffer.from(form) : form), false, 'no plaintext, hex or base64 form');
    }
    assert.equal(a[0], 1, 'versioned format');
  });

  it('opens only for the same field, person and organisation', () => {
    const dek = randomBytes(32);
    const sealed = sealField(dek, TAX, ctx('taxId'));
    assert.throws(() => openField(dek, sealed, ctx('bankDetails')), 'a tax ID copied into the bank field does not open');
    assert.throws(() => openField(dek, sealed, ctx('taxId', BOB)), 'copied to another person');
    assert.throws(() => openField(dek, sealed, ctx('taxId', ALICE, '6e6e0000-0000-4000-8000-000000000002')), 'copied to another tenant');
    assert.throws(() => openField(randomBytes(32), sealed, ctx('taxId')), 'another key');
  });

  it('rejects any changed byte and unknown versions', () => {
    const dek = randomBytes(32);
    const sealed = sealField(dek, TAX, ctx('taxId'));
    for (const i of [1, 13, 29, sealed.length - 1]) {
      const bad = Buffer.from(sealed);
      bad[i] = bad[i]! ^ 0x01;
      assert.throws(() => openField(dek, bad, ctx('taxId')), `byte ${i}`);
    }
    const v2 = Buffer.from(sealed);
    v2[0] = 2;
    assert.throws(() => openField(dek, v2, ctx('taxId')), /Unsupported/);
    assert.throws(() => openField(dek, sealed.subarray(0, 20), ctx('taxId')), /Unsupported/);
  });

  it('wraps the data key for one person only (KeyProvider context)', async () => {
    const { dek, wrapped, keyId } = await wrapProfileKey(keys, ORG, ALICE);
    assert.equal(dek.length, 32);
    assert.equal(wrapped.includes(dek), false, 'the stored key is wrapped');
    assert.deepEqual(await unwrapProfileKey(keys, ORG, ALICE, wrapped, keyId), dek);
    await assert.rejects(unwrapProfileKey(keys, ORG, BOB, wrapped, keyId), 'another person\'s profile cannot use it');
  });
});
