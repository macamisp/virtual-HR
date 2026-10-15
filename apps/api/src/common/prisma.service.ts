import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private pool: pg.Pool;

  constructor() {
    const defaultUrl =
      process.env.DATABASE_URL ||
      'postgresql://hrvo_app:hrvo_app_pass@localhost:5433/hrvo_dev?schema=public';
    super({
      datasources: {
        db: {
          url: defaultUrl,
        },
      },
    });
    this.pool = new pg.Pool({
      host: process.env.PGHOST || 'localhost',
      port: Number(process.env.PGPORT || 5433),
      database: process.env.PGDATABASE || 'hrvo_dev',
      user: process.env.PGUSER || 'hrvo_app',
      password: process.env.PGPASSWORD || 'hrvo_app_pass',
    });
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
