import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import type { ExportSection } from '../../../../packages/shared/src/privacy/types.ts';
import { buildZip } from './zip.ts';

const MAX_ROWS = 20_000;

/**
 * FR-AUD-002: everything the system holds about one person, as JSON per data set or as a ZIP
 * of those files. Document *content* is not included (confidential and password-protected
 * files need their own access path); the metadata and the person's access history are.
 * Confidential titles of other people's documents never appear.
 */
@Injectable()
export class DataExportService {
  constructor(private readonly prisma: PrismaService) {}

  async sections(db: pg.PoolClient, orgId: string, userId: string): Promise<Record<ExportSection, unknown>> {
    const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = [userId]): Promise<T[]> => (await db.query<T>(`${sql} LIMIT ${MAX_ROWS}`, params)).rows;
    const profile = (await db.query(
      `SELECT u.id, u.email, u.display_name, u.role, u.status, u.timezone, u.quiet_hours_start, u.quiet_hours_end, u.created_at, u.anonymised_at,
              t.name AS team, m.email AS manager_email, r.name AS custom_role, o.name AS organisation
       FROM users u LEFT JOIN teams t ON t.id = u.team_id LEFT JOIN users m ON m.id = u.manager_id LEFT JOIN org_roles r ON r.id = u.custom_role_id
       JOIN organizations o ON o.id = u.org_id WHERE u.id = $1`,
      [userId],
    )).rows[0];
    if (!profile) throw new NotFoundException('User not found');
    return {
      profile: {
        ...profile,
        subcontractorProfile: (await one(`SELECT rate_type, rate::text, currency, overtime_multiplier::text, weekly_hours_cap::text, updated_at FROM subcontractor_profiles WHERE user_id = $1`))[0] ?? null,
        contracts: await one(`SELECT id, title, scope, start_date, end_date, status, renewal_notice_days, created_at FROM contracts WHERE user_id = $1 ORDER BY start_date`),
        workSchedules: await one(`SELECT days, flexible, grace_minutes, effective_from, effective_to FROM work_schedules WHERE user_id = $1`),
      },
      consents: await one(`SELECT consent_type, granted, notice_version, accepted_at, ip, user_agent FROM monitoring_consents WHERE user_id = $1 ORDER BY accepted_at`),
      attendance: {
        sessions: await one(`SELECT id, work_date, clock_in_at, clock_out_at, clock_in_source, clock_out_source, active_seconds, idle_seconds, break_seconds, meeting_seconds, net_seconds, ip_in, ip_out, device_id, status, flags FROM attendance_sessions WHERE user_id = $1 ORDER BY clock_in_at`),
        dailySummaries: await one(`SELECT work_date, first_in, last_out, active_seconds, idle_seconds, break_seconds, net_seconds, expected_seconds, late_minutes, early_leave_minutes, overtime_minutes, day_status FROM attendance_daily WHERE user_id = $1 ORDER BY work_date`),
        corrections: await one(`SELECT id, requested_in, requested_out, reason, status, reviewed_at, review_note, created_at FROM attendance_corrections WHERE user_id = $1 ORDER BY created_at`),
        presenceEvents: await one(`SELECT server_ts, event_type, state, ip, meta FROM presence_events WHERE user_id = $1 ORDER BY server_ts DESC`),
      },
      timesheets: {
        timesheets: await one(`SELECT id, period_start, period_end, status, attendance_minutes, logged_minutes, billable_minutes, variance_minutes, amount::text, currency, notes, submitted_at, approved_at, rejected_at, rejection_reason FROM timesheets WHERE user_id = $1 ORDER BY period_start`),
        timeEntries: await one(`SELECT e.id, e.work_date, e.started_at, e.ended_at, e.minutes, e.source, e.billable, e.note, e.manual_reason, e.flagged, e.flag_reason, p.name AS project FROM time_entries e LEFT JOIN projects p ON p.id = e.project_id WHERE e.user_id = $1 ORDER BY e.work_date`),
      },
      tasks: {
        assigned: await one(`SELECT id, title, status, priority, due_date, planned_date, estimate_minutes, actual_minutes, completed_at, created_at FROM tasks WHERE assignee_id = $1 AND deleted_at IS NULL ORDER BY created_at`),
        reported: await one(`SELECT id, title, status, created_at FROM tasks WHERE reporter_id = $1 AND deleted_at IS NULL ORDER BY created_at`),
        comments: await one(`SELECT c.id, c.task_id, c.body, c.created_at FROM task_comments c WHERE c.author_id = $1 ORDER BY c.created_at`),
        dailyPlans: await one(`SELECT id, plan_date, created_at FROM daily_plans WHERE user_id = $1 ORDER BY plan_date`),
      },
      documents: {
        owned: await one(`SELECT id, CASE WHEN confidentiality = 'NORMAL' THEN title ELSE '(confidential)' END AS title, category, confidentiality, expires_at, created_at, deleted_at FROM documents WHERE owner_id = $1 ORDER BY created_at`),
        linkedToMe: await one(`SELECT id, CASE WHEN confidentiality = 'NORMAL' THEN title ELSE '(confidential)' END AS title, category, expires_at, created_at FROM documents WHERE linked_user_id = $1 AND owner_id <> $1 ORDER BY created_at`),
        myAccesses: await one(`SELECT document_id, action, ip, created_at FROM document_access_logs WHERE user_id = $1 ORDER BY created_at DESC`),
      },
      notifications: {
        notifications: await one(`SELECT type, title, body, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC`),
        preferences: await one(`SELECT type, in_app, email FROM notification_preferences WHERE user_id = $1`),
      },
      sessions: await one(`SELECT created_at, ip, user_agent, is_revoked, revoked_reason, expires_at FROM auth_sessions WHERE user_id = $1 ORDER BY created_at DESC`),
      audit: await one(`SELECT action, entity_type, entity_id, ip, created_at FROM audit_logs WHERE actor_id = $1 ORDER BY id DESC`),
    };
  }

  /** JSON object, or a ZIP with one file per section plus a manifest with SHA-256 hashes. */
  async export(actor: AuthenticatedUser, userId: string, format: 'json' | 'zip'): Promise<{ body: Buffer; contentType: string; filename: string }> {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return await this.prisma.runWithTenantContext(actor.orgId, async (db) => {
      const data = await this.sections(db, actor.orgId, userId);
      const subject = (data.profile as { email: string }).email;
      await db.query(`INSERT INTO privacy_requests (org_id, subject_user_id, type, status, requested_by, reason, result, completed_at) VALUES ($1, $2, 'EXPORT', 'COMPLETED', $3, $4, $5, now())`,
        [actor.orgId, userId, actor.id, actor.id === userId ? 'Self-service export' : 'Export by HR', JSON.stringify({ format: format === 'zip' ? 1 : 0 })]);
      await appendAuditEntry(db, { orgId: actor.orgId, actorId: actor.id, action: 'DATA_SUBJECT_EXPORTED', entityType: 'USER', entityId: userId, after: { format, self: actor.id === userId } });
      const base = `personal-data-${subject.replace(/[^a-z0-9]+/gi, '_')}-${stamp}`;
      if (format === 'json') {
        return { body: Buffer.from(JSON.stringify({ exportedAt: new Date().toISOString(), ...data }, null, 2), 'utf8'), contentType: 'application/json; charset=utf-8', filename: `${base}.json` };
      }
      const files = Object.entries(data).map(([name, value]) => ({ name: `${name}.json`, data: JSON.stringify(value, null, 2) }));
      const manifest = {
        exportedAt: new Date().toISOString(),
        subject,
        files: files.map((f) => ({ name: f.name, sha256: createHash('sha256').update(f.data).digest('hex'), bytes: Buffer.byteLength(f.data) })),
      };
      const readme = [
        `Personal data export for ${subject}`,
        `Generated ${manifest.exportedAt} by HR Virtual Office.`,
        '',
        'One JSON file per data set. manifest.json lists every file with its SHA-256.',
        'Document contents are not included; the documents.json file lists them and your access history.',
        'Times are UTC (ISO 8601).',
      ].join('\n');
      return { body: buildZip([{ name: 'README.txt', data: readme }, { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) }, ...files]), contentType: 'application/zip', filename: `${base}.zip` };
    });
  }
}
