import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { PermissionResolver } from '../common/permission-resolver.ts';
import { PostgresAttendanceRepository } from '../attendance/attendance-repository.ts';
import { DocumentMaintenanceService } from '../documents/document-maintenance.service.ts';
import { retentionBlocksDelete } from '../documents/vault-rules.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import type { AnonymisationCheck, Blocker, CreateAnonymisationDto, PrivacyRequest, Retained } from '../../../../packages/shared/src/privacy/types.ts';

interface RequestRow {
  id: string;
  type: 'EXPORT' | 'ANONYMISE';
  status: PrivacyRequest['status'];
  subject_id: string;
  subject_name: string | null;
  subject_email: string;
  requester_id: string;
  requester_name: string | null;
  requester_email: string;
  reason: string;
  blockers: Blocker[];
  result: Record<string, number> | null;
  created_at: Date;
  completed_at: Date | null;
}

const REQUEST_SELECT = `
  SELECT r.id, r.type, r.status, r.reason, r.blockers, r.result, r.created_at, r.completed_at,
         s.id AS subject_id, s.display_name AS subject_name, s.email AS subject_email,
         q.id AS requester_id, q.display_name AS requester_name, q.email AS requester_email
  FROM privacy_requests r JOIN users s ON s.id = r.subject_user_id JOIN users q ON q.id = r.requested_by`;

function mapRequest(r: RequestRow): PrivacyRequest {
  return {
    id: r.id, type: r.type, status: r.status, reason: r.reason, blockers: r.blockers ?? [], result: r.result,
    subject: { id: r.subject_id, displayName: r.subject_name, email: r.subject_email },
    requestedBy: { id: r.requester_id, displayName: r.requester_name, email: r.requester_email },
    createdAt: r.created_at.toISOString(), completedAt: r.completed_at?.toISOString() ?? null,
  };
}

/**
 * FR-AUD-003: the anonymisation workflow. HR (privacy.manage) requests it with a reason; the
 * system lists blockers (open obligations and legal holds) and what is retained on a legal
 * basis; once nothing blocks, HR confirms with the person's email and the data is removed or
 * replaced in one transaction, with raw events deleted by the retention role afterwards.
 * The user row stays as a pseudonymous key so audit, consent and financial records keep
 * their integrity; it can never sign in again.
 */
@Injectable()
export class AnonymisationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
    private readonly attendanceRepo: PostgresAttendanceRepository,
    private readonly documents: DocumentMaintenanceService,
  ) {}

  async list(actor: AuthenticatedUser): Promise<{ items: PrivacyRequest[] }> {
    return await this.prisma.runWithTenantContext(actor.orgId, async (db) => ({
      items: (await db.query<RequestRow>(`${REQUEST_SELECT} ORDER BY r.created_at DESC LIMIT 200`)).rows.map(mapRequest),
    }));
  }

  async check(actor: AuthenticatedUser, userId: string): Promise<AnonymisationCheck> {
    return await this.prisma.runWithTenantContext(actor.orgId, (db) => this.checkIn(db, actor, userId));
  }

  private async checkIn(db: pg.PoolClient, actor: AuthenticatedUser, userId: string, now: Date = new Date()): Promise<AnonymisationCheck> {
    const subject = (await db.query<{ id: string; display_name: string | null; email: string; role: string; status: string; anonymised_at: Date | null }>(
      `SELECT id, display_name, email, role, status, anonymised_at FROM users WHERE id = $1`, [userId],
    )).rows[0];
    if (!subject) throw new NotFoundException('User not found');
    if (subject.id === actor.id) throw new ForbiddenException('You cannot anonymise your own account');
    if (subject.role === 'SUPER_ADMIN') throw new ForbiddenException('Super admin accounts are managed by the platform operator');
    if (subject.anonymised_at) throw new ConflictException('This person has already been anonymised');

    const count = async (sql: string): Promise<number> => (await db.query<{ n: number }>(sql, [userId])).rows[0]!.n;
    const blockers: Blocker[] = [];
    const push = (kind: Blocker['kind'], count: number, detail: string) => { if (count > 0) blockers.push({ kind, count, detail }); };
    push('OPEN_ATTENDANCE_SESSION', await count(`SELECT count(*)::int AS n FROM attendance_sessions WHERE user_id = $1 AND status = 'OPEN'`), 'An attendance session is still open; it must be closed first.');
    push('PENDING_CORRECTION', await count(`SELECT count(*)::int AS n FROM attendance_corrections WHERE user_id = $1 AND status = 'PENDING'`), 'Correction requests are waiting for review.');
    push('SUBMITTED_TIMESHEET', await count(`SELECT count(*)::int AS n FROM timesheets WHERE user_id = $1 AND status = 'SUBMITTED'`), 'Timesheets are waiting for approval.');
    push('UNPAID_TIMESHEET', await count(`SELECT count(*)::int AS n FROM timesheets WHERE user_id = $1 AND status IN ('APPROVED', 'LOCKED') AND amount IS NOT NULL`), 'Approved timesheets with an amount have not been marked paid.');
    push('ACTIVE_CONTRACT', await count(`SELECT count(*)::int AS n FROM contracts WHERE user_id = $1 AND status = 'ACTIVE' AND (end_date IS NULL OR end_date >= current_date)`), 'A contract is still active; end or terminate it first.');
    push('LEGAL_HOLD', await count(`SELECT count(*)::int AS n FROM documents WHERE (owner_id = $1 OR linked_user_id = $1) AND legal_hold AND shredded_at IS NULL`), 'Documents of this person are under legal hold.');

    // Documents the person owns: shredded unless retention keeps them (then kept pseudonymously).
    const owned = await db.query<{ id: string; created_at: Date; min_years: number | null; linked_user_id: string | null }>(
      `SELECT d.id, d.created_at, r.min_years, d.linked_user_id FROM documents d LEFT JOIN document_retention_rules r ON r.org_id = d.org_id AND r.category = d.category
       WHERE d.owner_id = $1 AND d.shredded_at IS NULL AND NOT d.legal_hold`, [userId],
    );
    const shreddable = owned.rows.filter((d) => retentionBlocksDelete(d.created_at, d.min_years, now, false) === null && (d.linked_user_id === null || d.linked_user_id === userId));
    const retainedDocs = owned.rows.length - shreddable.length + await count(`SELECT count(*)::int AS n FROM documents WHERE linked_user_id = $1 AND owner_id <> $1 AND shredded_at IS NULL`);
    const retained: Retained[] = [
      { kind: 'RETAINED_DOCUMENTS', count: retainedDocs, detail: 'Documents within their retention period or filed by someone else stay, linked only to the pseudonymous id.' },
      { kind: 'AUDIT_LOG', count: await count(`SELECT count(*)::int AS n FROM audit_logs WHERE actor_id = $1`), detail: 'Audit entries are append-only and hash-chained; they keep the pseudonymous id, action and IP.' },
      { kind: 'CONSENT_RECORDS', count: await count(`SELECT count(*)::int AS n FROM monitoring_consents WHERE user_id = $1`), detail: 'Consent records are kept as evidence of the lawful basis for monitoring.' },
      { kind: 'FINANCIAL_RECORDS', count: await count(`SELECT count(*)::int AS n FROM timesheets WHERE user_id = $1 AND status IN ('APPROVED', 'LOCKED', 'PAID')`), detail: 'Approved timesheets and rates stay as pay records, under the pseudonymous id; free-text notes are removed.' },
    ];
    const willRemove: AnonymisationCheck['willRemove'] = [
      { dataset: 'Profile (name, email, password, 2FA, timezone)', count: 1, action: 'REPLACE' },
      { dataset: 'Sign-in sessions', count: await count(`SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1 AND NOT is_revoked`), action: 'REVOKE' },
      { dataset: 'Raw presence events', count: await count(`SELECT count(*)::int AS n FROM presence_events WHERE user_id = $1`), action: 'DELETE' },
      { dataset: 'Attendance session IPs and device ids', count: await count(`SELECT count(*)::int AS n FROM attendance_sessions WHERE user_id = $1`), action: 'REPLACE' },
      { dataset: 'Correction, timesheet and time-entry free text', count: await count(`SELECT count(*)::int AS n FROM time_entries WHERE user_id = $1 AND (note <> '' OR manual_reason IS NOT NULL)`), action: 'REPLACE' },
      { dataset: 'Task comments written by the person', count: await count(`SELECT count(*)::int AS n FROM task_comments WHERE author_id = $1`), action: 'REPLACE' },
      { dataset: 'Notifications and preferences', count: await count(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1`), action: 'DELETE' },
      { dataset: 'Daily and weekly plans, saved views, personal schedules', count: await count(`SELECT count(*)::int AS n FROM daily_plans WHERE user_id = $1`), action: 'DELETE' },
      { dataset: 'Own documents outside any retention period', count: shreddable.length, action: 'SHRED' },
    ];
    return {
      subject: { id: subject.id, displayName: subject.display_name, email: subject.email, role: subject.role, status: subject.status },
      blockers, retained, willRemove, canProceed: blockers.length === 0,
    };
  }

  async create(actor: AuthenticatedUser, dto: CreateAnonymisationDto): Promise<PrivacyRequest> {
    return await this.prisma.runWithTenantContext(actor.orgId, async (db) => {
      const check = await this.checkIn(db, actor, dto.userId);
      let id: string;
      try {
        id = (await db.query<{ id: string }>(
          `INSERT INTO privacy_requests (org_id, subject_user_id, type, status, requested_by, reason, blockers) VALUES ($1, $2, 'ANONYMISE', $3, $4, $5, $6) RETURNING id`,
          [actor.orgId, dto.userId, check.canProceed ? 'PENDING' : 'BLOCKED', actor.id, dto.reason, JSON.stringify(check.blockers)],
        )).rows[0]!.id;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new ConflictException('An anonymisation request for this person is already open');
        throw err;
      }
      await appendAuditEntry(db, { orgId: actor.orgId, actorId: actor.id, action: 'ANONYMISATION_REQUESTED', entityType: 'USER', entityId: dto.userId, after: { requestId: id, reason: dto.reason, blockers: check.blockers.map((b) => b.kind) } });
      return mapRequest((await db.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1`, [id])).rows[0]!);
    });
  }

  async cancel(actor: AuthenticatedUser, requestId: string): Promise<PrivacyRequest> {
    return await this.prisma.runWithTenantContext(actor.orgId, async (db) => {
      const res = await db.query<RequestRow>(`UPDATE privacy_requests SET status = 'CANCELLED', updated_at = now() WHERE id = $1 AND type = 'ANONYMISE' AND status IN ('PENDING', 'BLOCKED') RETURNING id`, [requestId]);
      if (res.rowCount === 0) throw new NotFoundException('No open anonymisation request with this id');
      const row = (await db.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1`, [requestId])).rows[0]!;
      await appendAuditEntry(db, { orgId: actor.orgId, actorId: actor.id, action: 'ANONYMISATION_CANCELLED', entityType: 'USER', entityId: row.subject_id, after: { requestId } });
      return mapRequest(row);
    });
  }

  /** Re-checks the blockers, then removes or replaces the data. Irreversible. */
  async execute(actor: AuthenticatedUser, requestId: string, confirmEmail: string): Promise<PrivacyRequest> {
    const now = new Date();
    const { subjectId, shred } = await this.prisma.runWithTenantContext(actor.orgId, async (db) => {
      const req = (await db.query<{ subject_user_id: string; status: string }>(`SELECT subject_user_id, status FROM privacy_requests WHERE id = $1 AND type = 'ANONYMISE' FOR UPDATE`, [requestId])).rows[0];
      if (!req) throw new NotFoundException('Anonymisation request not found');
      if (req.status !== 'PENDING' && req.status !== 'BLOCKED') throw new ConflictException(`This request is ${req.status.toLowerCase()}`);
      const userId = req.subject_user_id;
      const check = await this.checkIn(db, actor, userId, now);
      if (check.subject.email.toLowerCase() !== confirmEmail.toLowerCase()) throw new BadRequestException('The confirmation email does not match this person');
      if (!check.canProceed) {
        await db.query(`UPDATE privacy_requests SET status = 'BLOCKED', blockers = $2, updated_at = now() WHERE id = $1`, [requestId, JSON.stringify(check.blockers)]);
        throw new ConflictException(`Cannot anonymise yet: ${check.blockers.map((b) => b.detail).join(' ')}`);
      }
      await db.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId]);
      // Lets the time-entries lock guard accept free-text redaction on locked sheets (this transaction only).
      await db.query(`SELECT set_config('app.anonymising', 'on', true)`);
      const result: Record<string, number> = {};
      const run = async (key: string, sql: string, params: unknown[] = [userId]) => { result[key] = (await db.query(sql, params)).rowCount ?? 0; };

      // Identity: the row stays as a pseudonymous key, but nothing personal and no way to sign in.
      await run('profile', `UPDATE users SET email = 'anonymised-' || left(id::text, 8) || '@anonymised.invalid', display_name = 'Anonymised user', password_hash = NULL,
        mfa_enabled = false, mfa_secret = NULL, mfa_recovery_codes = '{}', failed_login_attempts = 0, locked_until = NULL, status = 'ANONYMISED', timezone = NULL,
        quiet_hours_start = NULL, quiet_hours_end = NULL, custom_role_id = NULL, manager_id = NULL, team_id = NULL, anonymised_at = $2 WHERE id = $1`, [userId, now]);
      await run('sessionsRevoked', `UPDATE auth_sessions SET is_revoked = true, revoked_reason = 'ANONYMISED', ip = NULL, user_agent = NULL, updated_at = now() WHERE user_id = $1 AND (NOT is_revoked OR revoked_reason IS NULL OR revoked_reason = 'ROTATED')`);
      await run('sessionMetadataCleared', `UPDATE auth_sessions SET ip = NULL, user_agent = NULL WHERE user_id = $1 AND (ip IS NOT NULL OR user_agent IS NOT NULL)`);
      await run('passwordResets', `UPDATE password_reset_tokens SET expires_at = now() WHERE user_id = $1 AND expires_at > now()`);
      await run('subordinatesUnlinked', `UPDATE users SET manager_id = NULL WHERE manager_id = $1`);
      await run('teamsUnled', `UPDATE teams SET lead_id = NULL WHERE lead_id = $1`);
      await run('projectsUnmanaged', `UPDATE projects SET manager_id = NULL WHERE manager_id = $1`);
      // Attendance: keep the facts (times, totals, statuses), drop the identifiers and free text.
      await run('attendanceSessions', `UPDATE attendance_sessions SET ip_in = '0.0.0.0', ip_out = NULL, device_id = 'anonymised' WHERE user_id = $1`);
      await run('corrections', `UPDATE attendance_corrections SET reason = '[removed: person anonymised]', review_note = CASE WHEN review_note IS NULL THEN NULL ELSE '[removed]' END WHERE user_id = $1`);
      await run('timeEntries', `UPDATE time_entries SET note = '', manual_reason = CASE WHEN manual_reason IS NULL THEN NULL ELSE '[removed]' END WHERE user_id = $1 AND (note <> '' OR manual_reason IS NOT NULL)`);
      await run('timesheetNotes', `UPDATE timesheets SET notes = '' WHERE user_id = $1 AND notes <> ''`);
      await run('taskComments', `UPDATE task_comments SET body = '[comment removed: author anonymised]' WHERE author_id = $1`);
      // Personal working data and access: gone.
      await run('dailyPlans', `DELETE FROM daily_plans WHERE user_id = $1`);
      await run('weeklyPlans', `DELETE FROM weekly_plans WHERE user_id = $1`);
      await run('savedViews', `DELETE FROM task_saved_views WHERE user_id = $1`);
      await run('schedules', `DELETE FROM work_schedules WHERE user_id = $1`);
      await run('subcontractorDetails', `DELETE FROM subcontractor_details WHERE user_id = $1`);
      await run('notificationPreferences', `DELETE FROM notification_preferences WHERE user_id = $1`);
      await run('documentGrants', `DELETE FROM document_acl WHERE principal_type = 'USER' AND principal_id = $1`);
      await run('deviceState', `DELETE FROM device_sequences WHERE user_id = $1`);
      await run('heartbeatNonces', `DELETE FROM heartbeat_nonces WHERE user_id = $1`);
      await run('invitations', `DELETE FROM invitations WHERE invited_by = $1 AND accepted_at IS NULL`);
      // Own documents outside any retention period are crypto-shredded after this transaction.
      const docs = (await db.query<{ id: string; created_at: Date; min_years: number | null; linked_user_id: string | null }>(
        `SELECT d.id, d.created_at, r.min_years, d.linked_user_id FROM documents d LEFT JOIN document_retention_rules r ON r.org_id = d.org_id AND r.category = d.category
         WHERE d.owner_id = $1 AND d.shredded_at IS NULL AND NOT d.legal_hold`, [userId],
      )).rows.filter((d) => retentionBlocksDelete(d.created_at, d.min_years, now, false) === null && (d.linked_user_id === null || d.linked_user_id === userId)).map((d) => d.id);
      result.documentsToShred = docs.length;
      await db.query(`UPDATE privacy_requests SET status = 'COMPLETED', blockers = '[]', result = $2, completed_at = now(), updated_at = now() WHERE id = $1`, [requestId, JSON.stringify(result)]);
      await appendAuditEntry(db, { orgId: actor.orgId, actorId: actor.id, action: 'USER_ANONYMISED', entityType: 'USER', entityId: userId, after: { requestId, ...result } });
      return { subjectId: userId, shred: docs };
    });
    // Outside the transaction: the retention role deletes append-only rows; documents are shredded one by one.
    const deleted = await this.attendanceRepo.deleteUserRetentionData(actor.orgId, subjectId);
    for (const id of shred) await this.documents.shred(actor.orgId, id, 'ANONYMISATION');
    this.resolver.invalidateOrg(actor.orgId);
    return await this.prisma.runWithTenantContext(actor.orgId, async (db) => {
      await db.query(`UPDATE privacy_requests SET result = COALESCE(result, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [requestId, JSON.stringify({ presenceEvents: deleted.presenceEvents, notifications: deleted.notifications, documentsShredded: shred.length })]);
      return mapRequest((await db.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1`, [requestId])).rows[0]!);
    });
  }
}
