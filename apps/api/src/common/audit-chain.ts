/**
 * Append one entry to the tamper-evident, hash-chained audit log (FR-AUD-001), inside the
 * caller's tenant transaction. Shared by auth, projects and tasks.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { lockTenantParents } from './lock-order.ts';
import { PostgresAttendanceRepository } from '../attendance/attendance-repository.ts';

export interface AuditEntry {
  orgId: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  userAgent?: string;
}

const GENESIS = '0'.repeat(64);

export async function appendAuditEntry(client: pg.PoolClient, entry: AuditEntry): Promise<void> {
  // ADR 038 lock order: parent rows (the organisation and the actor) before the per-org
  // advisory lock that serialises the hash chain, never the other way round.
  await lockTenantParents(client, entry.orgId, [entry.actorId]);
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('audit_logs:' || $1::text))`, [entry.orgId]);

  const lastRes = await client.query<{ hash: string }>(
    `SELECT hash FROM audit_logs WHERE org_id = $1 ORDER BY id DESC LIMIT 1`,
    [entry.orgId],
  );
  const prevHash = lastRes.rows[0]?.hash ?? GENESIS;

  const now = new Date();
  const beforeStr = PostgresAttendanceRepository.canonicalJson(entry.before);
  const afterStr = PostgresAttendanceRepository.canonicalJson(entry.after);
  const payloadToHash = `${prevHash}|${entry.orgId}|${entry.actorId}|${entry.action}|${entry.entityType}|${entry.entityId}|${beforeStr}|${afterStr}|${now.toISOString()}`;
  const hash = createHash('sha256').update(payloadToHash).digest('hex');

  await client.query(
    `INSERT INTO audit_logs (org_id, actor_id, action, entity_type, entity_id, before, after, ip, user_agent, prev_hash, hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      entry.orgId,
      entry.actorId,
      entry.action,
      entry.entityType,
      entry.entityId,
      beforeStr === '{}' ? null : beforeStr,
      afterStr === '{}' ? null : afterStr,
      entry.ip || null,
      entry.userAgent || null,
      prevHash,
      hash,
      now.toISOString(),
    ],
  );
}
