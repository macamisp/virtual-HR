/**
 * Field encryption for subcontractor profiles (FR-ORG-002; ADR 033). Each profile has its own
 * 256-bit data key, wrapped by the KeyProvider (local key in development, AWS KMS in staging and
 * production) with the context {org_id, document_id = user id, purpose = profile}. Tax ID and
 * bank details are sealed with AES-256-GCM under that key; the organisation, person and field
 * are authenticated data, so a value copied to another field, person or tenant does not open.
 * Plaintext exists only in memory for one request and is never logged.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { generateDek } from '../documents/crypto.ts';
import type { KeyContext, KeyProvider } from '../documents/crypto.ts';

export type SensitiveField = 'taxId' | 'bankDetails';
export interface FieldContext { orgId: string; userId: string; field: SensitiveField }

const VERSION = 1;
// Layout: version(1) | iv(12) | tag(16) | ciphertext
const HEADER = 1 + 12 + 16;
const aad = (c: FieldContext) => Buffer.from(JSON.stringify({ org_id: c.orgId, user_id: c.userId, field: c.field }));
const keyContext = (orgId: string, userId: string): KeyContext => ({ orgId, documentId: userId, purpose: 'profile' });

export function sealField(dek: Buffer, plain: string, ctx: FieldContext): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dek, iv);
  c.setAAD(aad(ctx));
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), body]);
}

export function openField(dek: Buffer, sealed: Buffer, ctx: FieldContext): string {
  if (sealed.length < HEADER || sealed[0] !== VERSION) throw new Error('Unsupported sealed field format');
  const d = createDecipheriv('aes-256-gcm', dek, sealed.subarray(1, 13));
  d.setAAD(aad(ctx));
  d.setAuthTag(sealed.subarray(13, HEADER));
  return Buffer.concat([d.update(sealed.subarray(HEADER)), d.final()]).toString('utf8');
}

/** A new data key for one person's profile, and its wrapped form to store. */
export async function wrapProfileKey(keys: KeyProvider, orgId: string, userId: string): Promise<{ dek: Buffer; wrapped: Buffer; keyId: string }> {
  const dek = generateDek();
  const { wrapped, keyId } = await keys.wrap(dek, keyContext(orgId, userId));
  return { dek, wrapped, keyId };
}

export function unwrapProfileKey(keys: KeyProvider, orgId: string, userId: string, wrapped: Buffer, keyId: string): Promise<Buffer> {
  return keys.unwrap(wrapped, keyId, keyContext(orgId, userId));
}
