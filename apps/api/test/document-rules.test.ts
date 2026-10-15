/**
 * Document rules, written before the implementation (AGENTS.md: crypto tests first):
 *  - envelope encryption (FR-DOC-007): per-version DEK, AES-256-GCM, KMS wrap bound to
 *    {org_id, document_id};
 *  - content sniffing (FR-DOC-001): the bytes decide the type, never the extension or the
 *    browser's MIME type;
 *  - the clamd INSTREAM protocol (FR-DOC-013);
 *  - effective document permission (FR-DOC-009).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { deflateRawSync } from 'node:zlib';
import {
  LocalKeyProvider,
  createDecryptStream,
  createEncryptStream,
  generateDek,
  keyProviderFromEnv,
} from '../src/documents/crypto.ts';
import { checkExtension, parseZipEntries, sniff } from '../src/documents/sniff.ts';
import { scanStream } from '../src/documents/clamav.ts';
import { documentAbilities, effectiveLevel } from '../src/documents/document-policy.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');
const RKEY = Buffer.alloc(32, 6).toString('base64');
const ctx = { orgId: 'org-1', documentId: 'doc-1' };

async function collect(s: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

describe('Envelope encryption (FR-DOC-007)', () => {
  it('wraps and unwraps a DEK only with the same encryption context', async () => {
    const kms = new LocalKeyProvider({ dataKey: KEY, recoveryKey: RKEY });
    const dek = generateDek();
    assert.equal(dek.length, 32);
    const w = await kms.wrap(dek, ctx);
    assert.equal(w.keyId, 'local-1');
    assert.ok(!w.wrapped.includes(dek), 'the wrapped key does not contain the plaintext key');
    assert.deepEqual(await kms.unwrap(w.wrapped, w.keyId, ctx), dek);
    await assert.rejects(kms.unwrap(w.wrapped, w.keyId, { orgId: 'org-2', documentId: 'doc-1' }));
    await assert.rejects(kms.unwrap(w.wrapped, w.keyId, { orgId: 'org-1', documentId: 'doc-2' }));
    const tampered = Buffer.from(w.wrapped);
    tampered[tampered.length - 1]! ^= 1;
    await assert.rejects(kms.unwrap(tampered, w.keyId, ctx));
    await assert.rejects(new LocalKeyProvider({ dataKey: Buffer.alloc(32, 8).toString('base64'), recoveryKey: RKEY }).unwrap(w.wrapped, w.keyId, ctx));
    await assert.rejects(kms.unwrap(w.wrapped, 'other-key', ctx), /key/i);
  });

  it('each DEK and IV is fresh', () => {
    assert.notDeepEqual(generateDek(), generateDek());
  });

  it('stream-encrypts with AES-256-GCM; the ciphertext differs from the plaintext and round-trips', async () => {
    const dek = generateDek();
    const plain = Buffer.concat([Buffer.from('%PDF-1.7 '), Buffer.alloc(3 * 1024 * 1024, 0x41)]);
    const enc = createEncryptStream(dek);
    const cipher = await collect(Readable.from([plain.subarray(0, 1000), plain.subarray(1000)]).pipe(enc.stream));
    assert.equal(cipher.length, plain.length, 'GCM adds no padding');
    assert.ok(!cipher.subarray(0, 9).equals(plain.subarray(0, 9)));
    const { iv, authTag } = enc.result();
    assert.equal(iv.length, 12);
    assert.equal(authTag.length, 16);
    const out = await collect(Readable.from([cipher]).pipe(createDecryptStream(dek, iv, authTag)));
    assert.ok(out.equals(plain));
  });

  it('detects tampering and a wrong key', async () => {
    const dek = generateDek();
    const enc = createEncryptStream(dek);
    const cipher = await collect(Readable.from([Buffer.from('secret contract text')]).pipe(enc.stream));
    const { iv, authTag } = enc.result();
    const bad = Buffer.from(cipher);
    bad[3]! ^= 0xff;
    await assert.rejects(pipeline(Readable.from([bad]), createDecryptStream(dek, iv, authTag), async function* (src) { for await (const _ of src) void _; }));
    await assert.rejects(pipeline(Readable.from([cipher]), createDecryptStream(generateDek(), iv, authTag), async function* (src) { for await (const _ of src) void _; }));
  });

  it('refuses a missing or short key, and the local KMS in production', () => {
    assert.throws(() => new LocalKeyProvider({ dataKey: Buffer.alloc(16).toString('base64'), recoveryKey: RKEY }), /32 bytes/);
    assert.throws(() => keyProviderFromEnv({ DOCUMENT_KMS_PROVIDER: 'local' }), /DOCUMENT_KMS_LOCAL_KEY/);
    assert.throws(() => keyProviderFromEnv({ NODE_ENV: 'production', DOCUMENT_KMS_PROVIDER: 'local', DOCUMENT_KMS_LOCAL_KEY: KEY, DOCUMENT_KMS_RECOVERY_KEY: RKEY }), /production/);
    assert.ok(keyProviderFromEnv({ DOCUMENT_KMS_PROVIDER: 'local', DOCUMENT_KMS_LOCAL_KEY: KEY, DOCUMENT_KMS_RECOVERY_KEY: RKEY }) instanceof LocalKeyProvider);
  });
});

function zip(names: string[]): Buffer {
  // Minimal valid ZIP with deflated empty entries: local headers + central directory + EOCD.
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const n = Buffer.from(name);
    const data = deflateRawSync(Buffer.alloc(0));
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe('Content sniffing (FR-DOC-001)', () => {
  const head = (b: Buffer) => b.subarray(0, 4096);

  it('recognises the allow-listed types by their bytes', () => {
    assert.equal(sniff(Buffer.from('%PDF-1.4\n...'), null).kind, 'pdf');
    assert.equal(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), null).kind, 'png');
    assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), null).kind, 'jpeg');
    assert.equal(sniff(Buffer.from('GIF89a......'), null).kind, 'gif');
    assert.equal(sniff(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 '), null).kind, 'webp');
    assert.equal(sniff(Buffer.from('Plain notes, ünïcödé ok.\nLine 2'), null).kind, 'txt');
  });

  it('looks inside ZIP containers to tell DOCX, XLSX and PPTX from a plain ZIP', () => {
    const docx = zip(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
    assert.deepEqual(parseZipEntries(docx).slice(0, 3), ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
    assert.equal(sniff(head(docx), parseZipEntries(docx)).kind, 'docx');
    assert.equal(sniff(head(zip(['[Content_Types].xml', 'xl/workbook.xml'])), ['[Content_Types].xml', 'xl/workbook.xml']).kind, 'xlsx');
    assert.equal(sniff(head(zip(['[Content_Types].xml', 'ppt/presentation.xml'])), ['[Content_Types].xml', 'ppt/presentation.xml']).kind, 'pptx');
    assert.equal(sniff(head(zip(['a.txt'])), ['a.txt']).kind, 'zip');
  });

  it('refuses macro-enabled Office files, executables, HTML/SVG and binary junk', () => {
    const r = sniff(Buffer.from('PK\x03\x04'), ['[Content_Types].xml', 'word/document.xml', 'word/vbaProject.bin']);
    assert.equal(r.kind, null);
    assert.match(r.reason ?? '', /macro/i);
    assert.equal(sniff(Buffer.from('MZ\x90\x00\x03'), null).kind, null);
    assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), null).kind, null);
    assert.equal(sniff(Buffer.from('<!DOCTYPE html><html><script>x</script>'), null).kind, null);
    assert.equal(sniff(Buffer.from([0x00, 0x01, 0x02, 0xfe]), null).kind, null);
    assert.equal(sniff(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), null).kind, null, 'legacy OLE .doc/.xls');
  });

  it('the extension must match the content; the browser MIME type is never used', () => {
    assert.equal(checkExtension('contract.pdf', 'pdf'), null);
    assert.equal(checkExtension('photo.JPG', 'jpeg'), null);
    assert.equal(checkExtension('photo.jpeg', 'jpeg'), null);
    assert.match(checkExtension('invoice.pdf', 'docx') ?? '', /does not match/);
    assert.match(checkExtension('evil.exe', 'pdf') ?? '', /not allowed/);
    assert.match(checkExtension('noextension', 'pdf') ?? '', /extension/);
    assert.equal(checkExtension('notes.txt', 'txt'), null);
    assert.match(checkExtension('report.pdf', 'pdf', ['png']) ?? '', /not allowed/, 'the allow-list is configurable');
  });
});

describe('clamd INSTREAM protocol (FR-DOC-013)', () => {
  async function fakeClamd(reply: (received: Buffer) => string): Promise<{ port: number; close: () => void; received: () => Buffer }> {
    let got = Buffer.alloc(0);
    const server = net.createServer((sock) => {
      sock.on('data', (d) => {
        got = Buffer.concat([got, Buffer.from(d)]);
        // Terminated by a zero-length chunk after the command.
        if (got.length >= 14 && got.subarray(-4).readUInt32BE(0) === 0) {
          sock.end(reply(got));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { port: (server.address() as net.AddressInfo).port, close: () => server.close(), received: () => got };
  }

  it('sends zINSTREAM with length-prefixed chunks and reads OK', async () => {
    const srv = await fakeClamd(() => 'stream: OK\0');
    try {
      const r = await scanStream(Readable.from([Buffer.from('hello'), Buffer.from(' world')]), { host: '127.0.0.1', port: srv.port, timeoutMs: 2000 });
      assert.deepEqual(r, { status: 'CLEAN' });
      const got = srv.received();
      assert.equal(got.subarray(0, 10).toString(), 'zINSTREAM\0');
      assert.equal(got.readUInt32BE(10), 5);
      assert.equal(got.subarray(14, 19).toString(), 'hello');
    } finally {
      srv.close();
    }
  });

  it('reports FOUND with the signature name, and errors as errors (never as clean)', async () => {
    const found = await fakeClamd(() => 'stream: Eicar-Test-Signature FOUND\0');
    try {
      assert.deepEqual(await scanStream(Readable.from([Buffer.from('x')]), { host: '127.0.0.1', port: found.port, timeoutMs: 2000 }), { status: 'INFECTED', signature: 'Eicar-Test-Signature' });
    } finally {
      found.close();
    }
    const err = await fakeClamd(() => 'INSTREAM size limit exceeded. ERROR\0');
    try {
      await assert.rejects(scanStream(Readable.from([Buffer.from('x')]), { host: '127.0.0.1', port: err.port, timeoutMs: 2000 }), /size limit/);
    } finally {
      err.close();
    }
    await assert.rejects(scanStream(Readable.from([Buffer.from('x')]), { host: '127.0.0.1', port: 1, timeoutMs: 500 }));
  });
});

describe('Document permission (FR-DOC-009)', () => {
  it('HR and the owner manage; the linked person may view and download; ACL grants add up', () => {
    assert.equal(effectiveLevel({ isHr: true, isOwner: false, isLinked: false, aclLevel: 0 }), 4);
    assert.equal(effectiveLevel({ isHr: false, isOwner: true, isLinked: false, aclLevel: 0 }), 4);
    assert.equal(effectiveLevel({ isHr: false, isOwner: false, isLinked: true, aclLevel: 0 }), 2);
    assert.equal(effectiveLevel({ isHr: false, isOwner: false, isLinked: true, aclLevel: 3 }), 3);
    assert.equal(effectiveLevel({ isHr: false, isOwner: false, isLinked: false, aclLevel: 1 }), 1);
    assert.equal(effectiveLevel({ isHr: false, isOwner: false, isLinked: false, aclLevel: 0 }), 0);
  });

  it('maps levels to abilities; the original file needs DOWNLOAD; nothing opens until it is clean', () => {
    const f = { previewable: true, watermarkable: true };
    assert.deepEqual(documentAbilities(1, 'CLEAN', f), { canView: true, canPreview: false, canViewOnly: true, canDownload: false, canEdit: false, canManage: false });
    assert.deepEqual(documentAbilities(2, 'CLEAN', f), { canView: true, canPreview: true, canViewOnly: true, canDownload: true, canEdit: false, canManage: false });
    assert.deepEqual(documentAbilities(4, 'PENDING', f), { canView: true, canPreview: false, canViewOnly: false, canDownload: false, canEdit: true, canManage: true });
    assert.deepEqual(documentAbilities(4, null, f), { canView: true, canPreview: false, canViewOnly: false, canDownload: false, canEdit: true, canManage: true });
    assert.deepEqual(documentAbilities(0, 'CLEAN', f), { canView: false, canPreview: false, canViewOnly: false, canDownload: false, canEdit: false, canManage: false });
    assert.equal(documentAbilities(1, 'CLEAN', { previewable: false, watermarkable: false }).canViewOnly, false, 'a text file cannot be stamped');
  });
});
