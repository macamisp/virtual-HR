/**
 * Test files run four at a time; two that listen on the same port fail with EADDRINUSE whenever
 * the runner happens to schedule them together (CI run 39883915383: totp-replay and vault-e2e on
 * 3097). Every port a test file binds must belong to that file alone.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('Test ports', () => {
  it('no two API test files listen on the same port', () => {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (!statSync(join(dir, 'apps', 'api', 'test'), { throwIfNoEntry: false })) {
      const up = dirname(dir);
      assert.notEqual(up, dir, 'repository root not found');
      dir = up;
    }
    const testDir = join(dir, 'apps', 'api', 'test');
    const owners = new Map<string, Set<string>>();
    for (const name of readdirSync(testDir).filter((n) => n.endsWith('.test.ts'))) {
      const src = readFileSync(join(testDir, name), 'utf8');
      const ports = [
        ...src.matchAll(/\bconst\s+\w*PORT\w*\s*=\s*(\d{4,5})\b/g),
        ...src.matchAll(/\.listen\((\d{4,5})\)/g),
        ...src.matchAll(/localhost:(\d{4,5})/g),
      ].map((m) => m[1]!);
      for (const p of new Set(ports)) owners.set(p, (owners.get(p) ?? new Set()).add(name));
    }
    const shared = [...owners].filter(([, files]) => files.size > 1).map(([p, files]) => `${p}: ${[...files].sort().join(', ')}`);
    assert.deepEqual(shared, [], 'give each test file its own ports');
  });
});
