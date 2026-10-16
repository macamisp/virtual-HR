/**
 * Database connection settings for AWS (ADR 020): the Prisma URL and the pg pool are built from
 * PG* variables (the password injected from Secrets Manager), with verified TLS to RDS.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databaseUrl, poolConfig } from '../src/common/db-config.ts';

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
});
