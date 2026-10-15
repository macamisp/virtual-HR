/**
 * FR-DOC-001 content sniffing. The file's own bytes decide its type; the extension must
 * agree, and the browser's MIME type is ignored. Only the allow-list is accepted:
 * PDF, DOCX, XLSX, PPTX, PNG, JPEG, GIF, WEBP, ZIP and plain UTF-8 text.
 * Office files are ZIP containers, so their entry names are read from the central directory
 * (macro-enabled variants are refused). HTML, SVG, executables and legacy OLE files are not
 * on the list.
 */

export const FILE_KINDS = ['pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpeg', 'gif', 'webp', 'zip', 'txt'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const MIME: Record<FileKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  zip: 'application/zip',
  txt: 'text/plain; charset=utf-8',
};

const EXTENSIONS: Record<FileKind, string[]> = {
  pdf: ['pdf'],
  docx: ['docx'],
  xlsx: ['xlsx'],
  pptx: ['pptx'],
  png: ['png'],
  jpeg: ['jpg', 'jpeg'],
  gif: ['gif'],
  webp: ['webp'],
  zip: ['zip'],
  txt: ['txt'],
};

/** FR-DOC-019: previewable in the browser without conversion. */
export const PREVIEWABLE: readonly FileKind[] = ['pdf', 'png', 'jpeg', 'gif', 'webp'];

/** Bytes needed from the start of the file. */
export const SNIFF_HEAD_BYTES = 4096;

export interface SniffResult {
  kind: FileKind | null;
  reason?: string;
}

const startsWith = (b: Buffer, sig: number[] | string, at = 0): boolean => {
  const s = typeof sig === 'string' ? Buffer.from(sig, 'latin1') : Buffer.from(sig);
  return b.length >= at + s.length && b.subarray(at, at + s.length).equals(s);
};

function isText(head: Buffer): boolean {
  if (head.length === 0 || head.includes(0)) return false;
  // A multi-byte character may be cut at the end of the sample; drop up to 3 trailing bytes.
  for (let cut = 0; cut <= 3; cut += 1) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - cut));
      break;
    } catch {
      if (cut === 3) return false;
    }
  }
  const lower = head.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  // Markup that a browser would render as active content is not "plain text".
  return !(lower.startsWith('<!doctype html') || lower.startsWith('<html') || lower.startsWith('<svg') || lower.startsWith('<?xml') || lower.includes('<script'));
}

/**
 * @param head the first bytes of the file (SNIFF_HEAD_BYTES is enough)
 * @param zipEntries entry names from the central directory when the file is a ZIP, else null
 */
export function sniff(head: Buffer, zipEntries: string[] | null): SniffResult {
  if (startsWith(head, '%PDF-')) return { kind: 'pdf' };
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'png' };
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { kind: 'jpeg' };
  if (startsWith(head, 'GIF87a') || startsWith(head, 'GIF89a')) return { kind: 'gif' };
  if (startsWith(head, 'RIFF') && startsWith(head, 'WEBP', 8)) return { kind: 'webp' };
  if (startsWith(head, 'PK\x03\x04') || startsWith(head, 'PK\x05\x06')) {
    if (!zipEntries) return { kind: null, reason: 'The archive could not be read' };
    const has = (prefix: string) => zipEntries.some((e) => e.startsWith(prefix));
    if (zipEntries.some((e) => /vbaProject\.bin$/i.test(e))) return { kind: null, reason: 'Macro-enabled Office files are not allowed' };
    if (has('[Content_Types].xml')) {
      if (has('word/')) return { kind: 'docx' };
      if (has('xl/')) return { kind: 'xlsx' };
      if (has('ppt/')) return { kind: 'pptx' };
    }
    return { kind: 'zip' };
  }
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { kind: null, reason: 'Legacy Office formats (.doc, .xls, .ppt) are not allowed; save as .docx, .xlsx or .pptx' };
  if (startsWith(head, 'MZ') || startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return { kind: null, reason: 'Executables are not allowed' };
  if (isText(head)) return { kind: 'txt' };
  return { kind: null, reason: 'This file type is not allowed' };
}

function extensionOf(fileName: string): string | null {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(fileName.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** null when fine, else a reason. The allow-list is configurable (DOCUMENT_ALLOWED_TYPES). */
export function checkExtension(fileName: string, kind: FileKind, allowed: readonly FileKind[] = FILE_KINDS): string | null {
  const ext = extensionOf(fileName);
  if (!ext) return 'The file needs an extension such as .pdf';
  const claimed = (Object.keys(EXTENSIONS) as FileKind[]).find((k) => EXTENSIONS[k].includes(ext));
  if (!claimed || !allowed.includes(claimed)) return `.${ext} files are not allowed`;
  if (!allowed.includes(kind)) return `${kind.toUpperCase()} files are not allowed`;
  if (claimed !== kind) return `The content (${kind.toUpperCase()}) does not match the .${ext} extension`;
  return null;
}

/** Up-front check on the name only, before any bytes are uploaded. */
export function extensionAllowed(fileName: string, allowed: readonly FileKind[] = FILE_KINDS): boolean {
  const ext = extensionOf(fileName);
  return !!ext && allowed.some((k) => EXTENSIONS[k].includes(ext));
}

export function allowedKindsFromEnv(value = process.env.DOCUMENT_ALLOWED_TYPES): FileKind[] {
  if (!value) return [...FILE_KINDS];
  const list = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = list.filter((k) => !(FILE_KINDS as readonly string[]).includes(k));
  if (bad.length) throw new Error(`DOCUMENT_ALLOWED_TYPES has unknown types: ${bad.join(', ')}`);
  return list as FileKind[];
}

/**
 * Entry names from a ZIP's central directory. `tail` is the end of the file (at least the
 * EOCD record and the central directory). Returns [] when it cannot be parsed.
 */
export function parseZipEntries(tail: Buffer): string[] {
  let eocd = -1;
  for (let i = tail.length - 22; i >= Math.max(0, tail.length - 65557); i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const cdSize = tail.readUInt32LE(eocd + 12);
  const total = tail.readUInt16LE(eocd + 10);
  let p = eocd - cdSize;
  if (p < 0) return [];
  const names: string[] = [];
  for (let n = 0; n < total && p + 46 <= eocd; n += 1) {
    if (tail.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = tail.readUInt16LE(p + 28);
    const extraLen = tail.readUInt16LE(p + 30);
    const commentLen = tail.readUInt16LE(p + 32);
    names.push(tail.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}
