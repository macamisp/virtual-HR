import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { NotificationsService } from '../notifications/notifications.service.ts';
import { KEY_PROVIDER, createEncryptStream, openSmall } from './crypto.ts';
import type { KeyProvider } from './crypto.ts';
import { OBJECT_STORE, keys } from './object-store.ts';
import type { ObjectStore } from './object-store.ts';
import { MIME, SNIFF_HEAD_BYTES, allowedKindsFromEnv, checkExtension, parseZipEntries, sniff } from './sniff.ts';
import { clamdFromEnv, scanStream } from './clamav.ts';
import type { ClamdOptions } from './clamav.ts';
import { logAccess } from './access-log.ts';

export type ScanOutcome = 'CLEAN' | 'INFECTED' | 'REJECTED' | 'SKIPPED' | 'BUSY';

/** Seam for tests: a fake clamd answer without a network. */
export const CLAMD_OPTIONS = Symbol('CLAMD_OPTIONS');

interface PendingRow {
  id: string;
  document_id: string;
  version_no: number;
  staging_key: string;
  file_name_enc: Buffer;
  dek_wrapped_kms: Buffer;
  kms_key_id: string;
  scan_status: string;
  uploaded_by: string;
  title: string | null;
}

const MAX_ZIP_DIRECTORY = 4 * 1024 * 1024;

/**
 * FR-DOC-001 / 007 / 013 pipeline for one uploaded version, in this order:
 *  1. sniff the bytes (never the extension) against the allow-list: else REJECTED;
 *  2. ClamAV: INFECTED -> moved to quarantine, uploader notified, audited;
 *  3. CLEAN -> encrypted with the version's DEK into its final key, staging plaintext deleted,
 *     the version becomes current. Errors (clamd down) leave it PENDING for a retry.
 */
@Injectable()
export class DocumentScannerService {
  private readonly allowed = allowedKindsFromEnv();

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(KEY_PROVIDER) private readonly kms: KeyProvider,
    @Inject(CLAMD_OPTIONS) private readonly clamd: ClamdOptions,
  ) {}

  async process(orgId: string, versionId: string): Promise<ScanOutcome> {
    // One scanner per version at a time, across API instances (session-level advisory lock).
    const lock = await this.prisma.getPool().connect();
    const lockKey = `doc-scan:${versionId}`;
    try {
      const got = await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [lockKey]);
      if (!got.rows[0]?.ok) return 'BUSY';
      try {
        return await this.run(orgId, versionId);
      } finally {
        await lock.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey]);
      }
    } finally {
      lock.release();
    }
  }

  private async run(orgId: string, versionId: string): Promise<ScanOutcome> {
    const v = await this.prisma.runWithTenantContext(orgId, async (db) => {
      const res = await db.query<PendingRow>(
        `SELECT v.id, v.document_id, v.version_no, v.staging_key, v.file_name_enc, v.dek_wrapped_kms, v.kms_key_id, v.scan_status, v.uploaded_by, d.title
         FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.id = $1`,
        [versionId],
      );
      return res.rows[0];
    });
    if (!v || v.scan_status !== 'PENDING') return 'SKIPPED';
    const dek = await this.kms.unwrap(v.dek_wrapped_kms, v.kms_key_id, { orgId, documentId: v.document_id });
    try {
      const fileName = openSmall(dek, v.file_name_enc);
      const size = await this.store.size(v.staging_key);
      const head = await this.store.range(v.staging_key, 0, Math.min(size, SNIFF_HEAD_BYTES) - 1);
      const isZip = head.subarray(0, 2).toString('latin1') === 'PK';
      const sniffed = sniff(head, isZip ? await this.zipEntries(v.staging_key, size) : null);
      const reason = sniffed.kind ? checkExtension(fileName, sniffed.kind, this.allowed) : (sniffed.reason ?? 'This file type is not allowed');
      if (reason || !sniffed.kind) {
        await this.finishRejected(orgId, v, reason ?? 'This file type is not allowed');
        return 'REJECTED';
      }

      const verdict = await scanStream(await this.store.stream(v.staging_key), this.clamd);
      if (verdict.status === 'INFECTED') {
        await this.finishInfected(orgId, v, verdict.signature);
        return 'INFECTED';
      }

      // Encrypt while hashing the plaintext (SRS 7.4 sha256: integrity and e-sign evidence).
      const hash = createHash('sha256');
      const tap = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      const enc = createEncryptStream(dek);
      const source = await this.store.stream(v.staging_key);
      source.on('error', (err) => enc.stream.destroy(err));
      tap.on('error', (err) => enc.stream.destroy(err));
      const storedKey = keys.stored(orgId, v.document_id, v.id);
      await this.store.put(storedKey, source.pipe(tap).pipe(enc.stream), size);
      const { iv, authTag } = enc.result();
      const sha256 = hash.digest('hex');

      const mime = MIME[sniffed.kind];
      await this.prisma.runWithTenantContext(orgId, async (db) => {
        const upd = await db.query(
          `UPDATE document_versions SET scan_status = 'CLEAN', scan_detail = NULL, storage_key = $2, iv = $3, auth_tag = $4, sha256 = $5,
             mime_type = $6, size_bytes = $7, scanned_at = now(), staging_key = NULL,
             -- Password mode: the KMS-only wrap existed for this scan only (both wrappings needed from now on).
             dek_wrapped_kms = CASE WHEN dek_wrapped_pw IS NOT NULL THEN NULL ELSE dek_wrapped_kms END
           WHERE id = $1 AND scan_status = 'PENDING'`,
          [v.id, storedKey, iv, authTag, sha256, mime, size],
        );
        if ((upd.rowCount ?? 0) === 0) return;
        // The newest clean version becomes current (an older one finishing late does not win).
        await db.query(
          `UPDATE documents d SET current_version_id = $2, version = version + 1, updated_at = now()
           WHERE d.id = $1 AND (d.current_version_id IS NULL OR (SELECT version_no FROM document_versions WHERE id = d.current_version_id) < $3)`,
          [v.document_id, v.id, v.version_no],
        );
      });
      await this.store.remove(v.staging_key).catch(() => undefined);
      return 'CLEAN';
    } finally {
      dek.fill(0);
    }
  }

  /** Entry names from the ZIP central directory, read with two small range requests. */
  private async zipEntries(key: string, size: number): Promise<string[]> {
    const tailStart = Math.max(0, size - 65557);
    const tail = await this.store.range(key, tailStart, size - 1);
    const names = parseZipEntries(tail);
    if (names.length > 0) return names;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) !== 0x06054b50) continue;
      const cdSize = tail.readUInt32LE(i + 12);
      const cdOffset = tail.readUInt32LE(i + 16);
      if (cdSize > MAX_ZIP_DIRECTORY || cdOffset + cdSize > size) return [];
      return parseZipEntries(await this.store.range(key, cdOffset, size - 1));
    }
    return [];
  }

  private async finishRejected(orgId: string, v: PendingRow, reason: string): Promise<void> {
    await this.store.remove(v.staging_key).catch(() => undefined);
    await this.prisma.runWithTenantContext(orgId, async (db) => {
      await db.query(`UPDATE document_versions SET scan_status = 'REJECTED', scan_detail = $2, scanned_at = now(), staging_key = NULL, dek_wrapped_pw = NULL, dek_wrapped_recovery = NULL WHERE id = $1 AND scan_status = 'PENDING'`, [v.id, reason.slice(0, 300)]);
    });
    await this.notifications.notify(orgId, [{
      userId: v.uploaded_by, type: 'DOCUMENT_REJECTED', title: `Upload refused: ${v.title ?? 'a confidential document'}`,
      body: `${reason}. Nothing was stored.`, link: `/documents/${v.document_id}`, entityType: 'DOCUMENT', entityId: v.document_id,
    }]);
  }

  private async finishInfected(orgId: string, v: PendingRow, signature: string): Promise<void> {
    const quarantine = keys.quarantine(orgId, v.document_id, v.id);
    await this.store.copy(v.staging_key, quarantine);
    await this.store.remove(v.staging_key);
    await this.prisma.runWithTenantContext(orgId, async (db) => {
      await db.query(
        `UPDATE document_versions SET scan_status = 'INFECTED', scan_detail = $2, scanned_at = now(), storage_key = $3, staging_key = NULL, dek_wrapped_pw = NULL, dek_wrapped_recovery = NULL WHERE id = $1 AND scan_status = 'PENDING'`,
        [v.id, `Malware detected: ${signature}`.slice(0, 300), quarantine],
      );
      await logAccess(db, { orgId, documentId: v.document_id, versionId: v.id, userId: null, action: 'QUARANTINE', detail: { signature, versionNo: v.version_no } });
      await appendAuditEntry(db, { orgId, actorId: v.uploaded_by, action: 'DOCUMENT_INFECTED', entityType: 'DOCUMENT', entityId: v.document_id, after: { versionId: v.id, signature } });
    });
    await this.notifications.notify(orgId, [{
      userId: v.uploaded_by, type: 'DOCUMENT_INFECTED', title: `Malware found in your upload: ${v.title ?? 'a confidential document'}`,
      body: `The virus scanner found ${signature}. The file is quarantined and cannot be opened. Check your computer and upload a clean copy.`,
      link: `/documents/${v.document_id}`, entityType: 'DOCUMENT', entityId: v.document_id, email: true,
    }]);
  }
}

export function clamdOptionsProvider() {
  return { provide: CLAMD_OPTIONS, useFactory: () => clamdFromEnv() };
}
