/**
 * FR-DOC-007 envelope encryption (SRS 10.1 steps 1-2). Every file version gets its own random
 * 256-bit data key (DEK) and 96-bit IV; content is encrypted with AES-256-GCM. The DEK is
 * wrapped by a KMS key with the encryption context {org_id, document_id}, so a wrapped key
 * copied to another document or tenant cannot be unwrapped. Plaintext DEKs live only in
 * memory for the duration of one operation.
 *
 * KeyProvider has one implementation today: LocalKeyProvider (keys from .env, dev/test).
 * An AWS KMS adapter (Encrypt/Decrypt with EncryptionContext) plugs in behind the same interface.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { Transform } from 'node:stream';

export type KeyPurpose = 'data' | 'metadata' | 'password' | 'recovery';

export interface KeyContext {
  orgId: string;
  documentId: string;
  /** What the wrapped key is for; part of the authenticated context (default 'data'). */
  purpose?: KeyPurpose;
}

export interface WrappedKey {
  wrapped: Buffer;
  keyId: string;
}

/**
 * Wraps and unwraps keys with a key-encryption key (KEK) that never leaves the provider.
 * LocalKeyProvider (env keys, dev/test) today; an AWS KMS adapter (Encrypt/Decrypt with
 * EncryptionContext = the same fields) later. Plaintext keys are never logged or stored.
 */
export interface KeyProvider {
  wrap(key: Buffer, context: KeyContext): Promise<WrappedKey>;
  unwrap(wrapped: Buffer, keyId: string, context: KeyContext): Promise<Buffer>;
}

export const KEY_PROVIDER = Symbol('KEY_PROVIDER');

export function generateDek(): Buffer {
  return randomBytes(32);
}

function aad(context: KeyContext): Buffer {
  // Canonical encoding with a fixed key order. 'data' keeps the original two-field context, so
  // keys wrapped before purposes existed still open.
  const base: Record<string, string> = { org_id: context.orgId, document_id: context.documentId };
  if (context.purpose && context.purpose !== 'data') base.purpose = context.purpose;
  return Buffer.from(JSON.stringify(base));
}

function gcmWrap(kek: Buffer, plain: Buffer, additional: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kek, iv);
  c.setAAD(additional);
  const body = Buffer.concat([c.update(plain), c.final()]);
  // Layout: version(1) | iv(12) | tag(16) | ciphertext
  return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body]);
}

function gcmUnwrap(kek: Buffer, wrapped: Buffer, additional: Buffer): Buffer {
  if (wrapped.length < 29 || wrapped[0] !== 1) throw new Error('Unsupported wrapped key format');
  const d = createDecipheriv('aes-256-gcm', kek, wrapped.subarray(1, 13));
  d.setAAD(additional);
  d.setAuthTag(wrapped.subarray(13, 29));
  return Buffer.concat([d.update(wrapped.subarray(29)), d.final()]);
}

function decodeKey(b64: string, name: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded`);
  return key;
}

/**
 * Development / test provider. Two KEKs: one for data, metadata and password-mode wraps, and a
 * separate one for the recovery escrow (SRS 10.1 step 5), so access to one does not imply the
 * other; in production these become two KMS keys with separate IAM policies.
 */
export class LocalKeyProvider implements KeyProvider {
  private readonly dataKey: Buffer;
  private readonly recoveryKey: Buffer;
  readonly dataKeyId: string;
  readonly recoveryKeyId: string;

  constructor(opts: { dataKey: string; recoveryKey: string; dataKeyId?: string; recoveryKeyId?: string }) {
    this.dataKey = decodeKey(opts.dataKey, 'DOCUMENT_KMS_LOCAL_KEY');
    this.recoveryKey = decodeKey(opts.recoveryKey, 'DOCUMENT_KMS_RECOVERY_KEY');
    if (this.dataKey.equals(this.recoveryKey)) throw new Error('The recovery key must be different from the data key');
    this.dataKeyId = opts.dataKeyId ?? 'local-1';
    this.recoveryKeyId = opts.recoveryKeyId ?? 'local-recovery-1';
  }

  async wrap(key: Buffer, context: KeyContext): Promise<WrappedKey> {
    const recovery = context.purpose === 'recovery';
    return { wrapped: gcmWrap(recovery ? this.recoveryKey : this.dataKey, key, aad(context)), keyId: recovery ? this.recoveryKeyId : this.dataKeyId };
  }

  async unwrap(wrapped: Buffer, keyId: string, context: KeyContext): Promise<Buffer> {
    const kek = keyId === this.dataKeyId ? this.dataKey : keyId === this.recoveryKeyId ? this.recoveryKey : null;
    if (!kek) throw new Error(`Unknown key "${keyId}"`);
    if ((context.purpose === 'recovery') !== (kek === this.recoveryKey)) throw new Error('Key purpose does not match the key');
    return gcmUnwrap(kek, wrapped, aad(context));
  }
}

export function keyProviderFromEnv(env: Record<string, string | undefined> = process.env): KeyProvider {
  const provider = env.DOCUMENT_KMS_PROVIDER ?? 'local';
  if (provider !== 'local') throw new Error(`Unsupported DOCUMENT_KMS_PROVIDER "${provider}" (only "local" is implemented)`);
  if (env.NODE_ENV === 'production') {
    throw new Error('The local key provider must not be used in production: configure a managed KMS');
  }
  if (!env.DOCUMENT_KMS_LOCAL_KEY) throw new Error('DOCUMENT_KMS_LOCAL_KEY is required (32 random bytes, base64)');
  if (!env.DOCUMENT_KMS_RECOVERY_KEY) throw new Error('DOCUMENT_KMS_RECOVERY_KEY is required (32 random bytes, base64, different from the data key)');
  return new LocalKeyProvider({
    dataKey: env.DOCUMENT_KMS_LOCAL_KEY,
    recoveryKey: env.DOCUMENT_KMS_RECOVERY_KEY,
    dataKeyId: env.DOCUMENT_KMS_LOCAL_KEY_ID,
    recoveryKeyId: env.DOCUMENT_KMS_RECOVERY_KEY_ID,
  });
}

// ---- per-document password (FR-DOC-006, SRS 10.1 step 3)

/** Argon2id parameters from SRS 10.1, stored with each protected document. */
export const PASSWORD_KDF = { algorithm: 'argon2id', memoryKiB: 65536, passes: 3, parallelism: 1, saltBytes: 16, keyBytes: 32, version: 19 } as const;

export function newPasswordSalt(): Buffer {
  return randomBytes(PASSWORD_KDF.saltBytes);
}

export async function derivePasswordKey(password: string, salt: Buffer): Promise<Buffer> {
  return await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: PASSWORD_KDF.memoryKiB,
    timeCost: PASSWORD_KDF.passes,
    parallelism: PASSWORD_KDF.parallelism,
    hashLength: PASSWORD_KDF.keyBytes,
    salt,
    raw: true,
  });
}

/** The data key wrapped by the password-derived key (bound to the document). */
export function sealPasswordWrap(dek: Buffer, passwordKey: Buffer, context: KeyContext): Buffer {
  return gcmWrap(passwordKey, dek, aad({ ...context, purpose: 'password' }));
}

/** Throws on a wrong password (GCM authentication failure) or a tampered value. */
export function openPasswordWrap(sealed: Buffer, passwordKey: Buffer, context: KeyContext): Buffer {
  return gcmUnwrap(passwordKey, sealed, aad({ ...context, purpose: 'password' }));
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
