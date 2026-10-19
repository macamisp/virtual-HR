/**
 * Internet demo safety (docs/runbooks/demo-internet.md): the local seed with its published
 * password refuses whenever an address is public; the internet seed refuses development-only
 * settings, generates strong passwords per run, prints each once and stores only hashes, keeps
 * 2FA pending for HR and admins; the teardown deletes the demo organisation. The scripts run as
 * child processes against the local test database only.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import pg from 'pg';
import argon2 from 'argon2';
import { assertDefaultPasswordsStayLocal, assertInternetDemoSafe, isLocalUrl, publicUrls, strongPassword } from './support/demo-guard.ts';
import { INTERNET_DEMO_ORG_ID } from './support/internet-demo.ts';

// The .ts sources run as scripts (npm run seed:demo:*), so locate them from the repository root.
const here = dirname(fileURLToPath(import.meta.url));
const root = [join(here, '..', '..', '..'), join(here, '..', '..', '..', '..')].find((d) => existsSync(join(d, 'apps/api/test/seed-internet-demo.ts')))!;
const SAFE = {
  APP_WEB_URL: 'https://app.demo.example.com', CORS_ORIGINS: 'https://app.demo.example.com', NEXT_PUBLIC_API_URL: 'https://api.demo.example.com',
  NEXT_PUBLIC_STORAGE_URL: 'https://files.demo.example.com', S3_PUBLIC_ENDPOINT: 'https://files.demo.example.com', S3_SECRET_KEY: 'x'.repeat(48),
  JWT_SECRET: 'j'.repeat(64), LIVEKIT_API_SECRET: 'cloud-secret-0123456789abcdef0123456789', AUTH_MFA_ENFORCEMENT: '', BREACHED_PASSWORD_CHECK: '',
};
function run(script: string, env: Record<string, string>) {
  const base = { PATH: process.env.PATH ?? '', PGHOST: process.env.PGHOST ?? 'localhost', PGPORT: process.env.PGPORT ?? '5433', PGDATABASE: process.env.PGDATABASE ?? 'hrvo_dev',
    PGADMIN_USER: process.env.PGADMIN_USER ?? 'postgres', PGADMIN_PASSWORD: process.env.PGADMIN_PASSWORD ?? 'postgres', NODE_ENV: 'development' };
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(root, 'apps/api/test', script)], { cwd: root, env: { ...base, ...env }, encoding: 'utf8', timeout: 60_000 });
}

describe('Demo seed guards (internet demo)', () => {
  const adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
  after(async () => {
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [INTERNET_DEMO_ORG_ID]);
    await adminPool.end();
  });

  it('tells local addresses from public ones', () => {
    for (const u of ['http://localhost:3000', 'http://127.0.0.1:3001', 'http://[::1]:3000', 'http://app.localhost']) assert.equal(isLocalUrl(u), true, u);
    for (const u of ['https://abc.trycloudflare.com', 'http://192.168.1.20:3000', 'https://app.example.com', 'not a url']) assert.equal(isLocalUrl(u), false, u);
    assert.deepEqual(publicUrls({ APP_WEB_URL: 'http://localhost:3000', CORS_ORIGINS: 'http://localhost:3000, https://x.trycloudflare.com' }), ['https://x.trycloudflare.com']);
  });

  it('the default-password seed refuses as soon as any address is public', () => {
    assert.doesNotThrow(() => assertDefaultPasswordsStayLocal({ APP_WEB_URL: 'http://localhost:3000', CORS_ORIGINS: 'http://localhost:3000', NEXT_PUBLIC_API_URL: 'http://localhost:3001' }));
    for (const env of [{ APP_WEB_URL: 'https://app.example.com' }, { CORS_ORIGINS: 'http://localhost:3000,https://a.trycloudflare.com' }, { NEXT_PUBLIC_API_URL: 'https://api.example.com' }, { DEMO_PUBLIC_URL: 'https://demo.example.com' }, { S3_PUBLIC_ENDPOINT: 'https://files.example.com' }]) {
      assert.throws(() => assertDefaultPasswordsStayLocal(env), /Refusing to seed the default demo passwords/, JSON.stringify(env));
    }
  });

  it('the real local seed script refuses with a public URL and creates nothing', async () => {
    const res = run('seed-web-demo.ts', { APP_WEB_URL: 'https://app.demo.example.com' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Refusing to seed the default demo passwords.*app\.demo\.example\.com/);
    assert.doesNotMatch(res.stdout, /DemoPassword/);
  });

  it('the internet seed refuses development-only settings, naming each', () => {
    assert.doesNotThrow(() => assertInternetDemoSafe(SAFE));
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ AUTH_MFA_ENFORCEMENT: 'off' }, /AUTH_MFA_ENFORCEMENT=off/],
      [{ JWT_SECRET: 'super-secret-jwt-access-key-change-in-production-min-32-chars' }, /JWT_SECRET/],
      [{ JWT_SECRET: 'short' }, /JWT_SECRET/],
      [{ LIVEKIT_API_SECRET: 'hrvo-dev-secret' }, /LIVEKIT_API_SECRET/],
      [{ BREACHED_PASSWORD_CHECK: 'local' }, /BREACHED_PASSWORD_CHECK/],
      [{ S3_SECRET_KEY: 'hrvo-ci-only-secret' }, /S3_SECRET_KEY/],
      [{ NEXT_PUBLIC_API_URL: 'http://api.demo.example.com' }, /https:\/\//],
    ];
    for (const [patch, message] of cases) assert.throws(() => assertInternetDemoSafe({ ...SAFE, ...patch }), message, JSON.stringify(patch));
    const res = run('seed-internet-demo.ts', { ...SAFE, AUTH_MFA_ENFORCEMENT: 'off' });
    assert.equal(res.status, 1, 'the script itself refuses');
    assert.match(res.stderr, /AUTH_MFA_ENFORCEMENT=off/);
  });

  it('passwords are long, mixed, unambiguous and never repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const p = strongPassword(20);
      assert.equal(p.length, 20);
      assert.match(p, /[a-z]/); assert.match(p, /[A-Z]/); assert.match(p, /[2-9]/); assert.match(p, /[!#%+\-=?@^_~]/);
      assert.doesNotMatch(p, /[lIO01]/, 'no look-alike characters');
      seen.add(p);
    }
    assert.equal(seen.size, 500);
    assert.throws(() => strongPassword(8));
  });

  it('seeds with new passwords printed once, stores only Argon2id hashes, keeps 2FA pending for HR and admin; teardown deletes it', async () => {
    const first = run('seed-internet-demo.ts', SAFE);
    assert.equal(first.status, 0, first.stderr);
    const printed = [...first.stdout.matchAll(/^\s+(\S+)\s+(\S+@internet\.demo)\s+(\S+)/gm)].map((m) => ({ role: m[1]!, email: m[2]!, password: m[3]! }));
    assert.equal(printed.length, 5);
    for (const p of printed) assert.equal(first.stdout.split(p.password).length - 1, 1, `${p.email}'s password is printed exactly once`);
    const rows = (await adminPool.query<{ email: string; password_hash: string; mfa_enabled: boolean; role: string }>(`SELECT email, password_hash, mfa_enabled, role FROM users WHERE org_id = $1`, [INTERNET_DEMO_ORG_ID])).rows;
    assert.equal(rows.length, 5);
    for (const r of rows) {
      const p = printed.find((x) => x.email === r.email)!;
      assert.match(r.password_hash, /^\$argon2id\$/);
      assert.equal(r.password_hash.includes(p.password), false);
      assert.equal(await argon2.verify(r.password_hash, p.password), true);
      assert.equal(r.mfa_enabled, false, 'HR and admins enrol 2FA at first sign-in; enforcement stays on');
    }
    assert.match(first.stdout, /HR\s+hr@internet\.demo\s+\S+\s+\(2FA enrolment at first sign-in\)/);
    assert.match(first.stdout, /Shut the demo down/);
    const second = run('seed-internet-demo.ts', SAFE);
    const again = [...second.stdout.matchAll(/^\s+\S+\s+(\S+@internet\.demo)\s+(\S+)/gm)].map((m) => m[2]!);
    assert.equal(again.filter((p) => printed.some((x) => x.password === p)).length, 0, 'every run makes new passwords');
    const down = run('teardown-internet-demo.ts', {});
    assert.equal(down.status, 0, down.stderr);
    assert.match(down.stdout, /Deleted the internet demo organisation \(5 users/);
    assert.equal((await adminPool.query(`SELECT 1 FROM organizations WHERE id = $1`, [INTERNET_DEMO_ORG_ID])).rowCount, 0);
    assert.match(run('teardown-internet-demo.ts', {}).stdout, /nothing to delete/);
  });
});
