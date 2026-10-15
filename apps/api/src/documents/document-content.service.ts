import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { createDecryptStream, openSmall } from './crypto.ts';
import { OBJECT_STORE } from './object-store.ts';
import type { ObjectStore } from './object-store.ts';
import { watermarkImageAsPdf, watermarkPdf } from './watermark.ts';
import type { VersionRow } from './documents.sql.ts';

export interface FileStream {
  stream: Readable;
  fileName: string;
  mimeType: string;
  sizeBytes: number | null;
  /** SHA-256 of the original; omitted for the watermarked rendering (different bytes). */
  sha256: string | null;
  viewOnly: boolean;
}

const VIEW_LIMIT = 100 * 1024 * 1024;

/**
 * Turns a version + its data key into the bytes a viewer receives: the decrypted original
 * (streamed; a tampered object fails the GCM tag and aborts), or the view-only rendering with a
 * dynamic watermark (FR-DOC-011). The caller passes ownership of `dek`; it is zero-filled here.
 */
@Injectable()
export class DocumentContent {
  constructor(@Inject(OBJECT_STORE) private readonly store: ObjectStore) {}

  fileName(v: VersionRow, dek: Buffer): string {
    return v.file_name_enc ? openSmall(dek, v.file_name_enc) : 'document';
  }

  async original(v: VersionRow, dek: Buffer): Promise<FileStream> {
    const fileName = this.fileName(v, dek);
    const source = await this.store.stream(v.storage_key!);
    const plain = source.pipe(createDecryptStream(dek, v.iv!, v.auth_tag!));
    source.on('error', (err) => plain.destroy(err));
    plain.on('close', () => dek.fill(0));
    return { stream: plain, fileName, mimeType: v.mime_type!, sizeBytes: Number(v.size_bytes), sha256: v.sha256, viewOnly: false };
  }

  async viewOnly(v: VersionRow, dek: Buffer, watermark: string): Promise<FileStream> {
    let fileName: string;
    let bytes: Buffer;
    try {
      fileName = this.fileName(v, dek);
      const source = await this.store.stream(v.storage_key!);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const c of source.pipe(createDecryptStream(dek, v.iv!, v.auth_tag!))) {
        total += (c as Buffer).length;
        if (total > VIEW_LIMIT) throw new UnprocessableEntityException('The file is too large for view-only mode');
        chunks.push(c as Buffer);
      }
      bytes = Buffer.concat(chunks);
    } finally {
      dek.fill(0);
    }
    let stamped: Uint8Array;
    try {
      stamped = v.mime_type === 'application/pdf' ? await watermarkPdf(bytes, watermark) : await watermarkImageAsPdf(bytes, v.mime_type ?? '', watermark);
    } catch (err) {
      if (err instanceof UnprocessableEntityException) throw err;
      throw new UnprocessableEntityException('This file cannot be shown in view-only mode');
    } finally {
      bytes.fill(0);
    }
    const out = Buffer.from(stamped);
    return { stream: Readable.from([out]), fileName: `${fileName.replace(/\.[^.]+$/, '')} (view only).pdf`, mimeType: 'application/pdf', sizeBytes: out.length, sha256: null, viewOnly: true };
  }
}

/** FR-DOC-011: who is looking, when and from where, burned into every page. */
export function watermarkText(viewer: string, ip: string | null, now: Date = new Date()): string {
  const when = now.toISOString().slice(0, 16).replace('T', ' ');
  return `${viewer} · ${when} UTC · ${ip ?? 'unknown IP'} · view only`;
}
