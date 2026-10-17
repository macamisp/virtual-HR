/**
 * AWS KMS key provider (SRS 10.1 steps 2 and 5; ADR 021). Data keys are wrapped with KMS Encrypt
 * under the documents key, recovery escrow under a separate recovery key, both with the encryption
 * context {org_id, document_id[, purpose]}: a wrapped key copied to another document, tenant or
 * purpose does not decrypt (KMS checks the context; the key policy requires it). Plaintext keys
 * never leave memory and are never logged.
 */
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import type { KeyContext, KeyProvider, WrappedKey } from './crypto.ts';

/** The same fields and order as the local provider's authenticated data. */
export function encryptionContext(c: KeyContext): Record<string, string> {
  const base: Record<string, string> = { org_id: c.orgId, document_id: c.documentId };
  if (c.purpose && c.purpose !== 'data') base.purpose = c.purpose;
  return base;
}

export class KmsKeyProvider implements KeyProvider {
  private readonly client: KMSClient;
  readonly dataKeyId: string;
  readonly recoveryKeyId: string;

  constructor(opts: { client?: KMSClient; dataKeyId: string; recoveryKeyId: string; region?: string; endpoint?: string }) {
    this.client = opts.client ?? new KMSClient({ region: opts.region, ...(opts.endpoint ? { endpoint: opts.endpoint } : {}) });
    this.dataKeyId = opts.dataKeyId;
    this.recoveryKeyId = opts.recoveryKeyId;
  }

  owns(keyId: string): boolean {
    return keyId === this.dataKeyId || keyId === this.recoveryKeyId;
  }

  async wrap(key: Buffer, context: KeyContext): Promise<WrappedKey> {
    const keyId = context.purpose === 'recovery' ? this.recoveryKeyId : this.dataKeyId;
    const r = await this.client.send(new EncryptCommand({ KeyId: keyId, Plaintext: key, EncryptionContext: encryptionContext(context) }));
    if (!r.CiphertextBlob) throw new Error('KMS returned no ciphertext');
    return { wrapped: Buffer.from(r.CiphertextBlob), keyId };
  }

  async unwrap(wrapped: Buffer, keyId: string, context: KeyContext): Promise<Buffer> {
    if (!this.owns(keyId)) throw new Error(`Unknown key "${keyId}"`);
    if ((context.purpose === 'recovery') !== (keyId === this.recoveryKeyId)) throw new Error('Key purpose does not match the key');
    // KeyId pins the key: a blob from another key is refused by KMS, not silently accepted.
    const r = await this.client.send(new DecryptCommand({ CiphertextBlob: wrapped, KeyId: keyId, EncryptionContext: encryptionContext(context) }));
    if (!r.Plaintext) throw new Error('KMS returned no plaintext');
    return Buffer.from(r.Plaintext);
  }
}

/**
 * Migration (outside production only): new wraps go to KMS, keys wrapped by the local provider
 * before still open until the re-wrap job has moved them (documents/rewrap-keys.ts).
 */
export class CompositeKeyProvider implements KeyProvider {
  constructor(private readonly kms: KmsKeyProvider, private readonly legacy: KeyProvider) {}

  isLegacy(keyId: string): boolean {
    return !this.kms.owns(keyId);
  }

  wrap(key: Buffer, context: KeyContext): Promise<WrappedKey> {
    return this.kms.wrap(key, context);
  }

  unwrap(wrapped: Buffer, keyId: string, context: KeyContext): Promise<Buffer> {
    return this.isLegacy(keyId) ? this.legacy.unwrap(wrapped, keyId, context) : this.kms.unwrap(wrapped, keyId, context);
  }
}
