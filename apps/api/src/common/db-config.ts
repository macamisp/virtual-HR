/**
 * Database connection settings (ADR 020). Locally DATABASE_URL and PG* defaults are used. On AWS
 * the password is injected from Secrets Manager as PGPASSWORD and PGSSLMODE=verify-full verifies
 * RDS's certificate against the CA bundle in PGSSLROOTCERT (shipped in the container image).
 */
import { readFileSync } from 'node:fs';
import type pg from 'pg';

type Env = Record<string, string | undefined>;
const tlsRequired = (env: Env) => env.PGSSLMODE === 'verify-full' || env.PGSSLMODE === 'require';

function caBundle(env: Env): string {
  if (!env.PGSSLROOTCERT) throw new Error('PGSSLMODE requires PGSSLROOTCERT (the RDS CA bundle)');
  return env.PGSSLROOTCERT;
}

export function poolConfig(env: Env = process.env): pg.ClientConfig {
  return {
    host: env.PGHOST || 'localhost',
    port: Number(env.PGPORT || 5433),
    database: env.PGDATABASE || 'hrvo_dev',
    user: env.PGUSER || 'hrvo_app',
    password: env.PGPASSWORD || 'hrvo_app_pass',
    // Always verify: a "require" without verification would accept any certificate.
    ...(tlsRequired(env) ? { ssl: { rejectUnauthorized: true, ca: readFileSync(caBundle(env), 'utf8') } } : {}),
  };
}

export function databaseUrl(env: Env = process.env): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const c = poolConfig(env);
  const url = new URL(`postgresql://${c.host}:${c.port}/${c.database}`);
  url.username = encodeURIComponent(String(c.user));
  url.password = encodeURIComponent(String(c.password));
  url.searchParams.set('schema', 'public');
  if (tlsRequired(env)) {
    url.searchParams.set('sslmode', 'require');
    url.searchParams.set('sslaccept', 'strict');
    url.searchParams.set('sslcert', caBundle(env));
  }
  return url.toString();
}
