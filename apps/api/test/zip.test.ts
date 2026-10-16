/** The hand-written ZIP writer behind data-subject exports (FR-AUD-002, ADR 014). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildZip, readZip } from '../src/privacy/zip.ts';

describe('ZIP writer', () => {
  it('round-trips text and binary entries with correct CRCs and sizes', () => {
    const big = Buffer.alloc(50_000, 'a'); // compressible
    const random = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7919) % 256)); // not compressible: stored
    const zip = buildZip([
      { name: 'README.txt', data: 'hello, world' },
      { name: 'dir/data.json', data: JSON.stringify({ a: 1, name: 'Zoë' }) },
      { name: 'big.txt', data: big },
      { name: 'random.bin', data: random },
    ]);
    assert.equal(zip.readUInt32LE(0), 0x04034b50, 'local file header signature');
    assert.ok(zip.length < 10_000, 'deflate compressed the repetitive entry');
    const back = readZip(zip);
    assert.deepEqual(back.map((e) => e.name), ['README.txt', 'dir/data.json', 'big.txt', 'random.bin']);
    assert.equal(back[0]!.data.toString(), 'hello, world');
    assert.equal(JSON.parse(back[1]!.data.toString()).name, 'Zoë');
    assert.ok(back[2]!.data.equals(big));
    assert.ok(back[3]!.data.equals(random));
  });

  it('refuses duplicate names and neutralises path tricks', () => {
    assert.throws(() => buildZip([{ name: 'a.txt', data: 'x' }, { name: 'a.txt', data: 'y' }]), /Duplicate/);
    const zip = buildZip([{ name: '/../../etc/passwd', data: 'x' }]);
    assert.equal(readZip(zip)[0]!.name, '_/_/etc/passwd');
  });

  it('writes an empty archive that still has an end record', () => {
    const zip = buildZip([]);
    assert.equal(zip.length, 22);
    assert.deepEqual(readZip(zip), []);
  });
});
