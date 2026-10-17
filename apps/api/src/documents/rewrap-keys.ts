/**
 * Moves document keys wrapped by the local provider to AWS KMS (ADR 021). Only the wrapping
 * changes: data keys stay the same, so stored content needs no re-encryption. Each version's
 * wrapped keys (data, password, recovery escrow) move in one transaction, so kms_key_id never
 * points at a mix; document metadata keys likewise. Idempotent; audited per organisation.
 * Operator-run: `node dist/apps/api/src/documents/rewrap-cli.js --operator "<name>"`.
 */
import type pg from 'pg';
import { appendAuditEntry } from '../common/audit-chain.ts';
import type { PrismaService } from '../common/prisma.service.ts';
import type { CompositeKeyProvider } from './kms-key-provider.ts';

export interface RewrapResult { versions: number; documents: number; failed: number }

interface VersionRow { id: string; document_id: string; kms_key_id: string; dek_wrapped_kms: Buffer | null; dek_wrapped_pw: Buffer | null; dek_wrapped_recovery: Buffer | null; recovery_key_id: string | null }
interface DocRow { id: string; meta_key_wrapped: Buffer; meta_key_id: string }

const BATCH = 200;

/** The organisation's most senior active administrator stands in as the audit actor (the job is marked system). */
async function auditActor(db: pg.PoolClient): Promise<string | null> {
  const r = await db.query<{ id: string }>(
    `SELECT id FROM users WHERE status = 'ACTIVE' AND role IN ('SUPER_ADMIN', 'ADMIN', 'HR_MANAGER', 'HR')
     ORDER BY array_position(ARRAY['SUPER_ADMIN', 'ADMIN', 'HR_MANAGER', 'HR']::text[], role::text), created_at LIMIT 1`);
  return r.rows[0]?.id ?? null;
}

export async function rewrapDocumentKeys(
  prisma: PrismaService,
  keys: CompositeKeyProvider,
  opts: { orgIds?: string[]; operator?: string } = {},
): Promise<RewrapResult> {
  const orgIds = opts.orgIds ?? (await prisma.getPool().query<{ id: string }>(`SELECT id FROM fn_list_orgs_for_jobs()`)).rows.map((r) => r.id);
  const total: RewrapResult = { versions: 0, documents: 0, failed: 0 };
  for (const orgId of orgIds) {
    const moved = { versions: 0, documents: 0 };
    let ok = true;
    // Versions, one transaction each.
    for (;;) {
      const batch = await prisma.runWithTenantContext(orgId, (db) => db.query<{ id: string; kms_key_id: string }>(
        `SELECT id, kms_key_id FROM document_versions WHERE dek_wrapped_kms IS NOT NULL OR dek_wrapped_pw IS NOT NULL ORDER BY id`)).then((r) => r.rows.filter((x) => keys.isLegacy(x.kms_key_id)).slice(0, BATCH));
      if (!batch.length) break;
      let progressed = false;
      for (const { id } of batch) {
        try {
          await prisma.runWithTenantContext(orgId, async (db) => {
            const v = (await db.query<VersionRow>(`SELECT id, document_id, kms_key_id, dek_wrapped_kms, dek_wrapped_pw, dek_wrapped_recovery, recovery_key_id FROM document_versions WHERE id = $1 FOR UPDATE`, [id])).rows[0];
            if (!v || !keys.isLegacy(v.kms_key_id)) return;
            const ctx = { orgId, documentId: v.document_id };
            let keyId = v.kms_key_id;
            let data = v.dek_wrapped_kms;
            let pw = v.dek_wrapped_pw;
            let rec = v.dek_wrapped_recovery;
            let recId = v.recovery_key_id;
            if (data) { const w = await keys.wrap(await keys.unwrap(data, v.kms_key_id, ctx), ctx); data = w.wrapped; keyId = w.keyId; }
            if (pw) { const w = await keys.wrap(await keys.unwrap(pw, v.kms_key_id, { ...ctx, purpose: 'password' }), { ...ctx, purpose: 'password' }); pw = w.wrapped; keyId = w.keyId; }
            if (rec && recId && keys.isLegacy(recId)) { const w = await keys.wrap(await keys.unwrap(rec, recId, { ...ctx, purpose: 'recovery' }), { ...ctx, purpose: 'recovery' }); rec = w.wrapped; recId = w.keyId; }
            await db.query(`UPDATE document_versions SET dek_wrapped_kms = $2, dek_wrapped_pw = $3, dek_wrapped_recovery = $4, recovery_key_id = $5, kms_key_id = $6 WHERE id = $1`, [id, data, pw, rec, recId, keyId]);
            moved.versions += 1;
            progressed = true;
          });
        } catch (err) {
          ok = false;
          console.error(`rewrap: version ${id} in org ${orgId} failed:`, err instanceof Error ? err.message : 'unknown error');
        }
      }
      if (!progressed) break;
    }
    // Document metadata keys.
    const docs = await prisma.runWithTenantContext(orgId, (db) => db.query<DocRow>(`SELECT id, meta_key_wrapped, meta_key_id FROM documents WHERE meta_key_wrapped IS NOT NULL AND meta_key_id IS NOT NULL`)).then((r) => r.rows.filter((d) => keys.isLegacy(d.meta_key_id)));
    for (const d of docs) {
      try {
        await prisma.runWithTenantContext(orgId, async (db) => {
          const row = (await db.query<DocRow>(`SELECT id, meta_key_wrapped, meta_key_id FROM documents WHERE id = $1 FOR UPDATE`, [d.id])).rows[0];
          if (!row || !keys.isLegacy(row.meta_key_id)) return;
          const ctx = { orgId, documentId: row.id, purpose: 'metadata' as const };
          const w = await keys.wrap(await keys.unwrap(row.meta_key_wrapped, row.meta_key_id, ctx), ctx);
          await db.query(`UPDATE documents SET meta_key_wrapped = $2, meta_key_id = $3 WHERE id = $1`, [row.id, w.wrapped, w.keyId]);
          moved.documents += 1;
        });
      } catch (err) {
        ok = false;
        console.error(`rewrap: document ${d.id} in org ${orgId} failed:`, err instanceof Error ? err.message : 'unknown error');
      }
    }
    if (moved.versions || moved.documents) {
      const audited = await prisma.runWithTenantContext(orgId, async (db) => {
        const actor = await auditActor(db);
        if (!actor) return false;
        await appendAuditEntry(db, { orgId, actorId: actor, action: 'DOCUMENT_KEYS_REWRAPPED', entityType: 'ORGANIZATION', entityId: orgId,
          after: { ...moved, system: true, run: 'rewrap-keys', operator: opts.operator ?? null } });
        return true;
      });
      if (!audited) { ok = false; console.error(`rewrap: org ${orgId} has no active administrator to attribute the audit entry to`); }
    }
    total.versions += moved.versions;
    total.documents += moved.documents;
    if (!ok) total.failed += 1;
  }
  return total;
}
