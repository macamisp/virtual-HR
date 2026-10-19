#!/usr/bin/env node
/**
 * First-time local setup (docs/runbooks/web-local.md, step 1): creates .env from .env.example if it
 * does not exist, fills the two document-encryption keys if they are empty, and generates the
 * Prisma client. Safe to run again: it never overwrites a value you have set. Dependencies: none.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const log = (m) => console.log(`setup: ${m}`);

if (!existsSync(envPath)) {
  copyFileSync(join(root, '.env.example'), envPath);
  log('created .env from .env.example');
} else {
  log('.env already exists; keeping it');
}

let env = readFileSync(envPath, 'utf8');
for (const name of ['DOCUMENT_KMS_LOCAL_KEY', 'DOCUMENT_KMS_RECOVERY_KEY']) {
  const line = new RegExp(`^${name}=(.*)$`, 'm');
  const match = env.match(line);
  if (match && match[1].trim() === '') {
    env = env.replace(line, `${name}=${randomBytes(32).toString('base64')}`);
    log(`generated ${name} (32 random bytes; keep it: documents are encrypted with it)`);
  } else if (!match) {
    env += `\n${name}=${randomBytes(32).toString('base64')}\n`;
    log(`added ${name}`);
  }
}
writeFileSync(envPath, env, { mode: 0o600 });

const generate = spawnSync('npm', ['run', '-s', 'db:generate'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
if (generate.status !== 0) {
  console.error('setup: "npm run db:generate" failed. Run "npm install" first.');
  process.exit(generate.status ?? 1);
}
log('Prisma client generated.');
log('Next: npm run db:migrate && npm run db:provision-roles && npm run seed:demo, then npm run api and npm run web.');
