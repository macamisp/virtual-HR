/**
 * FR-DOC-012 / AC-11: a refused look at a document is "denied and logged". The caller still gets
 * the plain 404 (or 403) that gives nothing away; the attempt is written to the document access
 * log with who, from where, and which document id was asked for.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';

const ORG = 'de1e0000-0000-4000-8000-000000000001';
const U = {
  hr: 'de1e0000-0000-4000-8000-000000000011',
  owner: 'de1e0000-0000-4000-8000-000000000012',
  snoop: 'de1e0000-0000-4000-8000-000000000013',
};
const DOC = 'de1e0000-0000-4000-8000-0000000000d1';
const MISSING = 'de1e0000-0000-4000-8000-0000000000ff';
const PASSWORD = 'DeniedLog-Passw0rd!x';

describe('Refused document access is logged (AC-11)', { concurrency: false }, () => {
  let app: INestApplication;
  let admin: pg.Pool;
  let token = '';
  const base = 'http://localhost:3096';
  const denied = async (documentId: string) =>
    (await admin.query<{ user_id: string | null; ip: string | null; detail: { requestedId?: string; method?: string; status?: number } | null }>(
      `SELECT user_id, ip, detail FROM document_access_logs WHERE org_id = $1 AND action = 'ACCESS_DENIED' AND (document_id = $2 OR detail->>'requestedId' = $2::text) ORDER BY id`, [ORG, documentId])).rows;

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    const pgBase = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev' };
    admin = new pg.Pool({ ...pgBase, user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await admin.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await admin.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Denied Ltd', 'docs-denied-log', 'Asia/Colombo')`, [ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const [k, id] of Object.entries(U)) {
      await admin.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')`,
        [id, ORG, `${k}@denied.test`, k, k === 'hr' ? 'HR' : 'EMPLOYEE', hash]);
    }
    await admin.query(`INSERT INTO documents (id, org_id, title, category, confidentiality, owner_id) VALUES ($1, $2, 'Salary letter', 'OTHER', 'NORMAL', $3)`, [DOC, ORG, U.owner]);
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(3096);
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'snoop@denied.test', password: PASSWORD }) });
    token = ((await res.json()) as { accessToken?: string }).accessToken ?? '';
    assert.ok(token, 'login');
  });

  after(async () => {
    await app?.close();
    await admin.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await admin.end();
  });

  const get = (path: string) => fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });

  it('a colleague who opens a document they may not see gets a plain 404, and the attempt is logged', async () => {
    const res = await get(`/documents/${DOC}`);
    assert.equal(res.status, 404);
    assert.match(JSON.stringify(await res.json()), /Document not found/, 'the answer gives nothing away');
    const rows = await denied(DOC);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.user_id, U.snoop);
    assert.ok(rows[0]!.ip, 'from where');
    assert.equal(rows[0]!.detail?.method, 'GET');
  });

  it('an id that does not exist looks the same to the caller and is logged with the requested id', async () => {
    const res = await get(`/documents/${MISSING}`);
    assert.equal(res.status, 404);
    const rows = await denied(MISSING);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.user_id, U.snoop);
  });

  it('the owner reading their own document is not logged as a denial', async () => {
    const before = (await denied(DOC)).length;
    await admin.query(`UPDATE documents SET owner_id = $1 WHERE id = $2`, [U.snoop, DOC]);
    const res = await get(`/documents/${DOC}`);
    await admin.query(`UPDATE documents SET owner_id = $1 WHERE id = $2`, [U.owner, DOC]);
    assert.notEqual(res.status, 404);
    assert.equal((await denied(DOC)).length, before);
  });
});
