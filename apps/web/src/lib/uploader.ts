'use client';

import { DocumentDetailSchema, UploadTicketSchema } from '@hrvo/shared';
import type { DocumentDetail, DocumentMetaDto, UploadTicket } from '@hrvo/shared';
import { apiFetch } from './api';

export interface UploadProgress {
  loaded: number;
  total: number;
}

/** PUT one part straight to storage (XHR for progress events; fetch has none for uploads). */
function putPart(url: string, body: Blob, onProgress: (loaded: number) => void, signal?: AbortSignal): Promise<{ status: number; etag: string | null }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => resolve({ status: xhr.status, etag: xhr.getResponseHeader('ETag') });
    xhr.onerror = () => reject(new Error('Network error while uploading'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

/**
 * FR-DOC-001: resumable multi-part upload. Parts go to 5-minute presigned URLs; an expired
 * URL (403) is refreshed and the part retried; a failed part is retried up to 3 times.
 * Returns the document once storage has the file (the virus scan may still be running).
 */
export async function uploadDocument(
  file: File,
  target: { metadata: DocumentMetaDto } | { documentId: string; documentPassword?: string },
  onProgress: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<DocumentDetail> {
  let ticket: UploadTicket = await apiFetch('/documents/uploads', {
    method: 'POST',
    body: { fileName: file.name, size: file.size, ...target },
    schema: UploadTicketSchema,
  });
  const done = new Map<number, string>();
  const loadedByPart = new Map<number, number>();
  const report = () => onProgress({ loaded: [...loadedByPart.values()].reduce((a, b) => a + b, 0), total: file.size });

  try {
    for (let n = 1; n <= ticket.partCount; n += 1) {
      const blob = file.slice((n - 1) * ticket.partSize, n * ticket.partSize);
      for (let attempt = 1; ; attempt += 1) {
        if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
        let url = ticket.parts.find((p) => p.partNumber === n)?.url;
        if (!url || Date.parse(ticket.expiresAt) - Date.now() < 30_000) {
          ticket = await apiFetch(`/documents/uploads/${ticket.versionId}/parts`, {
            method: 'POST',
            body: { partNumbers: Array.from({ length: ticket.partCount - n + 1 }, (_, i) => n + i).slice(0, 100) },
            schema: UploadTicketSchema,
          });
          url = ticket.parts.find((p) => p.partNumber === n)!.url;
        }
        try {
          const res = await putPart(url, blob, (l) => {
            loadedByPart.set(n, l);
            report();
          }, signal);
          if (res.status === 200 && res.etag) {
            done.set(n, res.etag);
            loadedByPart.set(n, blob.size);
            report();
            break;
          }
          if (res.status === 403) ticket = { ...ticket, expiresAt: new Date(0).toISOString() };
          if (attempt >= 3) throw new Error(res.etag ? `Storage refused part ${n} (HTTP ${res.status})` : 'Storage did not return an ETag (check its CORS settings)');
        } catch (err) {
          if ((err as Error).name === 'AbortError' || attempt >= 3) throw err;
        }
      }
    }
    return await apiFetch(`/documents/uploads/${ticket.versionId}/complete`, {
      method: 'POST',
      body: { parts: [...done.entries()].map(([partNumber, etag]) => ({ partNumber, etag })) },
      schema: DocumentDetailSchema,
    });
  } catch (err) {
    // Leave nothing half-uploaded behind.
    await apiFetch(`/documents/uploads/${ticket.versionId}`, { method: 'DELETE' }).catch(() => undefined);
    throw err;
  }
}

