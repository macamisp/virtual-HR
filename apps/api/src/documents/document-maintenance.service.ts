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
  ) {}

  private async orgs(): Promise<Array<{ id: string; timezone: string }>> {
    return (await this.prisma.getPool().query<{ id: string; timezone: string }>(`SELECT * FROM fn_list_orgs_with_documents()`)).rows;
  }

  async run(now: Date = new Date()): Promise<{ reminders: number; abandoned: number; rescanned: number }> {
    let reminders = 0;
    let abandoned = 0;
    let rescanned = 0;
    for (const org of await this.orgs()) {
      try {
        reminders += await this.expiryReminders(org, now);
        const h = await this.housekeeping(org.id, now);
        abandoned += h.abandoned;
        rescanned += h.rescanned;
      } catch (err) {
        console.error(`Document maintenance failed for org ${org.id}:`, err instanceof Error ? err.message : 'unknown error');
      }
    }
    return { reminders, abandoned, rescanned };
  }

  /** FR-DOC-015: 60, 30 and 7 days before expiry, to the owner and HR. */
  async expiryReminders(org: { id: string; timezone: string }, now: Date): Promise<number> {
    const today = localDate(now, org.timezone);
    const created = await this.prisma.runWithTenantContext(org.id, async (db) => {
      const docs = await db.query<{ id: string; title: string; owner_id: string; expires: string; category: string }>(
        `SELECT id, title, owner_id, to_char(expires_at, 'YYYY-MM-DD') AS expires, category FROM documents
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
