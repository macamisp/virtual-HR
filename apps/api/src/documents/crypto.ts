/**
 * FR-DOC-007 envelope encryption (SRS 10.1 steps 1-2). Every file version gets its own random
 * 256-bit data key (DEK) and 96-bit IV; content is encrypted with AES-256-GCM. The DEK is
 * wrapped by a KMS key with the encryption context {org_id, document_id}, so a wrapped key
 * copied to another document or tenant cannot be unwrapped. Plaintext DEKs live only in
 * memory for the duration of one operation.
 *
 * KmsProvider has one implementation today: LocalKms (a 32-byte key from .env, dev/test).
 * AWS KMS (GenerateDataKey/Decrypt with EncryptionContext) plugs in behind the same interface.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Transform } from 'node:stream';

export interface KmsContext {
  orgId: string;
  documentId: string;
}

export interface WrappedKey {
  wrapped: Buffer;
  keyId: string;
}

export interface KmsProvider {
  wrap(dek: Buffer, context: KmsContext): Promise<WrappedKey>;
  unwrap(wrapped: Buffer, keyId: string, context: KmsContext): Promise<Buffer>;
}

export const KMS_PROVIDER = Symbol('KMS_PROVIDER');

export function generateDek(): Buffer {
  return randomBytes(32);
}

function aad(context: KmsContext): Buffer {
  // Canonical encoding: fixed key order, no whitespace.
  return Buffer.from(JSON.stringify({ org_id: context.orgId, document_id: context.documentId }));
}

/** Development / test KMS: AES-256-GCM key wrap with the context as additional data. */
export class LocalKms implements KmsProvider {
  private readonly key: Buffer;
  readonly keyId: string;

  constructor(base64Key: string, keyId: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) throw new Error('DOCUMENT_KMS_LOCAL_KEY must be 32 bytes, base64-encoded');
    this.key = key;
    this.keyId = keyId;
  }

  async wrap(dek: Buffer, context: KmsContext): Promise<WrappedKey> {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(aad(context));
    const body = Buffer.concat([c.update(dek), c.final()]);
    // Layout: version(1) | iv(12) | tag(16) | ciphertext
    return { wrapped: Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body]), keyId: this.keyId };
  }

  async unwrap(wrapped: Buffer, keyId: string, context: KmsContext): Promise<Buffer> {
    if (keyId !== this.keyId) throw new Error(`Unknown KMS key "${keyId}"`);
    if (wrapped.length < 29 || wrapped[0] !== 1) throw new Error('Unsupported wrapped key format');
    const d = createDecipheriv('aes-256-gcm', this.key, wrapped.subarray(1, 13));
    d.setAAD(aad(context));
    d.setAuthTag(wrapped.subarray(13, 29));
    return Buffer.concat([d.update(wrapped.subarray(29)), d.final()]);
  }
}

export function kmsFromEnv(env: Record<string, string | undefined> = process.env): KmsProvider {
  const provider = env.DOCUMENT_KMS_PROVIDER ?? 'local';
  if (provider !== 'local') throw new Error(`Unsupported DOCUMENT_KMS_PROVIDER "${provider}" (only "local" is implemented)`);
  if (env.NODE_ENV === 'production') {
    throw new Error('The local KMS must not be used in production: configure a managed KMS');
  }
  const key = env.DOCUMENT_KMS_LOCAL_KEY;
  if (!key) throw new Error('DOCUMENT_KMS_LOCAL_KEY is required (32 random bytes, base64)');
  return new LocalKms(key, env.DOCUMENT_KMS_LOCAL_KEY_ID ?? 'local-1');
}

/** Encrypting transform; read iv/authTag from result() after the stream has finished. */
export function createEncryptStream(dek: Buffer): { stream: Transform; result: () => { iv: Buffer; authTag: Buffer } } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  return { stream: cipher, result: () => ({ iv, authTag: cipher.getAuthTag() }) };
}

/**
 * Decrypting transform. GCM verifies the tag at the end, so a tampered object fails as the
 * stream finishes (the HTTP response is aborted rather than completed).
 */
export function createDecryptStream(dek: Buffer, iv: Buffer, authTag: Buffer): Transform {
  const d = createDecipheriv('aes-256-gcm', dek, iv);
  d.setAuthTag(authTag);
  return d;
}

/** Small values (file names): iv | tag | ciphertext in one buffer, under the version's DEK. */
export function sealSmall(dek: Buffer, plain: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dek, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function openSmall(dek: Buffer, sealed: Buffer): string {
  const d = createDecipheriv('aes-256-gcm', dek, sealed.subarray(0, 12));
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]).toString('utf8');
}
