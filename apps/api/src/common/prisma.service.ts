import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { databaseUrl, poolConfig } from './db-config.ts';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private pool: pg.Pool;

  constructor() {
    // DATABASE_URL locally; on AWS built from PG* with verified TLS (db-config.ts, ADR 020).
    super({ datasources: { db: { url: databaseUrl() } } });
    this.pool = new pg.Pool(PrismaService.connectionConfig());
  }

  private static connectionConfig(): pg.ClientConfig {
    return poolConfig();
  }

  /** A dedicated (non-pooled) connection for LISTEN; the caller owns and ends it. */
  public createListenerClient(): pg.Client {
    return new pg.Client(PrismaService.connectionConfig());
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    await this.pool.end();
  }

  public getPool(): pg.Pool {
    return this.pool;
  }

  /**
   * Executes a database query inside a PostgreSQL transaction with tenant context
   * enforcing SET LOCAL app.org_id for strict Row-Level Security (RLS) isolation.
   */
  public async runWithTenantContext<T>(
    orgId: string,
    callback: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!orgId || orgId.trim() === '') {
      throw new Error('Tenant context missing: orgId is required for RLS');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
