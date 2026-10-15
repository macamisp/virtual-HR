/**
 * Key handling for the confidential vault (FR-DOC-006, 007; SRS 10.1). Every function returns
 * plaintext keys only to its caller, which zero-fills them after use. Nothing here logs.
 *
 * A version's data key (DEK) is stored in one of two forms:
 *  - normal:   dek_wrapped_kms = KMS(DEK)
 *  - password: dek_wrapped_pw  = KMS(Argon2id(password, pw_salt) ⊕wrap DEK)  (both needed)
 *              dek_wrapped_recovery = KMS_recovery(DEK)                     (escrow, SRS 10.1 step 5)
 * While a password-protected upload waits for its scan, dek_wrapped_kms also holds KMS(DEK) so
 * the scanner can encrypt; it is destroyed when the scan finishes.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  KEY_PROVIDER,
  PASSWORD_KDF,
  derivePasswordKey,
  generateDek,
  newPasswordSalt,
  openPasswordWrap,
  openSmall,
  sealPasswordWrap,
  sealSmall,
} from './crypto.ts';
import type { KeyProvider } from './crypto.ts';

export class PasswordRequiredError extends Error {
  constructor() {
    super('This document is protected by a password');
  }
}

export class WrongDocumentPasswordError extends Error {
  constructor() {
    super('Wrong document password');
  }
}

export class ShreddedError extends Error {
  constructor() {
    super('This document was destroyed');
  }
}

export interface VersionKeys {
  dek_wrapped_kms: Buffer | null;
  kms_key_id: string;
  dek_wrapped_pw: Buffer | null;
  pw_salt: Buffer | null;
  dek_wrapped_recovery: Buffer | null;
  recovery_key_id: string | null;
}

export interface PasswordWrap {
  dekWrappedPw: Buffer;
  pwSalt: Buffer;
  pwKdfParams: typeof PASSWORD_KDF;
  dekWrappedRecovery: Buffer;
  recoveryKeyId: string;
  keyId: string;
}

export interface TitleSeal {
  titleEnc: Buffer;
  metaKeyWrapped: Buffer;
  metaKeyId: string;
}

@Injectable()
export class DocumentVault {
  constructor(@Inject(KEY_PROVIDER) private readonly keys: KeyProvider) {}

  // ---- titles of confidential documents (FR-DOC-007, SRS 7.4 title_enc)

  async sealTitle(orgId: string, documentId: string, title: string, existing?: { wrapped: Buffer; keyId: string } | null): Promise<TitleSeal> {
    const ctx = { orgId, documentId, purpose: 'metadata' as const };
    let mk: Buffer;
    let wrapped: Buffer;
    let keyId: string;
    if (existing) {
      mk = await this.keys.unwrap(existing.wrapped, existing.keyId, ctx);
      wrapped = existing.wrapped;
      keyId = existing.keyId;
    } else {
      mk = generateDek();
      const w = await this.keys.wrap(mk, ctx);
      wrapped = w.wrapped;
      keyId = w.keyId;
    }
    try {
      return { titleEnc: sealSmall(mk, title), metaKeyWrapped: wrapped, metaKeyId: keyId };
    } finally {
      mk.fill(0);
    }
  }

  async openTitle(orgId: string, documentId: string, titleEnc: Buffer, wrapped: Buffer, keyId: string): Promise<string> {
    const mk = await this.keys.unwrap(wrapped, keyId, { orgId, documentId, purpose: 'metadata' });
    try {
      return openSmall(mk, titleEnc);
    } finally {
      mk.fill(0);
    }
  }

  /** The title to show for a row the viewer is allowed to see. */
  async titleOf(orgId: string, r: { id: string; title: string | null; title_enc: Buffer | null; meta_key_wrapped: Buffer | null; meta_key_id: string | null; shredded_at: Date | null }): Promise<string> {
    if (r.shredded_at) return 'Destroyed document';
    if (r.title !== null) return r.title;
    if (r.title_enc && r.meta_key_wrapped && r.meta_key_id) {
      try {
        return await this.openTitle(orgId, r.id, r.title_enc, r.meta_key_wrapped, r.meta_key_id);
      } catch {
        return 'Confidential document';
      }
    }
    return 'Confidential document';
  }

  // ---- data keys

  /** The version's data key, using the document password when the version is protected. */
  async versionDek(orgId: string, documentId: string, v: VersionKeys, password?: string): Promise<Buffer> {
    if (v.dek_wrapped_pw && v.pw_salt) {
      if (!password) throw new PasswordRequiredError();
      const inner = await this.keys.unwrap(v.dek_wrapped_pw, v.kms_key_id, { orgId, documentId, purpose: 'password' });
      const pwKey = await derivePasswordKey(password, v.pw_salt);
      try {
        return openPasswordWrap(inner, pwKey, { orgId, documentId });
      } catch {
        throw new WrongDocumentPasswordError();
      } finally {
        pwKey.fill(0);
        inner.fill(0);
      }
    }
    if (!v.dek_wrapped_kms) throw new ShreddedError();
    return await this.keys.unwrap(v.dek_wrapped_kms, v.kms_key_id, { orgId, documentId });
  }

  /** The data key through the recovery escrow (vault.recover only; audited by the caller). */
  async recoveryDek(orgId: string, documentId: string, v: VersionKeys): Promise<Buffer> {
    if (!v.dek_wrapped_recovery || !v.recovery_key_id) throw new ShreddedError();
    return await this.keys.unwrap(v.dek_wrapped_recovery, v.recovery_key_id, { orgId, documentId, purpose: 'recovery' });
  }

  async wrapPlain(orgId: string, documentId: string, dek: Buffer): Promise<{ wrapped: Buffer; keyId: string }> {
    return await this.keys.wrap(dek, { orgId, documentId });
  }

  /** Password mode for one version: a fresh salt per version (SRS 7.4 pw_salt), plus the escrow. */
  async wrapWithPassword(orgId: string, documentId: string, dek: Buffer, password: string): Promise<PasswordWrap> {
    const salt = newPasswordSalt();
    const pwKey = await derivePasswordKey(password, salt);
    try {
      const sealed = sealPasswordWrap(dek, pwKey, { orgId, documentId });
      const outer = await this.keys.wrap(sealed, { orgId, documentId, purpose: 'password' });
      const escrow = await this.keys.wrap(dek, { orgId, documentId, purpose: 'recovery' });
      return { dekWrappedPw: outer.wrapped, pwSalt: salt, pwKdfParams: PASSWORD_KDF, dekWrappedRecovery: escrow.wrapped, recoveryKeyId: escrow.keyId, keyId: outer.keyId };
    } finally {
      pwKey.fill(0);
    }
  }
}
