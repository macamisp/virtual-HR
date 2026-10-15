import type pg from 'pg';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import type { AccessAction } from '../../../../packages/shared/src/documents/types.ts';

type Db = Pick<pg.PoolClient, 'query'>;

/** Writes one immutable access-log row (FR-DOC-012). The app role can only INSERT/SELECT. */
export async function logAccess(
  db: Db,
  e: { orgId: string; documentId: string | null; versionId?: string | null; userId: string | null; action: AccessAction; ctx?: RequestContext; detail?: Record<string, unknown> },
): Promise<void> {
  await db.query(
    `INSERT INTO document_access_logs (org_id, document_id, version_id, user_id, action, ip, user_agent, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [e.orgId, e.documentId, e.versionId ?? null, e.userId, e.action, e.ctx?.ip ?? null, e.ctx?.userAgent ?? null, e.detail ? JSON.stringify(e.detail) : null],
  );
}

