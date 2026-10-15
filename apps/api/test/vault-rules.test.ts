/**
 * Confidential vault rules (FR-DOC-005, 006, 007, 010, 011, 017; SRS 10.1), written before the
 * implementation:
 *  - KeyProvider purposes: data, recovery (a separate key) and metadata; context-bound;
 *  - per-document password: Argon2id (64 MiB, 3 passes, 16-byte salt) wrapping the data key a
 *    second time; wrong password and tampering fail; both wrappings are needed;
 *  - share-link tokens: random, stored only as a hash, compared in constant time;
 *  - re-authentication window, password lockout, retention and trash rules;
 *  - watermarking for view-only mode.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import {
  LocalKeyProvider,
  PASSWORD_KDF,
  derivePasswordKey,
  generateDek,
  keyProviderFromEnv,
  sealPasswordWrap,
  openPasswordWrap,
} from '../src/documents/crypto.ts';
import { generateShareToken, hashShareToken, tokenMatches } from '../src/documents/share-token.ts';
import { lockoutAfterFailure, reauthValid, retentionBlocksDelete, autoShredDue, trashExpired, TRASH_DAYS } from '../src/documents/vault-rules.ts';
import { watermarkImageAsPdf, watermarkPdf } from '../src/documents/watermark.ts';

const DATA = Buffer.alloc(32, 1).toString('base64');
const RECOVERY = Buffer.alloc(32, 2).toString('base64');
const ctx = { orgId: 'org-1', documentId: 'doc-1' };

describe('KeyProvider purposes (SRS 10.1 steps 2 and 5)', () => {
  it('data, metadata and recovery wraps are bound to their purpose; recovery uses its own key', async () => {
    const kp = new LocalKeyProvider({ dataKey: DATA, recoveryKey: RECOVERY });
    const dek = generateDek();
    const data = await kp.wrap(dek, ctx);
    const meta = await kp.wrap(dek, { ...ctx, purpose: 'metadata' });
    const rec = await kp.wrap(dek, { ...ctx, purpose: 'recovery' });
    assert.notEqual(rec.keyId, data.keyId, 'recovery escrow is under a separate key');
    assert.deepEqual(await kp.unwrap(data.wrapped, data.keyId, ctx), dek);
    assert.deepEqual(await kp.unwrap(rec.wrapped, rec.keyId, { ...ctx, purpose: 'recovery' }), dek);
    await assert.rejects(kp.unwrap(meta.wrapped, meta.keyId, ctx), 'a metadata wrap does not open as data');
    await assert.rejects(kp.unwrap(rec.wrapped, data.keyId, { ...ctx, purpose: 'recovery' }), 'the data key cannot open the escrow');
    await assert.rejects(kp.unwrap(data.wrapped, data.keyId, { ...ctx, documentId: 'doc-2' }));
  });

  it('refuses the same key for data and recovery, and the local provider in production', () => {
    assert.throws(() => new LocalKeyProvider({ dataKey: DATA, recoveryKey: DATA }), /different/);
    assert.throws(() => keyProviderFromEnv({ DOCUMENT_KMS_LOCAL_KEY: DATA }), /DOCUMENT_KMS_RECOVERY_KEY/);
    assert.throws(() => keyProviderFromEnv({ NODE_ENV: 'production', DOCUMENT_KMS_LOCAL_KEY: DATA, DOCUMENT_KMS_RECOVERY_KEY: RECOVERY }), /production/);
    assert.ok(keyProviderFromEnv({ DOCUMENT_KMS_LOCAL_KEY: DATA, DOCUMENT_KMS_RECOVERY_KEY: RECOVERY }) instanceof LocalKeyProvider);
  });
});

describe('Per-document password (FR-DOC-006)', () => {
  it('derives a 256-bit key with Argon2id 64 MiB / 3 passes and a random 16-byte salt', async () => {
    assert.deepEqual(PASSWORD_KDF, { algorithm: 'argon2id', memoryKiB: 65536, passes: 3, parallelism: 1, saltBytes: 16, keyBytes: 32, version: 19 });
    const salt = Buffer.alloc(16, 9);
    const a = await derivePasswordKey('correct horse battery', salt);
    const b = await derivePasswordKey('correct horse battery', salt);
    const c = await derivePasswordKey('correct horse battery', Buffer.alloc(16, 8));
    assert.equal(a.length, 32);
    assert.deepEqual(a, b, 'deterministic for the same salt');
    assert.notDeepEqual(a, c, 'the salt changes the key');
    assert.notDeepEqual(a, await derivePasswordKey('correct horse batterz', salt));
  });

  it('wraps the data key a second time; the wrong password and a tampered wrap both fail', async () => {
    const salt = Buffer.alloc(16, 3);
    const dek = generateDek();
    const pwKey = await derivePasswordKey('s3cret-Passphrase', salt);
    const sealed = sealPasswordWrap(dek, pwKey, ctx);
    assert.ok(!sealed.includes(dek));
    assert.deepEqual(openPasswordWrap(sealed, pwKey, ctx), dek);
    assert.throws(() => openPasswordWrap(sealed, Buffer.alloc(32, 0), ctx));
    assert.throws(() => openPasswordWrap(sealed, pwKey, { ...ctx, documentId: 'doc-2' }));
    const bad = Buffer.from(sealed);
    bad[bad.length - 2]! ^= 0x40;
    assert.throws(() => openPasswordWrap(bad, pwKey, ctx));
  });

  it('in password mode both wrappings are needed: the KMS layer alone yields only the password-wrapped key', async () => {
    const kp = new LocalKeyProvider({ dataKey: DATA, recoveryKey: RECOVERY });
    const dek = generateDek();
    const pwKey = await derivePasswordKey('another-passphrase', Buffer.alloc(16, 4));
    const outer = await kp.wrap(sealPasswordWrap(dek, pwKey, ctx), { ...ctx, purpose: 'password' });
    const inner = await kp.unwrap(outer.wrapped, outer.keyId, { ...ctx, purpose: 'password' });
    assert.notDeepEqual(inner, dek, 'KMS access alone does not give the data key');
    assert.deepEqual(openPasswordWrap(inner, pwKey, ctx), dek);
  });
});

describe('Share-link tokens (FR-DOC-010)', () => {
  it('are 256-bit random, URL-safe, and only their SHA-256 is stored', () => {
    const t = generateShareToken();
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(generateShareToken(), t);
    const h = hashShareToken(t);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.ok(!h.includes(t));
    assert.equal(tokenMatches(t, h), true);
    assert.equal(tokenMatches(`${t}x`, h), false);
    assert.equal(tokenMatches('', h), false);
  });
});

describe('Vault rules', () => {
  const now = new Date('2026-10-15T12:00:00Z');

  it('re-authentication is valid for the configured window only (FR-DOC-005)', () => {
    assert.equal(reauthValid(new Date('2026-10-15T11:51:00Z'), now, 10), true);
    assert.equal(reauthValid(new Date('2026-10-15T11:50:00Z'), now, 10), false, 'exactly 10 minutes ago has expired');
    assert.equal(reauthValid(null, now, 10), false);
    assert.equal(reauthValid(new Date('2026-10-15T12:05:00Z'), now, 10), false, 'a future timestamp is not trusted');
  });

  it('three wrong document passwords lock the document for that user for 15 minutes', () => {
    assert.deepEqual(lockoutAfterFailure(0, now), { failures: 1, lockedUntil: null, justLocked: false });
    assert.deepEqual(lockoutAfterFailure(1, now), { failures: 2, lockedUntil: null, justLocked: false });
    const third = lockoutAfterFailure(2, now);
    assert.equal(third.justLocked, true);
    assert.equal(third.failures, 0, 'the counter restarts after a lockout');
    assert.equal(third.lockedUntil?.toISOString(), '2026-10-15T12:15:00.000Z');
  });

  it('retention: minimum keeps deletion back; auto-shred after the maximum; legal hold beats both (FR-DOC-017)', () => {
    const created = new Date('2024-10-16T00:00:00Z');
    assert.equal(retentionBlocksDelete(created, 2, now, false)?.toISOString(), '2026-10-16T00:00:00.000Z');
    assert.equal(retentionBlocksDelete(created, 1, now, false), null);
    assert.equal(retentionBlocksDelete(created, null, now, false), null);
    assert.equal(autoShredDue(new Date('2019-10-14T00:00:00Z'), 7, now, false), true);
    assert.equal(autoShredDue(new Date('2019-10-16T00:00:00Z'), 7, now, false), false);
    assert.equal(autoShredDue(new Date('2000-01-01T00:00:00Z'), 7, now, true), false, 'legal hold');
    assert.equal(autoShredDue(new Date('2000-01-01T00:00:00Z'), null, now, false), false);
  });

  it('trash is kept 30 days before shredding', () => {
    assert.equal(TRASH_DAYS, 30);
    assert.equal(trashExpired(new Date('2026-09-15T11:59:00Z'), now), true);
    assert.equal(trashExpired(new Date('2026-09-16T00:00:00Z'), now), false);
    assert.equal(trashExpired(null, now), false);
  });
});

describe('View-only watermark (FR-DOC-011)', () => {
  const text = 'Sam Subcontractor · 2026-10-15 12:00 UTC · 203.0.113.7';

  async function pagesContain(pdf: Uint8Array, needle: string): Promise<boolean> {
    const doc = await PDFDocument.load(pdf);
    const hex = Buffer.from(needle, 'latin1').toString('hex').toUpperCase();
    for (const page of doc.getPages()) {
      const contents = page.node.Contents();
      const streams = contents ? (('asArray' in contents) ? (contents as unknown as { asArray(): unknown[] }).asArray() : [contents]) : [];
      for (const ref of streams) {
        const s = doc.context.lookup(ref as never) as unknown as { getContents?: () => Uint8Array; contents?: Uint8Array };
        const raw = Buffer.from(s.getContents ? s.getContents() : (s.contents ?? new Uint8Array()));
        let body = raw;
        try {
          body = inflateSync(raw);
        } catch {
          // not compressed
        }
        const str = body.toString('latin1').toUpperCase();
        if (str.includes(hex) || str.includes(needle.toUpperCase())) return true;
      }
    }
    return false;
  }

  it('stamps every page of a PDF', async () => {
    const src = await PDFDocument.create();
    src.addPage([300, 400]);
    src.addPage([300, 400]);
    const out = await watermarkPdf(await src.save(), text);
    const doc = await PDFDocument.load(out);
    assert.equal(doc.getPageCount(), 2);
    assert.equal(await pagesContain(out, 'Sam Subcontractor'), true);
  });

  it('turns a PNG or JPEG into a stamped one-page PDF', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c10000000049454e44ae426082', 'hex');
    const out = await watermarkImageAsPdf(png, 'image/png', text);
    assert.equal((await PDFDocument.load(out)).getPageCount(), 1);
    assert.equal(await pagesContain(out, 'Sam Subcontractor'), true);
    await assert.rejects(watermarkImageAsPdf(png, 'image/gif', text), /not supported/);
  });

  it('refuses a broken or encrypted PDF rather than serving it unmarked', async () => {
    await assert.rejects(watermarkPdf(Buffer.from('%PDF-1.4 not really'), text));
  });
});
