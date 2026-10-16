/**
 * Minimal ZIP writer on node:zlib (FR-AUD-002 export archives). Deflate entries, CRC-32,
 * local headers and a central directory; no ZIP64, no encryption. Decided with the product
 * owner instead of adding an archive package. Pure and unit-tested.
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer | string;
  modified?: Date;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const VERSION = 20; // 2.0: deflate
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** MS-DOS date/time pair (local time, 2-second resolution), the only format classic ZIP has. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function safeName(name: string): string {
  const cleaned = name.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\.(\/|$)/g, '_$1');
  if (!cleaned) throw new Error('Empty entry name');
  return cleaned;
}

export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    const name = safeName(e.name);
    if (seen.has(name)) throw new Error(`Duplicate entry ${name}`);
    seen.add(name);
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data;
    const deflated = deflateRawSync(raw, { level: 6 });
    const method = deflated.length < raw.length ? METHOD_DEFLATE : METHOD_STORE;
    const body = method === METHOD_DEFLATE ? deflated : raw;
    const crc = crc32(raw) >>> 0;
    const { time, date } = dosDateTime(e.modified ?? new Date());

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(VERSION, 4); // version made by
    central.writeUInt16LE(VERSION, 6); // version needed
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
    if (offset > 0xffffffff) throw new Error('Archive too large for ZIP (no ZIP64)');
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** Reads back an archive written by buildZip (for tests): names and inflated contents. */
export function readZip(zip: Buffer): Array<{ name: string; data: Buffer }> {
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('Not a ZIP archive');
  const count = zip.readUInt16LE(endAt + 10);
  let p = zip.readUInt32LE(endAt + 16);
  const out: Array<{ name: string; data: Buffer }> = [];
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('Bad central directory');
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const compressed = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localAt = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = zip.readUInt16LE(localAt + 26);
    const lExtraLen = zip.readUInt16LE(localAt + 28);
    const start = localAt + 30 + lNameLen + lExtraLen;
    const body = zip.subarray(start, start + compressed);
    const data = method === METHOD_DEFLATE ? inflateRawSync(body) : Buffer.from(body);
    if ((crc32(data) >>> 0) !== crc) throw new Error(`CRC mismatch in ${name}`);
    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
