/**
 * Demo/seed scripts must refuse to run against production (AGENTS.md safety rules).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const scripts: Array<{ name: string; args: string[] }> = [
  { name: 'demo.ts (attendance demo)', args: ['--experimental-strip-types', path.join(root, 'apps/api/test/demo.ts')] },
  { name: 'demo-shell (app shell demo, compiled)', args: [path.join(root, 'dist/apps/api/test/demo-shell.js')] },
];

describe('Demo seeds refuse NODE_ENV=production', () => {
  for (const s of scripts) {
    it(s.name, () => {
      const result = spawnSync(process.execPath, s.args, {
        env: { ...process.env, NODE_ENV: 'production', PGHOST: '127.0.0.1', PGPORT: '1' },
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Refusing to run demo\/seed script with NODE_ENV=production/);
    });
  }
});
