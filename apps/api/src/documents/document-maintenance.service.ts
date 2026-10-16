import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { NotificationsService } from '../notifications/notifications.service.ts';
import type { NewNotification } from '../notifications/notifications.service.ts';
import { localDate } from '../notifications/reminder-rules.ts';
import { addDaysIso } from '../planning/planning-rules.ts';
import { OBJECT_STORE } from './object-store.ts';
import type { ObjectStore } from './object-store.ts';
import { SCAN_DISPATCHER } from './scan-dispatcher.ts';
import type { ScanDispatcher } from './scan-dispatcher.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { logAccess } from './access-log.ts';
import { DocumentVault } from './document-vault.ts';
import { autoShredDue, trashExpired } from './vault-rules.ts';

export const EXPIRY_STAGES = [60, 30, 7] as const;

/** The tightest reminder stage that `daysLeft` has reached, or null (FR-DOC-015). */
export function expiryStage(daysLeft: number): (typeof EXPIRY_STAGES)[number] | null {
  if (daysLeft < 0) return null;
  if (daysLeft <= 7) return 7;
  if (daysLeft <= 30) return 30;
  if (daysLeft <= 60) return 60;
  return null;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Hourly document job. Idempotent: reminders are deduplicated per document, expiry date and
 * stage, so re-runs (or several API instances) never send twice, and a document added with
 * 5 days left gets only the 7-day reminder.
 */
@Injectable()
export class DocumentMaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(SCAN_DISPATCHER) private readonly scans: ScanDispatcher,
    private readonly vault: DocumentVault,
  ) {}

  private async orgs(): Promise<Array<{ id: string; timezone: string }>> {
    return (await this.prisma.getPool().query<{ id: string; timezone: string }>(`SELECT * FROM fn_list_orgs_with_documents()`)).rows;
  }

  async run(now: Date = new Date()): Promise<{ reminders: number; abandoned: number; rescanned: number; shredded: number; sealed: number }> {
    let reminders = 0;
    let abandoned = 0;
    let rescanned = 0;
    let shredded = 0;
    let sealed = 0;
    for (const org of await this.orgs()) {
      try {
        sealed += await this.sealLegacyTitles(org.id);
        shredded += await this.shredDue(org.id, now);
        reminders += await this.expiryReminders(org, now);
        reminders += await this.contractReminders(org, now);
        const h = await this.housekeeping(org.id, now);
        abandoned += h.abandoned;
        rescanned += h.rescanned;
      } catch (err) {
        console.error(`Document maintenance failed for org ${org.id}:`, err instanceof Error ? err.message : 'unknown error');
      }
    }
    return { reminders, abandoned, rescanned, shredded, sealed };
  }

  // ---------------------------------------------------------------- FR-DOC-017 crypto-shredding

  /**
   * Shreds what is due: trash older than 30 days, and documents past their category's
   * auto-shred age. A legal hold stops both.
   */
  async shredDue(orgId: string, now: Date): Promise<number> {
    const due = await this.prisma.runWithTenantContext(orgId, async (db) => {
      const res = await db.query<{ id: string; deleted_at: Date | null; created_at: Date; auto_shred_years: number | null; legal_hold: boolean }>(
        `SELECT d.id, d.deleted_at, d.created_at, r.auto_shred_years, d.legal_hold
         FROM documents d LEFT JOIN document_retention_rules r ON r.org_id = d.org_id AND r.category = d.category
         WHERE d.shredded_at IS NULL AND NOT d.legal_hold AND (d.deleted_at IS NOT NULL OR r.auto_shred_years IS NOT NULL)`,
      );
      return res.rows.filter((d) => trashExpired(d.deleted_at, now) || autoShredDue(d.created_at, d.auto_shred_years, now, d.legal_hold));
    });
    for (const d of due) await this.shred(orgId, d.id, d.deleted_at ? 'TRASH_EXPIRED' : 'RETENTION');
    return due.length;
  }

  /**
   * Crypto-shredding (SRS 10.1 step 6): every wrapped data key, escrow, sealed name and title
   * key is destroyed, so every copy of the ciphertext (bucket, replicas, backups) is unreadable;
   * the objects are deleted as well. The row stays as a tombstone for the audit trail.
   */
  async shred(orgId: string, documentId: string, reason: 'TRASH_EXPIRED' | 'RETENTION' | 'ANONYMISATION'): Promise<void> {
    const objects = await this.prisma.runWithTenantContext(orgId, async (db) => {
      const d = await db.query<{ legal_hold: boolean; shredded_at: Date | null }>(`SELECT legal_hold, shredded_at FROM documents WHERE id = $1 FOR UPDATE`, [documentId]);
      if (!d.rows[0] || d.rows[0].legal_hold || d.rows[0].shredded_at) return [];
      const keys = await db.query<{ k: string }>(
        `SELECT DISTINCT k FROM document_versions v, unnest(ARRAY[v.storage_key, v.staging_key]) k WHERE v.document_id = $1 AND k IS NOT NULL`,
        [documentId],
      );
      await db.query(
        `UPDATE document_versions SET dek_wrapped_kms = NULL, dek_wrapped_pw = NULL, pw_salt = NULL, pw_kdf_params = NULL, dek_wrapped_recovery = NULL,
           recovery_key_id = NULL, file_name_enc = NULL, upload_id = NULL WHERE document_id = $1`,
        [documentId],
      );
      await db.query(
        `UPDATE documents SET shredded_at = now(), deleted_at = COALESCE(deleted_at, now()), title = NULL, title_enc = NULL, meta_key_wrapped = NULL,
           meta_key_id = NULL, tags = '{}', current_version_id = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
        [documentId],
      );
      await db.query(`UPDATE document_share_links SET revoked_at = COALESCE(revoked_at, now()) WHERE document_id = $1`, [documentId]);
      await db.query(`DELETE FROM document_acl WHERE document_id = $1`, [documentId]);
      await db.query(`UPDATE contracts SET document_id = NULL, updated_at = now() WHERE document_id = $1`, [documentId]);
      await logAccess(db, { orgId, documentId, userId: null, action: 'SHRED', detail: { reason } });
      const owner = await db.query<{ owner_id: string }>(`SELECT owner_id FROM documents WHERE id = $1`, [documentId]);
      await appendAuditEntry(db, { orgId, actorId: owner.rows[0]!.owner_id, action: 'DOCUMENT_SHREDDED', entityType: 'DOCUMENT', entityId: documentId, after: { reason } });
      return keys.rows.map((r) => r.k);
    });
    // The keys are gone already; deleting the ciphertext is housekeeping (a failure is retried
    // by nobody and harms nobody: the bytes cannot be decrypted).
    for (const k of objects) await this.store.remove(k).catch(() => undefined);
  }

  /**
   * Confidential titles written before the vault (or by a direct database change) are sealed;
   * after this, documents_confidential_title_check can be validated.
   */
  async sealLegacyTitles(orgId: string): Promise<number> {
    return await this.prisma.runWithTenantContext(orgId, async (db) => {
      const rows = await db.query<{ id: string; title: string }>(
        `SELECT id, title FROM documents WHERE confidentiality <> 'NORMAL' AND title IS NOT NULL AND shredded_at IS NULL FOR UPDATE`,
      );
      for (const r of rows.rows) {
        const sealed = await this.vault.sealTitle(orgId, r.id, r.title);
        await db.query(`UPDATE documents SET title = NULL, title_enc = $2, meta_key_wrapped = $3, meta_key_id = $4 WHERE id = $1`, [r.id, sealed.titleEnc, sealed.metaKeyWrapped, sealed.metaKeyId]);
      }
      return rows.rows.length;
    });
  }

  /** FR-DOC-015: 60, 30 and 7 days before expiry, to the owner and HR. */
  async expiryReminders(org: { id: string; timezone: string }, now: Date): Promise<number> {
    const today = localDate(now, org.timezone);
    const created = await this.prisma.runWithTenantContext(org.id, async (db) => {
      // Confidential titles stay out of notifications (they are stored and emailed in clear).
      const docs = await db.query<{ id: string; title: string; owner_id: string; expires: string; category: string }>(
        `SELECT id, COALESCE(title, 'a confidential document') AS title, owner_id, to_char(expires_at, 'YYYY-MM-DD') AS expires, category FROM documents
         WHERE deleted_at IS NULL AND expires_at BETWEEN $1::date AND $2::date`,
        [today, addDaysIso(today, 60)],
      );
      if (docs.rows.length === 0) return [];
      const hr = await db.query<{ id: string }>(`SELECT id FROM users WHERE role IN ('HR', 'HR_MANAGER') AND status = 'ACTIVE'`);
      const items: NewNotification[] = [];
      for (const d of docs.rows) {
        const left = daysBetween(today, d.expires);
        const stage = expiryStage(left);
        if (!stage) continue;
        for (const userId of new Set([d.owner_id, ...hr.rows.map((r) => r.id)])) {
          items.push({
            userId, type: 'DOCUMENT_EXPIRING',
            title: left === 0 ? `Expires today: ${d.title}` : `Expires in ${left} day${left === 1 ? '' : 's'}: ${d.title}`,
            body: `“${d.title}” expires on ${d.expires}. Upload the renewed document as a new version, or update the expiry date.`,
            link: `/documents/${d.id}`, entityType: 'DOCUMENT', entityId: d.id,
            dedupeKey: `doc-expiry:${d.id}:${d.expires}:${stage}`, email: true,
          });
        }
      }
      return await this.notifications.create(db, org.id, items);
    });
    await this.notifications.deliver(org.id, created);
    return created.length;
  }

  /**
   * AC-16: a contract ending within its notice period (default 30 days) alerts HR and the
   * person's manager, in-app and by email, at the 60/30/7/0-day stages inside that period, once.
   */
  async contractReminders(org: { id: string; timezone: string }, now: Date): Promise<number> {
    const today = localDate(now, org.timezone);
    const created = await this.prisma.runWithTenantContext(org.id, async (db) => {
      const rows = await db.query<{ id: string; title: string; ends: string; notice: number; person: string; manager_id: string | null }>(
        `SELECT c.id, c.title, to_char(c.end_date, 'YYYY-MM-DD') AS ends, c.renewal_notice_days AS notice,
                COALESCE(u.display_name, u.email) AS person, u.manager_id
         FROM contracts c JOIN users u ON u.id = c.user_id
         WHERE c.status = 'ACTIVE' AND c.end_date BETWEEN $1::date AND $1::date + c.renewal_notice_days`,
        [today],
      );
      if (rows.rows.length === 0) return [];
      const hr = await db.query<{ id: string }>(`SELECT id FROM users WHERE role IN ('HR', 'HR_MANAGER') AND status = 'ACTIVE'`);
      const items: NewNotification[] = [];
      for (const c of rows.rows) {
        const left = daysBetween(today, c.ends);
        const stage = expiryStage(left);
        if (!stage || Number(stage) > c.notice) continue;
        for (const userId of new Set([...(c.manager_id ? [c.manager_id] : []), ...hr.rows.map((r) => r.id)])) {
          items.push({
            userId, type: 'CONTRACT_EXPIRING',
            title: left === 0 ? `Contract ends today: ${c.person}` : `Contract ends in ${left} day${left === 1 ? '' : 's'}: ${c.person}`,
            body: `“${c.title}” for ${c.person} ends on ${c.ends}. Renew it, or end the engagement and plan the hand-over.`,
            link: '/documents/contracts', entityType: 'CONTRACT', entityId: c.id,
            dedupeKey: `contract-expiry:${c.id}:${c.ends}:${stage}`, email: true,
          });
        }
      }
      return await this.notifications.create(db, org.id, items);
    });
    await this.notifications.deliver(org.id, created);
    return created.length;
  }

  /** Abandoned multipart uploads (> 24 h) are aborted; scans stuck PENDING (> 10 min) are retried. */
  async housekeeping(orgId: string, now: Date): Promise<{ abandoned: number; rescanned: number }> {
    const { stale, stuck } = await this.prisma.runWithTenantContext(orgId, async (db) => {
      const s = await db.query<{ id: string; staging_key: string; upload_id: string }>(
        `SELECT id, staging_key, upload_id FROM document_versions WHERE scan_status = 'UPLOADING' AND uploaded_at < $1`,
        [new Date(now.getTime() - 24 * 3_600_000)],
      );
      const p = await db.query<{ id: string }>(
        `SELECT id FROM document_versions WHERE scan_status = 'PENDING' AND completed_at < $1`,
        [new Date(now.getTime() - 10 * 60_000)],
      );
      return { stale: s.rows, stuck: p.rows };
    });
    for (const v of stale) {
      if (v.upload_id) await this.store.abortMultipart(v.staging_key, v.upload_id).catch(() => undefined);
      await this.prisma.runWithTenantContext(orgId, (db) =>
        db.query(`UPDATE document_versions SET scan_status = 'REJECTED', scan_detail = 'Upload abandoned', upload_id = NULL WHERE id = $1 AND scan_status = 'UPLOADING'`, [v.id]),
      );
    }
    for (const v of stuck) await this.scans.dispatchScan(orgId, v.id);
    return { abandoned: stale.length, rescanned: stuck.length };
  }
}
