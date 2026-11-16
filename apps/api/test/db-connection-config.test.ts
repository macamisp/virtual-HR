/**
 * Database connection settings for AWS (ADR 020): the Prisma URL and the pg pool are built from
 * PG* variables (the password injected from Secrets Manager), with verified TLS to RDS.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { databaseUrl, poolConfig, poolMax } from '../src/common/db-config.ts';
import { PostgresAttendanceRepository } from '../src/attendance/attendance-repository.ts';
import { PrismaService } from '../src/common/prisma.service.ts';

const base = { PGHOST: 'db.internal', PGPORT: '5432', PGDATABASE: 'hrvo', PGUSER: 'hrvo_app', PGPASSWORD: 'p@ss:w/rd#1' };

describe('database connection config', () => {
  it('DATABASE_URL wins when set (local development, tests)', () => {
    assert.equal(databaseUrl({ DATABASE_URL: 'postgresql://x:y@h:1/d' }), 'postgresql://x:y@h:1/d');
  });

  it('builds the URL from PG* with the password URL-encoded', () => {
    const u = new URL(databaseUrl(base));
    assert.equal(u.hostname, 'db.internal');
    assert.equal(decodeURIComponent(u.password), 'p@ss:w/rd#1');
    assert.equal(u.searchParams.get('schema'), 'public');
    assert.equal(u.searchParams.get('sslmode'), null, 'no TLS parameters unless asked');
  });

  it('verify-full: Prisma verifies the server against the CA bundle; the pool does too', () => {
    const ca = join(tmpdir(), `rds-ca-${process.pid}.pem`);
    writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nMIIBtest\n-----END CERTIFICATE-----\n');
    const env = { ...base, PGSSLMODE: 'verify-full', PGSSLROOTCERT: ca };
    const u = new URL(databaseUrl(env));
    assert.equal(u.searchParams.get('sslmode'), 'require');
    assert.equal(u.searchParams.get('sslaccept'), 'strict');
    assert.equal(u.searchParams.get('sslcert'), ca);
    const p = poolConfig(env);
    assert.equal(p.password, 'p@ss:w/rd#1');
    assert.ok(p.ssl && typeof p.ssl === 'object' && p.ssl.rejectUnauthorized === true && String(p.ssl.ca).includes('BEGIN CERTIFICATE'));
  });

  it('verify-full without a CA bundle is a configuration error, not a silent downgrade', () => {
    assert.throws(() => poolConfig({ ...base, PGSSLMODE: 'verify-full' }), /PGSSLROOTCERT/);
  });

  it('connection caps for a session-mode pooler are opt-in and validated (ADR 052)', () => {
    assert.equal(new URL(databaseUrl(base)).searchParams.get('connection_limit'), null, 'no cap unless asked');
    assert.equal(new URL(databaseUrl({ ...base, PRISMA_CONNECTION_LIMIT: '4' })).searchParams.get('connection_limit'), '4');
    for (const bad of ['0', '-1', 'abc', '4.5', '1000', ' ']) {
      assert.equal(new URL(databaseUrl({ ...base, PRISMA_CONNECTION_LIMIT: bad })).searchParams.get('connection_limit'), null, bad);
      assert.equal(poolMax({ PG_POOL_MAX: bad }), undefined, bad);
    }
    assert.equal(poolMax({ PG_POOL_MAX: '4' }), 4);
    assert.equal(poolMax({}), undefined);
  });

  it('without PG* settings the local defaults apply', () => {
    assert.equal(poolConfig({}).host, 'localhost');
    assert.equal(poolConfig({}).ssl, undefined);
  });

  // Regression (ADR 046): the attendance repository built its own pools from PG* without the CA,
  // so with PGSSLMODE=verify-full every attendance query failed "unable to verify the first certificate".
  it('the attendance pools (app, admin, retention) verify the server against the same CA', async () => {
    const ca = join(tmpdir(), `db-ca-${process.pid}.pem`);
    writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nMIIBtest\n-----END CERTIFICATE-----\n');
    const env = { ...base, PGSSLMODE: 'verify-full', PGSSLROOTCERT: ca, PGRETENTION_PASSWORD: 'r', PGADMIN_USER: 'admin', PGADMIN_PASSWORD: 'a' };
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    const repo = new PostgresAttendanceRepository();
    try {
      const pools: Array<[string, pg.Pool, string]> = [['app', repo.getPool(), 'hrvo_app'], ['admin', repo.getAdminPool(), 'admin'], ['retention', repo.getRetentionPool(), 'hrvo_retention']];
      for (const [name, pool, user] of pools) {
        const o = (pool as unknown as { options: pg.PoolConfig }).options;
        assert.equal(o.host, 'db.internal', name);
        assert.equal(o.user, user, name);
        assert.ok(o.ssl && typeof o.ssl === 'object' && o.ssl.rejectUnauthorized === true && String(o.ssl.ca).includes('BEGIN CERTIFICATE'), `${name} pool verifies TLS with the CA`);
      }
    } finally {
      await repo.close();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('PG_POOL_MAX caps all three attendance pools; unset keeps the pg default', async () => {
    const env = { ...base, PG_POOL_MAX: '3', PGRETENTION_PASSWORD: 'r' };
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    const capped = new PostgresAttendanceRepository();
    delete process.env.PG_POOL_MAX;
    const uncapped = new PostgresAttendanceRepository();
    try {
      for (const pool of [capped.getPool(), capped.getAdminPool(), capped.getRetentionPool()]) {
        assert.equal((pool as unknown as { options: pg.PoolConfig }).options.max, 3);
      }
      assert.equal((uncapped.getPool() as unknown as { options: pg.PoolConfig }).options.max, 10, 'pg default');
    } finally {
      await capped.close();
      await uncapped.close();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('PG_POOL_MAX also caps the PrismaService pg pool (session-pooler budget, ADR 052)', async () => {
    const env = { ...base, PG_POOL_MAX: '3' };
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    const capped = new PrismaService();
    delete process.env.PG_POOL_MAX;
    const uncapped = new PrismaService();
    try {
      assert.equal((capped.getPool() as unknown as { options: pg.PoolConfig }).options.max, 3);
      assert.equal((uncapped.getPool() as unknown as { options: pg.PoolConfig }).options.max, 10, 'pg default');
    } finally {
      await capped.getPool().end();
      await uncapped.getPool().end();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('the documented session budget: hrvo_app opens at most L + 3P + 1 = 10 connections at Prisma 3 / pg 2 (ADR 052)', async () => {
    // The Supabase overlay's settings, without DATABASE_URL (the URL is built from PG*), no PGADMIN_* (the admin pool
    // falls back to hrvo_app) and a separate retention login.
    const env = { ...base, PRISMA_CONNECTION_LIMIT: '3', PG_POOL_MAX: '2', PGRETENTION_PASSWORD: 'r', DATABASE_URL: undefined, PGADMIN_USER: undefined, PGADMIN_PASSWORD: undefined };
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    const prisma = new PrismaService();
    const attendance = new PostgresAttendanceRepository();
    try {
      const engine = Number(new URL(databaseUrl(process.env)).searchParams.get('connection_limit'));
      const pools = [prisma.getPool(), attendance.getPool(), attendance.getAdminPool(), attendance.getRetentionPool()]
        .map((p) => (p as unknown as { options: pg.PoolConfig }).options);
      const asApp = pools.filter((o) => o.user === 'hrvo_app');
      const listener = 1; // the attendance gateway's one LISTEN client (PrismaService.createListenerClient)
      assert.equal(engine, 3);
      assert.equal(asApp.length, 3, 'Prisma pg pool, attendance app pool, admin pool falling back to hrvo_app');
      assert.deepEqual(asApp.map((o) => o.max), [2, 2, 2]);
      assert.equal(engine + asApp.reduce((n, o) => n + (o.max ?? 10), 0) + listener, 10, 'under the session pool of 15 per user');
      const retention = pools.find((o) => o.user === 'hrvo_retention');
      assert.equal(retention?.max, 2, 'the retention login has its own budget, capped too');
    } finally {
      await prisma.getPool().end();
      await attendance.close();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});
