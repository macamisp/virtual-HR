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
import { databaseUrl, poolConfig } from '../src/common/db-config.ts';
import { PostgresAttendanceRepository } from '../src/attendance/attendance-repository.ts';

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
});
