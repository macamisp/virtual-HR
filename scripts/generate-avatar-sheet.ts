/**
 * Writes the office character spritesheet (ADR 053) from its source, packages/shared/src/office/avatar-art.ts.
 *
 *   node --experimental-strip-types scripts/generate-avatar-sheet.ts            # docs/assets/office-avatars/avatars.png
 *   node --experimental-strip-types scripts/generate-avatar-sheet.ts out.png 8  # any path, scaled 8x (nearest neighbour)
 *
 * Layout: one row per preset (AVATAR_KEYS order), 12 columns of 32 x 32 frames: down, left, right,
 * up, each idle / step A / step B. Transparent background. No dependencies beyond node:zlib.
 * The renderer draws the same pixels straight from avatar-art.ts; a test fails if this file is stale.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { renderAvatarSheet } from '../packages/shared/src/office/avatar-art.ts';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A deterministic RGBA PNG (8-bit, no interlace, filter 0 on every row). */
export function encodePng(width: number, height: number, rgba: Uint8ClampedArray, scale = 1): Buffer {
  const w = width * scale;
  const h = height * scale;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * (w * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x += 1) {
      const s = ((Math.floor(y / scale) * width) + Math.floor(x / scale)) * 4;
      rgba.subarray(s, s + 4).forEach((v, i) => { raw[row + 1 + x * 4 + i] = v; });
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

export const SHEET_PATH = 'docs/assets/office-avatars/avatars.png';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = resolve(process.argv[2] ?? SHEET_PATH);
  const scale = Math.max(1, Math.min(16, Number(process.argv[3] ?? 1) | 0));
  const sheet = renderAvatarSheet();
  writeFileSync(out, encodePng(sheet.width, sheet.height, sheet.data, scale));
  console.log(`wrote ${out} (${sheet.width * scale} x ${sheet.height * scale})`);
}
