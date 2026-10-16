import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { toCsv } from '../common/export-format.ts';
import { PostgresAttendanceRepository } from '../attendance/attendance-repository.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import type { AuditQuery, AuditRow, AuditVerification } from '../../../../packages/shared/src/admin/types.ts';

const GENESIS = '0'.repeat(64);
const EXPORT_MAX = 10_000;
const VERIFY_BATCH = 1000;

interface ChainRow {
  id: string;
  org_id: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before: unknown;
  after: unknown;
  prev_hash: string;
  hash: string;
  created_at: Date;
}

/** FR-AUD-001 log, FR-ADM-006 viewer: filters, CSV export and chain verification. */
@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  private filters(q: Partial<AuditQuery>, params: unknown[]): string {
    const where: string[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.actorId) add('a.actor_id = ?', q.actorId);
    if (q.action) add('a.action = ?', q.action.toUpperCase());
    if (q.entityType) add('a.entity_type = ?', q.entityType.toUpperCase());
    if (q.entityId) add('a.entity_id = ?', q.entityId);
    if (q.from) add('a.created_at >= ?::timestamptz', q.from);
    if (q.to) add('a.created_at < ?::timestamptz', q.to);
    return where.length ? `WHERE ${where.join(' AND ')}` : '';
  }

  async getAuditLogs(orgId: string, q: Partial<AuditQuery> = {}): Promise<AuditRow[]> {
    return await this.prisma.runWithTenantContext(orgId, async (client) => {
      const params: unknown[] = [];
      const where = this.filters(q, params);
      params.push(q.limit ?? 50, q.offset ?? 0);
      const res = await client.query<AuditRow & { created_at: Date }>(
        `SELECT a.id::text, a.org_id, a.actor_id, u.display_name AS actor_name, a.action, a.entity_type, a.entity_id, a.before, a.after,
                a.ip, a.hash, a.created_at
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
         ${where}
         ORDER BY a.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return res.rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
    });
  }

  /** The distinct actions and entity types, for the filter menus. */
  async facets(orgId: string): Promise<{ actions: string[]; entityTypes: string[] }> {
    return await this.prisma.runWithTenantContext(orgId, async (db) => {
      const a = await db.query<{ v: string }>(`SELECT DISTINCT action AS v FROM audit_logs ORDER BY 1`);
      const e = await db.query<{ v: string }>(`SELECT DISTINCT entity_type AS v FROM audit_logs ORDER BY 1`);
      return { actions: a.rows.map((r) => r.v), entityTypes: e.rows.map((r) => r.v) };
    });
  }

  /** CSV of the filtered log (at most 10 000 rows); the export itself is audited. */
  async exportCsv(user: AuthenticatedUser, q: Partial<AuditQuery>): Promise<{ body: string; filename: string; rows: number }> {
    const rows = await this.getAuditLogs(user.orgId, { ...q, limit: EXPORT_MAX, offset: 0 });
    const body = toCsv(
      ['id', 'time_utc', 'actor_id', 'actor', 'action', 'entity_type', 'entity_id', 'ip', 'before', 'after', 'hash'],
      rows.map((r) => [r.id, r.created_at, r.actor_id, r.actor_name, r.action, r.entity_type, r.entity_id, r.ip,
        r.before === null ? null : JSON.stringify(r.before), r.after === null ? null : JSON.stringify(r.after), r.hash]),
    );
    await this.prisma.runWithTenantContext(user.orgId, (db) => appendAuditEntry(db, {
      orgId: user.orgId, actorId: user.id, action: 'AUDIT_LOG_EXPORTED', entityType: 'ORGANIZATION', entityId: user.orgId,
      after: { rows: rows.length, filters: { ...q, limit: undefined, offset: undefined } },
    }));
    return { body, filename: `audit-log-${new Date().toISOString().slice(0, 10)}.csv`, rows: rows.length };
  }

  /**
   * Recomputes every hash in order (FR-AUD-001). Reports the first entry that does not match,
   * so an auditor knows where the chain was broken.
   */
  async verify(orgId: string): Promise<AuditVerification> {
    return await this.prisma.runWithTenantContext(orgId, async (db) => {
      let expectedPrev = GENESIS;
      let lastId = '0';
      let checked = 0;
      for (;;) {
        const batch = await db.query<ChainRow>(
          // ORDER BY the table column: an output alias named "id" would sort the text, putting 100 before 59.
          `SELECT a.id::text, a.org_id, a.actor_id, a.action, a.entity_type, a.entity_id, a.before, a.after, a.prev_hash, a.hash, a.created_at
           FROM audit_logs a WHERE a.id > $1::bigint ORDER BY a.id LIMIT ${VERIFY_BATCH}`,
          [lastId],
        );
        for (const r of batch.rows) {
          const payload = `${r.prev_hash}|${r.org_id}|${r.actor_id}|${r.action}|${r.entity_type}|${r.entity_id}|${PostgresAttendanceRepository.canonicalJson(r.before)}|${PostgresAttendanceRepository.canonicalJson(r.after)}|${new Date(r.created_at).toISOString()}`;
          if (r.prev_hash !== expectedPrev || createHash('sha256').update(payload).digest('hex') !== r.hash) {
            return { valid: false, checked, brokenAtId: r.id };
          }
          expectedPrev = r.hash;
          checked += 1;
          lastId = r.id;
        }
        if (batch.rows.length < VERIFY_BATCH) return { valid: true, checked, brokenAtId: null };
      }
    });
  }
}
