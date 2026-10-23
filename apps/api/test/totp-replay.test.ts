/**
 * FR-AUTH-004: a 2FA code works once. With the one-step clock-drift tolerance a code stays
 * acceptable for about 90 seconds, so the server remembers the newest time step each person has
 * used and refuses that step and any earlier one (RFC 6238 §5.2).
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { generateSecret, generateSync } from 'otplib';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';

const ORG = '7e7e0000-0000-4000-8000-000000000001';
const USER = '7e7e0000-0000-4000-8000-000000000011';
const PASSWORD = 'Replay-Passw0rd!xyz';

describe('2FA codes cannot be replayed (FR-AUTH-004)', { concurrency: false }, () => {
  let app: INestApplication;
  let admin: pg.Pool;
  const secret = generateSecret();
  const base = 'http://localhost:3043';
  const nowSec = () => Math.floor(Date.now() / 1000);
  const code = (offsetSeconds = 0) => generateSync({ secret, epoch: nowSec() + offsetSeconds });
  const login = async (totpCode: string) => {
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'r@replay2fa.test', password: PASSWORD, totpCode }) });
    return res.status;
  };
  const resetLockout = () => admin.query(`UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`, [USER]);

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    const pgBase = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev' };
    admin = new pg.Pool({ ...pgBase, user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await admin.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await admin.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Replay 2FA Ltd', 'totp-replay', 'Asia/Colombo')`, [ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    await admin.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status, mfa_enabled, mfa_secret) VALUES ($1, $2, 'r@replay2fa.test', 'R', 'HR', $3, 'ACTIVE', true, $4)`, [USER, ORG, hash, secret]);
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(3043);
  });

  after(async () => {
    await app?.close();
    await admin.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await admin.end();
  });

  it('a code signs in once; the same code a second time is refused', async () => {
    const c = code();
    assert.equal(await login(c), 200);
    assert.equal(await login(c), 401, 'replayed');
    await resetLockout();
  });

  it('an earlier code from the drift window is refused after a later one was used', async () => {
    const earlier = code(-30);
    const later = code(30);
    assert.equal(await login(later), 200);
    assert.equal(await login(earlier), 401, 'older step than the newest used');
    await resetLockout();
  });

  it('a newer step still works (drift tolerance is intact)', async () => {
    await admin.query(`UPDATE users SET mfa_last_used_step = NULL WHERE id = $1`, [USER]);
    assert.equal(await login(code(-30)), 200);
    assert.equal(await login(code()), 200, 'the next step is accepted');
    await resetLockout();
  });

  it('two simultaneous sign-ins with the same fresh code: exactly one wins', async () => {
    await admin.query(`UPDATE users SET mfa_last_used_step = NULL WHERE id = $1`, [USER]);
    const c = code();
    const results = await Promise.all([login(c), login(c), login(c)]);
    assert.equal(results.filter((s) => s === 200).length, 1, JSON.stringify(results));
    await resetLockout();
  });
});
