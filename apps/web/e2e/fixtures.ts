import pg from 'pg';

export const PASSWORD = 'ComplexPassword123!';
export const ORG_ID = '66660000-0000-4000-8000-000000000001';
export const ORG_SLUG = 'web-e2e';
export const TEAM_ID = '66660000-0000-4000-8000-000000000101';

export const USERS = {
  hr: { id: '66660000-0000-4000-8000-000000000011', email: 'hr@web-e2e.test', name: 'Hana HR', role: 'HR' },
  lead: { id: '66660000-0000-4000-8000-000000000012', email: 'lead@web-e2e.test', name: 'Leo Lead', role: 'TEAM_LEAD' },
  worker: { id: '66660000-0000-4000-8000-000000000013', email: 'worker@web-e2e.test', name: 'Wendy Worker', role: 'EMPLOYEE' },
  sub: { id: '66660000-0000-4000-8000-000000000014', email: 'sub@web-e2e.test', name: 'Sam Subcontractor', role: 'SUBCONTRACTOR' },
} as const;

export function adminPool(): pg.Pool {
  return new pg.Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5433),
    database: process.env.PGDATABASE || 'hrvo_dev',
    user: process.env.PGADMIN_USER || 'postgres',
    password: process.env.PGADMIN_PASSWORD || 'postgres',
  });
}
